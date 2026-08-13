import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ProviderBroker,
  type ProviderBrokerRequest,
  type ProviderBrokerResponse,
} from '../../src/provider/broker';

const temporaryDirectories: string[] = [];
const proxyPath = path.join(
  process.cwd(),
  'resources',
  'windows-sandbox',
  'MentalLegos.ProviderProxy.exe',
);
const execFileAsync = promisify(execFile);
const officialSandboxLauncher = process.env.MENTAL_LEGOS_PROVIDER_PROBE_SANDBOX_LAUNCHER;
const officialClientProbe = process.env.MENTAL_LEGOS_PROVIDER_PROBE_CLIENT;
const officialAppContainerProbe = officialSandboxLauncher && officialClientProbe ? it : it.skip;

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mental-legos-provider-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function* responseBody(...chunks: string[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield Buffer.from(chunk, 'utf8');
}

function invokeProxy(options: {
  port: number;
  token: string;
  requestPath: string;
  body: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: options.port,
      method: 'POST',
      path: options.requestPath,
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(options.body),
        'x-api-key': options.token,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.setTimeout(2_000, () => request.destroy(new Error('Provider proxy request timed out.')));
    request.end(options.body);
  });
}

function buildWindowsProbeEnvironment(temporaryDirectory: string): Record<string, string> {
  return {
    SYSTEMROOT: process.env.SYSTEMROOT ?? 'C:\\Windows',
    WINDIR: process.env.WINDIR ?? 'C:\\Windows',
    COMSPEC: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    PATH: process.env.PATH ?? 'C:\\Windows\\System32',
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? temporaryDirectory,
  };
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  await exited;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`)) {
      throw new Error('Refusing to clean a provider test path outside the temporary directory.');
    }
    await rm(resolved, { recursive: true, force: true });
  }));
});

describe.skipIf(process.platform !== 'win32')('provider credential boundary', () => {
  it('injects the real key only in the host broker and rejects unapproved API paths', async () => {
    const root = await createTemporaryDirectory();
    const workspaceRoot = path.join(root, 'workspace');
    const ipcDirectory = path.join(root, 'provider-ipc');
    await mkdir(workspaceRoot, { recursive: true });
    const actualCredential = 'synthetic-host-only-credential';
    const observed: ProviderBrokerRequest[] = [];
    const executor = async (
      invocation: ProviderBrokerRequest,
    ): Promise<ProviderBrokerResponse> => {
      observed.push(invocation);
      return {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-unapproved-response-header': 'must-not-cross-boundary',
        },
        body: responseBody('{"type":"message",', '"content":[]}'),
      };
    };
    const broker = new ProviderBroker({
      ipcDirectory,
      workspaceRoot,
      providerBaseUrl: 'https://provider.invalid/anthropic',
      providerApiKey: actualCredential,
      executor,
    });
    await broker.start();
    const child = spawn(proxyPath, [], {
      env: {
        ...broker.proxyEnvironment(),
        ...buildWindowsProbeEnvironment(root),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    try {
      const port = await broker.waitForProxy();
      const agentEnvironment = broker.agentEnvironment();
      expect(agentEnvironment.ANTHROPIC_API_KEY).not.toBe(actualCredential);
      expect(JSON.stringify(broker.proxyEnvironment())).not.toContain(actualCredential);

      const allowed = await invokeProxy({
        port,
        token: agentEnvironment.ANTHROPIC_API_KEY ?? '',
        requestPath: '/v1/messages',
        body: '{"model":"synthetic"}',
      });
      expect(allowed).toEqual({
        status: 200,
        body: '{"type":"message","content":[]}',
      });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        path: '/v1/messages',
        providerBaseUrl: 'https://provider.invalid/anthropic',
        providerApiKey: actualCredential,
      });
      expect(observed[0]?.headers).not.toHaveProperty('x-api-key');

      const denied = await invokeProxy({
        port,
        token: agentEnvironment.ANTHROPIC_API_KEY ?? '',
        requestPath: '/v1/complete',
        body: '{}',
      });
      expect(denied.status).toBe(403);
      expect(denied.body).toContain('not permitted');
      expect(observed).toHaveLength(1);

      const unauthenticated = await invokeProxy({
        port,
        token: '0'.repeat(64),
        requestPath: '/v1/messages',
        body: '{}',
      });
      expect(unauthenticated.status).toBe(401);
      expect(observed).toHaveLength(1);
    } finally {
      await stopProcess(child);
      await broker.close();
    }
  }, 20_000);

  officialAppContainerProbe(
    'allows only same-profile AppContainer traffic to reach the no-key proxy',
    async () => {
      if (!officialSandboxLauncher || !officialClientProbe) return;
      const root = await createTemporaryDirectory();
      const workspaceRoot = path.join(root, 'workspace');
      const ipcDirectory = path.join(root, 'provider-ipc');
      const stagedRuntime = path.join(workspaceRoot, '.runtime');
      const stagedProxy = path.join(stagedRuntime, 'provider-proxy.exe');
      const stagedClient = path.join(stagedRuntime, 'provider-client-probe.exe');
      await mkdir(stagedRuntime, { recursive: true });
      await Promise.all([
        copyFile(proxyPath, stagedProxy),
        copyFile(officialClientProbe, stagedClient),
      ]);
      const actualCredential = 'synthetic-host-only-credential';
      const observed: ProviderBrokerRequest[] = [];
      const broker = new ProviderBroker({
        ipcDirectory,
        workspaceRoot,
        providerBaseUrl: 'https://provider.invalid/anthropic',
        providerApiKey: actualCredential,
        executor: async (invocation) => {
          observed.push(invocation);
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: responseBody('same-container-provider-ok'),
          };
        },
      });
      const profile = `MentalLEGOs.ProviderTest.${process.pid}.${Date.now()}`;
      await broker.start();
      const server = spawn(officialSandboxLauncher, [
        'run',
        '--profile', profile,
        '--workspace', workspaceRoot,
        '--target', stagedProxy,
        '--writable', ipcDirectory,
      ], {
        env: {
          ...broker.proxyEnvironment(),
          ...buildWindowsProbeEnvironment(workspaceRoot),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let serverStderr = '';
      server.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        serverStderr += chunk;
      });

      try {
        let port: number;
        try {
          port = await broker.waitForProxy();
        } catch (reason) {
          throw new Error(
            `${reason instanceof Error ? reason.message : 'Provider proxy startup failed.'} ${serverStderr}`,
            { cause: reason },
          );
        }
        const token = broker.agentEnvironment().ANTHROPIC_API_KEY ?? '';
        await expect(invokeProxy({
          port,
          token,
          requestPath: '/v1/messages',
          body: '{"model":"synthetic"}',
        })).rejects.toThrow();
        expect(observed).toHaveLength(0);
        const client = await execFileAsync(officialSandboxLauncher, [
          'run',
          '--profile', profile,
          '--workspace', workspaceRoot,
          '--target', stagedClient,
          '--',
          String(port),
          token,
        ], {
          encoding: 'utf8',
          env: buildWindowsProbeEnvironment(workspaceRoot),
          windowsHide: true,
          timeout: 20_000,
        });
        expect(client.stdout.trim()).toBe('same-container-provider-ok');
        expect(observed).toHaveLength(1);
        expect(observed[0]?.providerApiKey).toBe(actualCredential);
      } finally {
        await stopProcess(server);
        await broker.close();
        await execFileAsync(officialSandboxLauncher, [
          'delete-profile',
          profile,
          workspaceRoot,
          ipcDirectory,
          stagedRuntime,
          stagedProxy,
          stagedClient,
        ], { windowsHide: true });
      }
    },
    30_000,
  );
});
