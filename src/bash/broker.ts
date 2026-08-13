import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

const requestNamePattern = /^(?<id>[0-9]+-[a-f0-9]{32})\.request$/u;
const maximumRequestBytes = 64 * 1024;
const maximumArgumentCount = 128;
const maximumOutputBytes = 8 * 1024 * 1024;

export interface BashRuntimePaths {
  runnerPath: string;
  bashWebcPath: string;
  coreutilsWebcPath: string;
  coreutilsManifestPath: string;
  coreutilsVersion: string;
  cacheDirectory: string;
  proxyPath: string;
}

export interface BashExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WasmerBashInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export type BashExecutor = (
  invocation: WasmerBashInvocation,
) => Promise<BashExecutionResult>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function replaceAllCaseInsensitive(value: string, from: string, to: string): string {
  return value.replace(new RegExp(escapeRegExp(from), 'giu'), to);
}

function assertOutsideRoot(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`${label} must remain outside the guest workspace mount.`);
  }
}

function assertWithinRoot(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside its managed root.`);
  }
}

function msysPathFor(windowsPath: string): string | undefined {
  const forward = windowsPath.replaceAll('\\', '/');
  if (!/^[a-zA-Z]:\//u.test(forward)) return undefined;
  return `/${forward[0]?.toLowerCase()}${forward.slice(2)}`;
}

export function sanitizeBashText(value: string, hostPaths: string[]): string {
  let sanitized = value;
  for (const hostPath of hostPaths) {
    if (!hostPath) continue;
    sanitized = replaceAllCaseInsensitive(sanitized, hostPath, '<sandbox-path>');
    sanitized = replaceAllCaseInsensitive(
      sanitized,
      hostPath.replaceAll('\\', '/'),
      '<sandbox-path>',
    );
    const msysPath = msysPathFor(hostPath);
    if (msysPath) {
      sanitized = replaceAllCaseInsensitive(sanitized, msysPath, '<sandbox-path>');
    }
  }
  return sanitized
    .replace(/[a-zA-Z]:\\Users\\[^\\\s'";]+/gu, '<user-home>')
    .replace(/\/[a-zA-Z]\/Users\/[^/\s'";]+/gu, '<user-home>');
}

export function translateBashArgument(argument: string, workspaceRoot: string): string {
  const forwardRoot = workspaceRoot.replaceAll('\\', '/');
  let translated = replaceAllCaseInsensitive(argument, workspaceRoot, '/workspace');
  translated = replaceAllCaseInsensitive(translated, forwardRoot, '/workspace');
  const msysRoot = msysPathFor(workspaceRoot);
  if (msysRoot) {
    translated = replaceAllCaseInsensitive(translated, msysRoot, '/workspace');
  }
  translated = translated.replace(
    /\/workspace(?:\\[a-zA-Z0-9._-]+)+/gu,
    (matched) => matched.replaceAll('\\', '/'),
  );
  translated = translated.replace(
    /(^|[\r\n;]\s*)export\s+PATH=(?:'[^']*'|"[^"]*"|[^\r\n;]*)/gu,
    "$1export PATH='/bin:/usr/bin'",
  );
  translated = translated
    .replace(
      /\/[a-zA-Z]\/Users\/[^/\s'";]+\/\.local\/bin\/claude\.exe/giu,
      '/workspace/.unavailable/claude.exe',
    )
    .replace(
      /[a-zA-Z]:\\Users\\[^\\\s'";]+\\\.local\\bin\\claude\.exe/giu,
      '/workspace/.unavailable/claude.exe',
    );
  return translated;
}

export function buildBashHostEnvironment(options: {
  cacheDirectory: string;
  temporaryDirectory: string;
  sourceEnvironment?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = options.sourceEnvironment ?? process.env;
  const environment: Record<string, string> = {
    WASMER_DIR: options.cacheDirectory,
    TEMP: options.temporaryDirectory,
    TMP: options.temporaryDirectory,
  };
  for (const key of ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'] as const) {
    if (source[key]) environment[key] = source[key];
  }
  return environment;
}

export function buildWasmerBashInvocation(options: {
  runtime: BashRuntimePaths;
  workspaceRoot: string;
  guestWorkspaceRoot: string;
  writableDirectories: {
    scratch: string;
    output: string;
    temporary: string;
  };
  temporaryDirectory: string;
  bashArguments: string[];
  registryUrl: string;
  sourceEnvironment?: NodeJS.ProcessEnv;
}): WasmerBashInvocation {
  return {
    command: options.runtime.runnerPath,
    args: [
      'run',
      '--quiet',
      '--registry', options.registryUrl,
      '--env', 'PATH=/bin:/usr/bin',
      '--env', 'HOME=/workspace',
      '--env', 'TEMP=/workspace/tmp',
      '--env', 'TMP=/workspace/tmp',
      '--env', 'MENTAL_LEGOS_BASH_SANDBOX=1',
      '--volume', `${options.guestWorkspaceRoot}:/workspace`,
      '--volume', `${options.writableDirectories.scratch}:/workspace/scratch`,
      '--volume', `${options.writableDirectories.output}:/workspace/output`,
      '--volume', `${options.writableDirectories.temporary}:/workspace/tmp`,
      '--cwd', '/workspace',
      '--include-webc', options.runtime.coreutilsWebcPath,
      options.runtime.bashWebcPath,
      '--',
      ...options.bashArguments.map((argument) => (
        translateBashArgument(argument, options.workspaceRoot)
      )),
    ],
    cwd: options.workspaceRoot,
    env: buildBashHostEnvironment({
      cacheDirectory: options.runtime.cacheDirectory,
      temporaryDirectory: options.temporaryDirectory,
      ...(options.sourceEnvironment === undefined
        ? {}
        : { sourceEnvironment: options.sourceEnvironment }),
    }),
  };
}

async function executeWasmerBash(
  invocation: WasmerBashInvocation,
): Promise<BashExecutionResult> {
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: 'output' | 'spawn' | 'timeout' | undefined;
    const timeout = setTimeout(() => {
      failure = 'timeout';
      child.kill();
    }, 120_000);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        failure = 'output';
        child.kill();
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', () => {
      failure = 'spawn';
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (failure === 'timeout') {
        resolve({ exitCode: 124, stdout: '', stderr: 'Sandboxed Bash timed out.\n' });
        return;
      }
      if (failure === 'output') {
        resolve({ exitCode: 125, stdout: '', stderr: 'Sandboxed Bash output limit exceeded.\n' });
        return;
      }
      if (failure === 'spawn') {
        resolve({ exitCode: 125, stdout: '', stderr: 'Sandboxed Bash could not start.\n' });
        return;
      }
      resolve({
        exitCode: Number.isInteger(code) ? code ?? 125 : 125,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function decodeBase64Line(value: string): string {
  if (
    value.length === 0
    || value.length % 4 !== 0
    || !/^[a-zA-Z0-9+/]*={0,2}$/u.test(value)
  ) {
    throw new Error('Invalid Bash proxy argument encoding.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('Non-canonical Bash proxy argument encoding.');
  }
  const result = decoded.toString('utf8');
  if (result.includes('\0')) throw new Error('Bash proxy argument contains a null byte.');
  return result;
}

function encodeResponse(result: BashExecutionResult): string {
  return [
    'MLR2',
    String(result.exitCode),
    Buffer.from(result.stdout, 'utf8').toString('base64'),
    Buffer.from(result.stderr, 'utf8').toString('base64'),
  ].join('\n');
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error('Local registry request exceeded its limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class LocalWasmerRegistry {
  readonly #coreutilsPath: string;
  readonly #coreutilsManifestPath: string;
  readonly #coreutilsVersion: string;
  #server: Server | undefined;
  #registryUrl: string | undefined;
  #artifactUrl: string | undefined;
  #manifest = '';
  #sha256 = '';
  #bytes = 0;

  constructor(options: {
    coreutilsPath: string;
    coreutilsManifestPath: string;
    coreutilsVersion: string;
  }) {
    this.#coreutilsPath = options.coreutilsPath;
    this.#coreutilsManifestPath = options.coreutilsManifestPath;
    this.#coreutilsVersion = options.coreutilsVersion;
  }

  async start(): Promise<string> {
    const [manifestSource, coreutilsMetadata] = await Promise.all([
      readFile(this.#coreutilsManifestPath, 'utf8'),
      lstat(this.#coreutilsPath),
    ]);
    if (!coreutilsMetadata.isFile() || coreutilsMetadata.isSymbolicLink()) {
      throw new Error('Local registry coreutils artifact is unsafe.');
    }
    this.#manifest = JSON.stringify(JSON.parse(manifestSource) as unknown);
    this.#bytes = coreutilsMetadata.size;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(this.#coreutilsPath)) hash.update(chunk);
    this.#sha256 = hash.digest('hex');

    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(400);
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once('error', reject);
      this.#server?.listen(0, '127.0.0.1', resolve);
    });
    const address = this.#server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Local Wasmer registry did not bind to loopback.');
    }
    this.#registryUrl = `http://127.0.0.1:${address.port}/graphql`;
    this.#artifactUrl = `http://127.0.0.1:${address.port}/coreutils.webc`;
    return this.#registryUrl;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/coreutils.webc') {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': this.#bytes,
        'content-type': 'application/octet-stream',
      });
      createReadStream(this.#coreutilsPath).pipe(response);
      return;
    }
    if (request.method !== 'POST' || request.url !== '/graphql') {
      response.writeHead(404).end();
      return;
    }
    const parsed = JSON.parse(await readRequestBody(request)) as { query?: unknown };
    if (
      typeof parsed.query !== 'string'
      || !/getPackage\(name:\s*"wasmer\/coreutils"\)/u.test(parsed.query)
      || !this.#artifactUrl
    ) {
      response.writeHead(400).end();
      return;
    }
    const body = JSON.stringify({
      data: {
        getPackage: {
          packageName: 'coreutils',
          namespace: 'wasmer',
          versions: [{
            version: this.#coreutilsVersion,
            isArchived: false,
            v2: {
              piritaDownloadUrl: null,
              piritaSha256Hash: null,
              webcManifest: null,
            },
            v3: {
              piritaDownloadUrl: this.#artifactUrl,
              piritaSha256Hash: this.#sha256,
              webcManifest: this.#manifest,
            },
          }],
        },
        info: { defaultFrontend: 'http://127.0.0.1/' },
      },
    });
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      'content-type': 'application/json',
    });
    response.end(body);
  }
}

export class WasmerBashBroker {
  readonly #ipcDirectory: string;
  readonly #workspaceRoot: string;
  readonly #temporaryDirectory: string;
  readonly #scratchDirectory: string;
  readonly #outputDirectory: string;
  readonly #guestRootDirectory: string;
  readonly #guestWorkspaceDirectory: string;
  readonly #runtime: BashRuntimePaths;
  readonly #executor: BashExecutor;
  readonly #registry: LocalWasmerRegistry;
  readonly #token = randomBytes(32).toString('hex');
  #activeRegistryUrl: string | undefined;
  #running = false;
  #loop: Promise<void> | undefined;

  constructor(options: {
    ipcDirectory: string;
    workspaceRoot: string;
    temporaryDirectory: string;
    scratchDirectory: string;
    outputDirectory: string;
    guestRootDirectory: string;
    runtime: BashRuntimePaths;
    executor?: BashExecutor;
  }) {
    this.#ipcDirectory = path.resolve(options.ipcDirectory);
    this.#workspaceRoot = path.resolve(options.workspaceRoot);
    this.#temporaryDirectory = path.resolve(options.temporaryDirectory);
    this.#scratchDirectory = path.resolve(options.scratchDirectory);
    this.#outputDirectory = path.resolve(options.outputDirectory);
    this.#guestRootDirectory = path.resolve(options.guestRootDirectory);
    this.#guestWorkspaceDirectory = path.join(
      this.#guestRootDirectory,
      `rootfs-${randomBytes(8).toString('hex')}`,
    );
    this.#runtime = options.runtime;
    assertOutsideRoot(this.#workspaceRoot, this.#ipcDirectory, 'Bash IPC directory');
    assertOutsideRoot(
      this.#workspaceRoot,
      this.#guestRootDirectory,
      'Bash guest root directory',
    );
    const sessionStorageRoot = path.dirname(this.#workspaceRoot);
    assertWithinRoot(sessionStorageRoot, this.#ipcDirectory, 'Bash IPC directory');
    assertWithinRoot(
      sessionStorageRoot,
      this.#guestRootDirectory,
      'Bash guest root directory',
    );
    for (const [label, directory] of [
      ['Bash scratch directory', this.#scratchDirectory],
      ['Bash output directory', this.#outputDirectory],
      ['Bash temporary directory', this.#temporaryDirectory],
    ] as const) {
      assertWithinRoot(this.#workspaceRoot, directory, label);
    }
    assertOutsideRoot(
      this.#workspaceRoot,
      options.runtime.cacheDirectory,
      'Wasmer cache directory',
    );
    this.#executor = options.executor ?? executeWasmerBash;
    this.#registry = new LocalWasmerRegistry({
      coreutilsPath: options.runtime.coreutilsWebcPath,
      coreutilsManifestPath: options.runtime.coreutilsManifestPath,
      coreutilsVersion: options.runtime.coreutilsVersion,
    });
  }

  agentEnvironment(): Record<string, string> {
    return {
      CLAUDE_CODE_GIT_BASH_PATH: this.#runtime.proxyPath,
      SHELL: this.#runtime.proxyPath,
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '0',
      MENTAL_LEGOS_BASH_IPC_DIR: this.#ipcDirectory,
      MENTAL_LEGOS_BASH_PROXY_TOKEN: this.#token,
    };
  }

  async start(): Promise<void> {
    if (this.#running) throw new Error('Bash broker is already running.');
    await Promise.all([
      assertRegularFile(this.#runtime.runnerPath, 'Wasmer runner'),
      assertRegularFile(this.#runtime.bashWebcPath, 'Bash WebC'),
      assertRegularFile(this.#runtime.coreutilsWebcPath, 'Coreutils WebC'),
      assertRegularFile(this.#runtime.coreutilsManifestPath, 'Coreutils manifest'),
      assertRegularFile(this.#runtime.proxyPath, 'Bash proxy'),
    ]);
    await Promise.all([
      mkdir(this.#runtime.cacheDirectory, { recursive: true }),
      mkdir(this.#scratchDirectory, { recursive: true }),
      mkdir(this.#outputDirectory, { recursive: true }),
      mkdir(this.#temporaryDirectory, { recursive: true }),
      mkdir(this.#ipcDirectory, { recursive: true }),
      mkdir(this.#guestRootDirectory, { recursive: true }),
    ]);
    const ipcMetadata = await lstat(this.#ipcDirectory);
    if (!ipcMetadata.isDirectory() || ipcMetadata.isSymbolicLink()) {
      throw new Error('Bash IPC directory is unsafe.');
    }
    const guestRootMetadata = await lstat(this.#guestRootDirectory);
    if (!guestRootMetadata.isDirectory() || guestRootMetadata.isSymbolicLink()) {
      throw new Error('Bash guest root directory is unsafe.');
    }
    const excludedRoots = new Set([
      'scratch',
      'output',
      'tmp',
      '.agent-config',
      '.runtime',
    ]);
    await cp(this.#workspaceRoot, this.#guestWorkspaceDirectory, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (source) => {
        const relative = path.relative(this.#workspaceRoot, source);
        if (!relative) return true;
        const topLevel = relative.split(path.sep)[0];
        return topLevel !== undefined && !excludedRoots.has(topLevel);
      },
    });
    await Promise.all([
      mkdir(path.join(this.#guestWorkspaceDirectory, 'scratch')),
      mkdir(path.join(this.#guestWorkspaceDirectory, 'output')),
      mkdir(path.join(this.#guestWorkspaceDirectory, 'tmp')),
    ]);
    try {
      this.#activeRegistryUrl = await this.#registry.start();
      this.#running = true;
      this.#loop = this.#runLoop();
    } catch (reason) {
      await this.#registry.close();
      throw reason;
    }
  }

  async close(): Promise<void> {
    this.#running = false;
    await this.#loop;
    this.#loop = undefined;
    await this.#registry.close();
    await rm(this.#guestWorkspaceDirectory, { recursive: true, force: true });
    this.#activeRegistryUrl = undefined;
  }

  async #runLoop(): Promise<void> {
    while (this.#running) {
      const entries = await readdir(this.#ipcDirectory, { withFileTypes: true });
      const requests = entries
        .filter((entry) => entry.isFile() && requestNamePattern.test(entry.name))
        .map((entry) => entry.name)
        .slice(0, 32);
      if (requests.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        continue;
      }
      for (const requestName of requests) {
        await this.#processRequest(requestName);
      }
    }
  }

  async #processRequest(requestName: string): Promise<void> {
    const match = requestName.match(requestNamePattern);
    const requestId = match?.groups?.id;
    if (!requestId) return;
    const requestPath = path.join(this.#ipcDirectory, requestName);
    const processingPath = `${requestPath}.processing`;
    try {
      await rename(requestPath, processingPath);
    } catch {
      return;
    }

    let result: BashExecutionResult;
    try {
      const metadata = await lstat(processingPath);
      if (
        !metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.size > maximumRequestBytes
      ) {
        throw new Error('Bash proxy request is unsafe.');
      }
      const lines = (await readFile(processingPath, 'utf8')).split(/\r?\n/u);
      if (lines.at(-1) === '') lines.pop();
      const protocol = lines.shift();
      const token = lines.shift();
      if (
        protocol !== 'MLB2'
        || token !== this.#token
        || lines.length > maximumArgumentCount
      ) {
        throw new Error('Bash proxy request authentication failed.');
      }
      const bashArguments = lines.map(decodeBase64Line);
      const invocation = buildWasmerBashInvocation({
        runtime: this.#runtime,
        workspaceRoot: this.#workspaceRoot,
        guestWorkspaceRoot: this.#guestWorkspaceDirectory,
        writableDirectories: {
          scratch: this.#scratchDirectory,
          output: this.#outputDirectory,
          temporary: this.#temporaryDirectory,
        },
        temporaryDirectory: this.#temporaryDirectory,
        bashArguments,
        registryUrl: this.#registryUrl(),
      });
      const execution = await this.#executor(invocation);
      result = {
        exitCode: execution.exitCode,
        stdout: sanitizeBashText(execution.stdout, [
          this.#workspaceRoot,
          this.#runtime.cacheDirectory,
          path.dirname(this.#runtime.runnerPath),
          this.#guestWorkspaceDirectory,
        ]),
        stderr: sanitizeBashText(execution.stderr, [
          this.#workspaceRoot,
          this.#runtime.cacheDirectory,
          path.dirname(this.#runtime.runnerPath),
          this.#guestWorkspaceDirectory,
        ]),
      };
    } catch {
      result = {
        exitCode: 125,
        stdout: '',
        stderr: 'Mental LEGOs rejected an invalid Bash broker request.\n',
      };
    }

    const temporaryResponse = path.join(this.#ipcDirectory, `${requestId}.response.tmp`);
    const responsePath = path.join(this.#ipcDirectory, `${requestId}.response`);
    try {
      await writeFile(temporaryResponse, encodeResponse(result), {
        encoding: 'utf8',
        flag: 'wx',
      });
      await rename(temporaryResponse, responsePath);
    } finally {
      await unlink(processingPath).catch(() => undefined);
      await rm(temporaryResponse, { force: true });
    }
  }

  #registryUrl(): string {
    if (!this.#activeRegistryUrl) throw new Error('Local Wasmer registry is unavailable.');
    return this.#activeRegistryUrl;
  }
}
