import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { isIPv4, isIPv6 } from 'node:net';
import path from 'node:path';

const requestNamePattern = /^(?<id>[0-9]+-[a-f0-9]{32})\.request$/u;
const maximumRequestBytes = 34 * 1024 * 1024;
const maximumRequestBodyBytes = 32 * 1024 * 1024;
const maximumResponseBytes = 32 * 1024 * 1024;
const maximumHeaders = 32;
const permittedPaths = new Set([
  '/v1/messages',
  '/v1/messages?beta=true',
  '/v1/messages/count_tokens',
  '/v1/messages/count_tokens?beta=true',
]);
const forwardedRequestHeaders = new Set([
  'accept',
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'user-agent',
  'x-app',
]);
const forwardedResponseHeaders = new Set([
  'content-type',
  'request-id',
  'retry-after',
  'x-request-id',
  'anthropic-organization-id',
]);

export interface ProviderBrokerRequest {
  method: 'POST';
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  providerBaseUrl: string;
  providerApiKey: string;
}

export interface ProviderBrokerResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}

export type ProviderExecutor = (
  request: ProviderBrokerRequest,
  signal: AbortSignal,
) => Promise<ProviderBrokerResponse>;

interface ParsedProviderRequest {
  method: 'POST';
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

function assertOutsideRoot(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`${label} must remain outside the Agent workspace.`);
  }
}

function assertWithinRoot(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside its managed session root.`);
  }
}

function decodeBase64(value: string, label: string): string {
  if (!value || value.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error(`Invalid ${label} encoding.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error(`Non-canonical ${label} encoding.`);
  const text = decoded.toString('utf8');
  if (text.includes('\0')) throw new Error(`${label} contains a null byte.`);
  return text;
}

function readLine(content: Buffer, cursor: { position: number }): string {
  const newline = content.indexOf(0x0a, cursor.position);
  if (newline < 0) throw new Error('Provider broker request is truncated.');
  const line = content.subarray(cursor.position, newline).toString('utf8');
  cursor.position = newline + 1;
  return line;
}

function safeTokenMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'ascii');
  const right = Buffer.from(expected, 'ascii');
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseProviderRequest(content: Buffer, expectedToken: string): ParsedProviderRequest {
  const cursor = { position: 0 };
  if (readLine(content, cursor) !== 'MLP1') throw new Error('Provider request marker is invalid.');
  if (!safeTokenMatches(readLine(content, cursor), expectedToken)) {
    throw new Error('Provider request authentication failed.');
  }
  const method = decodeBase64(readLine(content, cursor), 'provider method');
  if (method !== 'POST') throw new Error('Provider request method is not permitted.');
  const requestPath = decodeBase64(readLine(content, cursor), 'provider path');
  const headerCount = Number(readLine(content, cursor));
  if (!Number.isInteger(headerCount) || headerCount < 0 || headerCount > maximumHeaders) {
    throw new Error('Provider request header count is invalid.');
  }
  const headers: Record<string, string> = {};
  for (let index = 0; index < headerCount; index += 1) {
    const fields = readLine(content, cursor).split('\t');
    if (fields.length !== 2) throw new Error('Provider request header is malformed.');
    const name = decodeBase64(fields[0] ?? '', 'provider header name').toLowerCase();
    const value = decodeBase64(fields[1] ?? '', 'provider header value');
    if (
      !/^[a-z0-9-]+$/u.test(name)
      || value.includes('\r')
      || value.includes('\n')
      || headers[name] !== undefined
      || !forwardedRequestHeaders.has(name)
    ) {
      throw new Error('Provider request header is not permitted.');
    }
    headers[name] = value;
  }
  const bodyBytes = Number(readLine(content, cursor));
  if (!Number.isInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > maximumRequestBodyBytes) {
    throw new Error('Provider request body size is invalid.');
  }
  const body = content.subarray(cursor.position);
  if (body.length !== bodyBytes) throw new Error('Provider request body length does not match.');
  return { method: 'POST', path: requestPath, headers, body };
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  return !(
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 88)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && parts[2] === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && parts[2] === 100)
    || (a === 203 && b === 0 && parts[2] === 113)
    || a >= 224
  );
}

function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) return isPublicIpv4(address);
  if (!isIPv6(address)) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    return isPublicIpv4(normalized.slice('::ffff:'.length));
  }
  return !(
    normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/u.test(normalized)
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:')
    || normalized.startsWith('2001:10:')
  );
}

function buildProviderTarget(baseUrl: string, requestPath: string): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('Provider Base URL is unsafe.');
  }
  const requested = new URL(requestPath, 'https://provider-request.invalid');
  if (requested.origin !== 'https://provider-request.invalid' || requested.hash) {
    throw new Error('Provider request URL is unsafe.');
  }
  if (
    requestPath !== `${requested.pathname}${requested.search}`
    || !permittedPaths.has(requestPath)
  ) {
    throw new Error('Provider request path is not permitted.');
  }
  const basePath = base.pathname.replace(/\/+$/u, '');
  base.pathname = `${basePath}${requested.pathname}`;
  base.search = requested.search;
  return base;
}

async function executeProviderRequest(
  invocation: ProviderBrokerRequest,
  signal: AbortSignal,
): Promise<ProviderBrokerResponse> {
  const target = buildProviderTarget(invocation.providerBaseUrl, invocation.path);
  const addresses = await lookup(target.hostname, { all: true, verbatim: true });
  const selected = addresses.find((entry) => isPublicAddress(entry.address));
  if (!selected || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error('Provider hostname resolved to a non-public address.');
  }

  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: 'https:',
      hostname: target.hostname,
      port: target.port || 443,
      method: invocation.method,
      path: target.pathname,
      headers: {
        ...invocation.headers,
        host: target.host,
        'content-length': invocation.body.length,
        'x-api-key': invocation.providerApiKey,
      },
      lookup: (_hostname, _options, callback) => {
        callback(null, selected.address, selected.family);
      },
      signal,
    }, (response) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (!forwardedResponseHeaders.has(name) || value === undefined) continue;
        headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      resolve({
        status: response.statusCode ?? 502,
        headers,
        body: response,
      });
    });
    request.once('error', reject);
    request.setTimeout(120_000, () => request.destroy(new Error('Provider request timed out.')));
    request.end(invocation.body);
  });
}

function encodeHeaderLine(name: string, value: string): string {
  return `${Buffer.from(name, 'utf8').toString('base64')}\t${Buffer.from(value, 'utf8').toString('base64')}`;
}

async function writeResponse(options: {
  ipcDirectory: string;
  ipcToken: string;
  requestId: string;
  response: ProviderBrokerResponse;
}): Promise<void> {
  const bodyPath = path.join(options.ipcDirectory, `${options.requestId}.response.body`);
  const headTemporary = path.join(options.ipcDirectory, `${options.requestId}.response.head.tmp`);
  const headPath = path.join(options.ipcDirectory, `${options.requestId}.response.head`);
  const doneTemporary = path.join(options.ipcDirectory, `${options.requestId}.response.done.tmp`);
  const donePath = path.join(options.ipcDirectory, `${options.requestId}.response.done`);
  const headers = Object.entries(options.response.headers)
    .filter(([name, value]) => (
      forwardedResponseHeaders.has(name.toLowerCase())
      && !value.includes('\r')
      && !value.includes('\n')
    ))
    .slice(0, maximumHeaders);
  const body = await open(bodyPath, 'wx');
  let bytes = 0;
  let responseStarted = false;
  try {
    await writeFile(headTemporary, [
      'MLPR1',
      options.ipcToken,
      String(options.response.status),
      String(headers.length),
      ...headers.map(([name, value]) => encodeHeaderLine(name, value)),
    ].join('\n'), { encoding: 'utf8', flag: 'wx' });
    await rename(headTemporary, headPath);
    responseStarted = true;
    for await (const chunk of options.response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maximumResponseBytes) throw new Error('Provider response exceeded its limit.');
      await body.write(buffer);
      await body.sync();
    }
    await body.close();
    await writeFile(doneTemporary, `OK\n${bytes}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(doneTemporary, donePath);
  } catch (reason) {
    await body.close().catch(() => undefined);
    if (responseStarted) {
      await writeFile(doneTemporary, 'ERROR\n', { encoding: 'utf8', flag: 'wx' }).catch(() => undefined);
      await rename(doneTemporary, donePath).catch(() => undefined);
    }
    throw reason;
  }
}

async function* singleBody(content: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(content, 'utf8');
}

function brokerErrorResponse(status: number): ProviderBrokerResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: singleBody(JSON.stringify({
      type: 'error',
      error: {
        type: 'broker_error',
        message: status === 403
          ? 'Provider request path is not permitted.'
          : 'Provider request failed.',
      },
    })),
  };
}

export class ProviderBroker {
  readonly #ipcDirectory: string;
  readonly #workspaceRoot: string;
  readonly #providerBaseUrl: string;
  readonly #providerApiKey: string;
  readonly #ipcToken = randomBytes(32).toString('hex');
  readonly #requestToken = randomBytes(32).toString('hex');
  readonly #executor: ProviderExecutor;
  readonly #activeRequests = new Set<AbortController>();
  #running = false;
  #loop: Promise<void> | undefined;
  #port: number | undefined;

  constructor(options: {
    ipcDirectory: string;
    workspaceRoot: string;
    providerBaseUrl: string;
    providerApiKey: string;
    executor?: ProviderExecutor;
  }) {
    this.#ipcDirectory = path.resolve(options.ipcDirectory);
    this.#workspaceRoot = path.resolve(options.workspaceRoot);
    this.#providerBaseUrl = options.providerBaseUrl;
    this.#providerApiKey = options.providerApiKey;
    if (!this.#providerApiKey) throw new Error('Provider API key cannot be empty.');
    assertOutsideRoot(this.#workspaceRoot, this.#ipcDirectory, 'Provider IPC directory');
    assertWithinRoot(
      path.dirname(this.#workspaceRoot),
      this.#ipcDirectory,
      'Provider IPC directory',
    );
    buildProviderTarget(this.#providerBaseUrl, '/v1/messages');
    this.#executor = options.executor ?? executeProviderRequest;
  }

  proxyEnvironment(): Record<string, string> {
    return {
      MENTAL_LEGOS_PROVIDER_IPC_DIR: this.#ipcDirectory,
      MENTAL_LEGOS_PROVIDER_IPC_TOKEN: this.#ipcToken,
      MENTAL_LEGOS_PROVIDER_REQUEST_TOKEN: this.#requestToken,
    };
  }

  agentEnvironment(): Record<string, string> {
    if (this.#port === undefined) throw new Error('Provider proxy is not ready.');
    return {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${this.#port}`,
      ANTHROPIC_API_KEY: this.#requestToken,
      NO_PROXY: '127.0.0.1,localhost',
    };
  }

  async start(): Promise<void> {
    if (this.#running) throw new Error('Provider broker is already running.');
    await mkdir(this.#ipcDirectory, { recursive: true });
    const metadata = await lstat(this.#ipcDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Provider IPC directory is unsafe.');
    }
    await unlink(path.join(this.#ipcDirectory, '.ready')).catch((reason: NodeJS.ErrnoException) => {
      if (reason.code !== 'ENOENT') throw reason;
    });
    this.#running = true;
    this.#loop = this.#runLoop();
  }

  async waitForProxy(timeoutMs = 10_000): Promise<number> {
    if (!this.#running) throw new Error('Provider broker is not running.');
    const readyPath = path.join(this.#ipcDirectory, '.ready');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const metadata = await lstat(readyPath);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16) {
          throw new Error('Provider proxy readiness marker is unsafe.');
        }
        const port = Number((await readFile(readyPath, 'utf8')).trim());
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          throw new Error('Provider proxy published an invalid port.');
        }
        this.#port = port;
        return port;
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Provider proxy did not become ready.');
  }

  async close(): Promise<void> {
    this.#running = false;
    for (const controller of this.#activeRequests) controller.abort();
    await this.#loop;
    this.#loop = undefined;
    this.#port = undefined;
  }

  async #runLoop(): Promise<void> {
    while (this.#running) {
      const entries = await readdir(this.#ipcDirectory, { withFileTypes: true });
      const requests = entries
        .filter((entry) => entry.isFile() && requestNamePattern.test(entry.name))
        .map((entry) => entry.name)
        .slice(0, 8);
      if (requests.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        continue;
      }
      await Promise.all(requests.map((requestName) => this.#processRequest(requestName)));
    }
  }

  async #processRequest(requestName: string): Promise<void> {
    const match = requestNamePattern.exec(requestName);
    const requestId = match?.groups?.id;
    if (!requestId) return;
    const requestPath = path.join(this.#ipcDirectory, requestName);
    const processingPath = path.join(this.#ipcDirectory, `${requestId}.processing`);
    try {
      await rename(requestPath, processingPath);
    } catch {
      return;
    }

    const controller = new AbortController();
    this.#activeRequests.add(controller);
    try {
      const metadata = await lstat(processingPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumRequestBytes) {
        throw new Error('Provider request file is unsafe.');
      }
      const parsed = parseProviderRequest(await readFile(processingPath), this.#ipcToken);
      let response: ProviderBrokerResponse;
      try {
        buildProviderTarget(this.#providerBaseUrl, parsed.path);
        response = await this.#executor({
          ...parsed,
          providerBaseUrl: this.#providerBaseUrl,
          providerApiKey: this.#providerApiKey,
        }, controller.signal);
      } catch (reason) {
        response = brokerErrorResponse(
          reason instanceof Error && reason.message === 'Provider request path is not permitted.'
            ? 403
            : 502,
        );
      }
      await writeResponse({
        ipcDirectory: this.#ipcDirectory,
        ipcToken: this.#ipcToken,
        requestId,
        response,
      });
    } catch {
      await writeResponse({
        ipcDirectory: this.#ipcDirectory,
        ipcToken: this.#ipcToken,
        requestId,
        response: brokerErrorResponse(502),
      }).catch(() => undefined);
    } finally {
      this.#activeRequests.delete(controller);
      await unlink(processingPath).catch(() => undefined);
    }
  }
}
