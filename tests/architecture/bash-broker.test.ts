import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildBashHostEnvironment,
  buildWasmerBashInvocation,
  sanitizeBashText,
  translateBashArgument,
  WasmerBashBroker,
  type BashRuntimePaths,
  type WasmerBashInvocation,
} from '../../src/bash/broker';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const officialRunnerPath = process.env.MENTAL_LEGOS_BASH_PROBE_RUNNER;
const officialBashWebcPath = process.env.MENTAL_LEGOS_BASH_PROBE_BASH_WEBC;
const officialCoreutilsWebcPath = process.env.MENTAL_LEGOS_BASH_PROBE_COREUTILS_WEBC;
const officialPythonWebcPath = process.env.MENTAL_LEGOS_BASH_PROBE_PYTHON_WEBC;
const officialSandboxLauncher = process.env.MENTAL_LEGOS_BASH_PROBE_SANDBOX_LAUNCHER;
const officialProbe = officialRunnerPath
  && officialBashWebcPath
  && officialCoreutilsWebcPath
  && officialPythonWebcPath
  ? it
  : it.skip;
const officialAppContainerProbe = officialRunnerPath
  && officialBashWebcPath
  && officialCoreutilsWebcPath
  && officialPythonWebcPath
  && officialSandboxLauncher
  ? it
  : it.skip;

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mental-legos-broker-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createRuntimeFixture(root: string): Promise<BashRuntimePaths> {
  const runtimeRoot = path.join(root, 'runtime');
  const runnerPath = path.join(runtimeRoot, 'bin', 'wasmer.exe');
  const bashWebcPath = path.join(runtimeRoot, 'packages', 'bash.webc');
  const coreutilsWebcPath = path.join(runtimeRoot, 'packages', 'coreutils.webc');
  const pythonWebcPath = path.join(runtimeRoot, 'packages', 'python.webc');
  const pythonManifestPath = path.join(
    runtimeRoot,
    'packages',
    'python-manifest.json',
  );
  const coreutilsManifestPath = path.join(
    runtimeRoot,
    'packages',
    'coreutils-manifest.json',
  );
  await Promise.all([
    mkdir(path.dirname(runnerPath), { recursive: true }),
    mkdir(path.dirname(bashWebcPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(runnerPath, 'synthetic runner'),
    writeFile(bashWebcPath, 'synthetic bash'),
    writeFile(coreutilsWebcPath, 'synthetic coreutils'),
    writeFile(pythonWebcPath, 'synthetic Python'),
    writeFile(pythonManifestPath, JSON.stringify({ atoms: {}, commands: {} })),
    writeFile(coreutilsManifestPath, JSON.stringify({ atoms: {}, commands: {} })),
  ]);
  return {
    runnerPath,
    bashWebcPath,
    coreutilsWebcPath,
    pythonWebcPath,
    pythonPackage: 'python/python@3.13.5',
    pythonManifestPath,
    pythonVersion: '3.13.5',
    coreutilsManifestPath,
    coreutilsVersion: '1.0.25',
    cacheDirectory: path.join(root, 'cache'),
    proxyPath: path.join(
      process.cwd(),
      'resources',
      'windows-sandbox',
      'MentalLegos.BashProxy.exe',
    ),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`)) {
      throw new Error('Refusing to clean a broker test path outside the temporary directory.');
    }
    await rm(resolved, { recursive: true, force: true });
  }));
});

describe('isolated Bash broker', () => {
  it('maps only the session root and scrubs generated host shell state', () => {
    const workspace = 'D:\\synthetic-sessions\\session-one';
    const userHome = ['C:', 'Users', 'synthetic-user'].join('\\');
    const translated = translateBashArgument([
      `cd "${workspace}\\scratch"`,
      `export PATH='${userHome}\\bin;C:\\Windows\\System32'`,
      `source /d/synthetic-sessions/session-one/tmp/snapshot.sh`,
      `${userHome}\\.local\\bin\\claude.exe`,
    ].join('\n'), workspace);

    expect(translated).toContain('/workspace/scratch');
    expect(translated).toContain("export PATH='/bin:/usr/bin'");
    expect(translated).toContain('/workspace/tmp/snapshot.sh');
    expect(translated).toContain('/workspace/.unavailable/claude.exe');
    expect(translated).not.toContain('synthetic-user');
  });

  it('neutralizes Claude Code AppContainer cwd tracker paths', () => {
    expect(translateBashArgument(
      'source C:\\Profiles\\tester\\AppData\\Local\\Packages\\agent\\AC\\Temp\\claude-75a5-cwd && pwd',
      'C:\\sessions\\current',
    )).toBe('source /dev/null && pwd');
    expect(translateBashArgument(
      'source /c/Profiles/tester/AppData/Local/Packages/agent/AC/Temp/claude-75a5-cwd && pwd',
      'C:\\sessions\\current',
    )).toBe('source /dev/null && pwd');
  });

  it('never forwards arbitrary host variables or enables WASIX networking', () => {
    const runtime: BashRuntimePaths = {
      runnerPath: 'D:\\runtime\\wasmer.exe',
      bashWebcPath: 'D:\\runtime\\bash.webc',
      coreutilsWebcPath: 'D:\\runtime\\coreutils.webc',
      pythonWebcPath: 'D:\\runtime\\python.webc',
      pythonPackage: 'python/python@3.13.5',
      pythonManifestPath: 'D:\\runtime\\python-manifest.json',
      pythonVersion: '3.13.5',
      coreutilsManifestPath: 'D:\\runtime\\coreutils-manifest.json',
      coreutilsVersion: '1.0.25',
      cacheDirectory: 'D:\\cache',
      proxyPath: 'D:\\runtime\\bash-proxy.exe',
    };
    const sourceEnvironment = {
      SYSTEMROOT: 'C:\\Windows',
      MENTAL_LEGOS_SYNTHETIC_SECRET: 'must-not-cross-boundary',
    };
    const environment = buildBashHostEnvironment({
      cacheDirectory: runtime.cacheDirectory,
      temporaryDirectory: 'D:\\session\\tmp',
      sourceEnvironment,
    });
    const invocation = buildWasmerBashInvocation({
      runtime,
      workspaceRoot: 'D:\\session',
      guestWorkspaceRoot: 'D:\\guest',
      writableDirectories: {
        scratch: 'D:\\session\\scratch',
        output: 'D:\\session\\output',
        temporary: 'D:\\session\\tmp',
      },
      temporaryDirectory: 'D:\\session\\tmp',
      bashArguments: ['-lc', 'env'],
      registryUrl: 'http://127.0.0.1:32123/graphql',
      sourceEnvironment,
    });

    expect(environment.SYSTEMROOT).toBe('C:\\Windows');
    expect(environment).not.toHaveProperty('MENTAL_LEGOS_SYNTHETIC_SECRET');
    expect(invocation.args).not.toContain('--net');
    expect(invocation.args).not.toContain('--forward-host-env');
    expect(invocation.args).toContain('--v8');
    expect(invocation.args).toEqual(expect.arrayContaining([
      '--volume',
      'D:\\guest:/workspace',
      '--include-webc',
      runtime.coreutilsWebcPath,
      '--include-webc',
      runtime.pythonWebcPath,
      '--use',
      runtime.pythonPackage,
    ]));
  });

  it('redacts host paths before returning sandbox output', () => {
    const userHome = ['C:', 'Users', 'synthetic-user'].join('\\');
    const sanitized = sanitizeBashText(
      `failed in D:\\session\\tmp and ${userHome}\\private`,
      ['D:\\session'],
    );
    expect(sanitized).toBe('failed in <sandbox-path>\\tmp and <user-home>\\private');
  });

  it.skipIf(process.platform !== 'win32')(
    'round-trips native proxy arguments through an authenticated broker',
    async () => {
      const root = await createTemporaryDirectory();
      const workspaceRoot = path.join(root, 'workspace');
      const temporaryDirectory = path.join(workspaceRoot, 'tmp');
      const ipcDirectory = path.join(root, 'ipc');
      await mkdir(workspaceRoot, { recursive: true });
      const runtime = await createRuntimeFixture(root);
      let observed: WasmerBashInvocation | undefined;
      const broker = new WasmerBashBroker({
        ipcDirectory,
        workspaceRoot,
        temporaryDirectory,
        scratchDirectory: path.join(workspaceRoot, 'scratch'),
        outputDirectory: path.join(workspaceRoot, 'output'),
        guestRootDirectory: path.join(root, 'guest'),
        runtime,
        executor: async (invocation) => {
          observed = invocation;
          return { exitCode: 0, stdout: 'proxy-stdout', stderr: '' };
        },
      });
      await broker.start();
      try {
        const environment = {
          ...broker.agentEnvironment(),
          SYSTEMROOT: process.env.SYSTEMROOT ?? 'C:\\Windows',
          WINDIR: process.env.WINDIR ?? 'C:\\Windows',
        };
        const result = await execFileAsync(runtime.proxyPath, [
          '-lc',
          `printf '%s' '${workspaceRoot}\\scratch'`,
        ], {
          encoding: 'utf8',
          env: environment,
          windowsHide: true,
          timeout: 10_000,
        });
        expect(result.stdout).toBe('proxy-stdout');
        expect(observed).toBeDefined();
        expect(observed?.args.at(-1)).toContain('/workspace/scratch');
        expect(observed?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      } finally {
        await broker.close();
      }
    },
  );

  it('keeps authenticated IPC and runtime cache outside the guest mount', async () => {
    const root = await createTemporaryDirectory();
    const workspaceRoot = path.join(root, 'workspace');
    await mkdir(workspaceRoot, { recursive: true });
    const runtime = await createRuntimeFixture(root);
    expect(() => new WasmerBashBroker({
      ipcDirectory: path.join(workspaceRoot, '.bash-ipc'),
      workspaceRoot,
      temporaryDirectory: path.join(workspaceRoot, 'tmp'),
      scratchDirectory: path.join(workspaceRoot, 'scratch'),
      outputDirectory: path.join(workspaceRoot, 'output'),
      guestRootDirectory: path.join(root, 'guest'),
      runtime,
    })).toThrow('outside the guest workspace');
  });

  officialProbe(
    'executes full Bash arrays without exposing the provider credential',
    async () => {
      if (
        !officialRunnerPath
        || !officialBashWebcPath
        || !officialCoreutilsWebcPath
        || !officialPythonWebcPath
      ) return;
      const root = await createTemporaryDirectory();
      const workspaceRoot = path.join(root, 'workspace');
      const temporaryDirectory = path.join(workspaceRoot, 'tmp');
      const ipcDirectory = path.join(root, 'ipc');
      const referenceDirectory = path.join(workspaceRoot, 'reference');
      await mkdir(referenceDirectory, { recursive: true });
      await copyFile(
        path.join(
          process.cwd(),
          'resources',
          'capability-bundle',
          '.claude',
          'skills',
          'lego-extraction',
          'scripts',
          'validate-candidate.py',
        ),
        path.join(referenceDirectory, 'validate-candidate.py'),
      );
      await writeFile(path.join(workspaceRoot, 'CLAUDE.md'), 'protected-capability');
      const runtime: BashRuntimePaths = {
        runnerPath: officialRunnerPath,
        bashWebcPath: officialBashWebcPath,
        coreutilsWebcPath: officialCoreutilsWebcPath,
        pythonWebcPath: officialPythonWebcPath,
        pythonPackage: 'python/python@3.13.5',
        pythonManifestPath: path.join(
          process.cwd(),
          '.private',
          'dependency-audit',
          'python-python-3.13.5-unpacked',
          'manifest.json',
        ),
        pythonVersion: '3.13.5',
        coreutilsManifestPath: path.join(
          process.cwd(),
          '.private',
          'dependency-audit',
          'webc-coreutils-unpacked',
          'manifest.json',
        ),
        coreutilsVersion: '1.0.25',
        cacheDirectory: path.join(root, 'wasmer-cache'),
        proxyPath: path.join(
          process.cwd(),
          'resources',
          'windows-sandbox',
          'MentalLegos.BashProxy.exe',
        ),
      };
      const broker = new WasmerBashBroker({
        ipcDirectory,
        workspaceRoot,
        temporaryDirectory,
        scratchDirectory: path.join(workspaceRoot, 'scratch'),
        outputDirectory: path.join(workspaceRoot, 'output'),
        guestRootDirectory: path.join(root, 'guest'),
        runtime,
      });
      await broker.start();
      try {
        const result = await execFileAsync(runtime.proxyPath, [
          '-lc',
          "declare -a parts=(full bash); [[ \"${parts[1]}\" == bash ]] && [[ -z \"${ANTHROPIC_API_KEY+x}\" ]] && printf 'guest-only-change' > CLAUDE.md && printf 'writable-proof' > scratch/proof.txt && cp reference/validate-candidate.py scratch/adapted.py && printf '\\n# adapted in sandbox\\n' >> scratch/adapted.py && python scratch/adapted.py '{\"semantic_core\":\"A bounded judgment\",\"logical_skeleton\":\"signal to implication\",\"language_shells\":[\"If we narrow the question\"],\"retrieval_cues\":[\"open question\"],\"scope\":\"synthetic test\",\"provenance\":\"synthetic test\"}' > output/result.json && printf 'isolated-bash-ok'",
        ], {
          encoding: 'utf8',
          env: {
            ...broker.agentEnvironment(),
            SYSTEMROOT: process.env.SYSTEMROOT ?? 'C:\\Windows',
            WINDIR: process.env.WINDIR ?? 'C:\\Windows',
            COMSPEC: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
            PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
            PATH: process.env.PATH ?? 'C:\\Windows\\System32',
            TEMP: temporaryDirectory,
            TMP: temporaryDirectory,
            LOCALAPPDATA: process.env.LOCALAPPDATA ?? temporaryDirectory,
            USERPROFILE: workspaceRoot,
            HOMEDRIVE: path.parse(workspaceRoot).root.slice(0, 2),
            HOMEPATH: workspaceRoot.slice(path.parse(workspaceRoot).root.length - 1),
            APPDATA: workspaceRoot,
            ANTHROPIC_API_KEY: 'synthetic-provider-credential',
          },
          windowsHide: true,
          timeout: 60_000,
        });
        expect(result.stdout).toBe('isolated-bash-ok');
        await expect(readFile(path.join(workspaceRoot, 'CLAUDE.md'), 'utf8'))
          .resolves.toBe('protected-capability');
        await expect(readFile(path.join(workspaceRoot, 'scratch', 'proof.txt'), 'utf8'))
          .resolves.toBe('writable-proof');
        await expect(readFile(path.join(workspaceRoot, 'output', 'result.json'), 'utf8'))
          .resolves.toContain('"valid":true');
        await expect(readFile(path.join(workspaceRoot, 'scratch', 'adapted.py'), 'utf8'))
          .resolves.toContain('# adapted in sandbox');
        await expect(readFile(
          path.join(workspaceRoot, 'reference', 'validate-candidate.py'),
          'utf8',
        )).resolves.not.toContain('# adapted in sandbox');
      } finally {
        await broker.close();
      }
    },
    70_000,
  );

  officialAppContainerProbe(
    'bridges an AppContainer Claude-side process into credential-free Bash',
    async () => {
      if (
        !officialRunnerPath
        || !officialBashWebcPath
        || !officialCoreutilsWebcPath
        || !officialPythonWebcPath
        || !officialSandboxLauncher
      ) return;
      const root = await createTemporaryDirectory();
      const workspaceRoot = path.join(root, 'workspace');
      const ipcDirectory = path.join(root, 'ipc');
      const temporaryDirectory = path.join(workspaceRoot, 'tmp');
      const stagedProxyPath = path.join(workspaceRoot, '.runtime', 'bash.exe');
      await mkdir(path.dirname(stagedProxyPath), { recursive: true });
      await copyFile(
        path.join(
          process.cwd(),
          'resources',
          'windows-sandbox',
          'MentalLegos.BashProxy.exe',
        ),
        stagedProxyPath,
      );
      const runtime: BashRuntimePaths = {
        runnerPath: officialRunnerPath,
        bashWebcPath: officialBashWebcPath,
        coreutilsWebcPath: officialCoreutilsWebcPath,
        pythonWebcPath: officialPythonWebcPath,
        pythonPackage: 'python/python@3.13.5',
        pythonManifestPath: path.join(
          process.cwd(),
          '.private',
          'dependency-audit',
          'python-python-3.13.5-unpacked',
          'manifest.json',
        ),
        pythonVersion: '3.13.5',
        coreutilsManifestPath: path.join(
          process.cwd(),
          '.private',
          'dependency-audit',
          'webc-coreutils-unpacked',
          'manifest.json',
        ),
        coreutilsVersion: '1.0.25',
        cacheDirectory: path.join(root, 'wasmer-cache'),
        proxyPath: stagedProxyPath,
      };
      const broker = new WasmerBashBroker({
        ipcDirectory,
        workspaceRoot,
        temporaryDirectory,
        scratchDirectory: path.join(workspaceRoot, 'scratch'),
        outputDirectory: path.join(workspaceRoot, 'output'),
        guestRootDirectory: path.join(root, 'guest'),
        runtime,
      });
      const profile = `MentalLEGOs.BashTest.${process.pid}.${Date.now()}`;
      await broker.start();
      try {
        const result = await execFileAsync(officialSandboxLauncher, [
          'run',
          '--profile', profile,
          '--workspace', workspaceRoot,
          '--target', runtime.proxyPath,
          '--writable', ipcDirectory,
          '--',
          '-lc',
          "declare -a parts=(app container); [[ \"${parts[1]}\" == container ]] && [[ -z \"${ANTHROPIC_API_KEY+x}\" ]] && python -c 'from pathlib import Path; Path(\"scratch/appcontainer-python.txt\").write_text(\"sandboxed-python-ok\")' && printf 'dual-sandbox-ok'",
        ], {
          encoding: 'utf8',
          env: {
            ...broker.agentEnvironment(),
            SYSTEMROOT: process.env.SYSTEMROOT ?? 'C:\\Windows',
            WINDIR: process.env.WINDIR ?? 'C:\\Windows',
            COMSPEC: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
            PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
            PATH: process.env.PATH ?? 'C:\\Windows\\System32',
            TEMP: temporaryDirectory,
            TMP: temporaryDirectory,
            LOCALAPPDATA: process.env.LOCALAPPDATA ?? temporaryDirectory,
            ANTHROPIC_API_KEY: 'synthetic-provider-credential',
          },
          windowsHide: true,
          timeout: 60_000,
        });
        expect(result.stdout).toBe('dual-sandbox-ok');
        await expect(readFile(
          path.join(workspaceRoot, 'scratch', 'appcontainer-python.txt'),
          'utf8',
        )).resolves.toBe('sandboxed-python-ok');
      } finally {
        await broker.close();
        await execFileAsync(officialSandboxLauncher, [
          'delete-profile',
          profile,
          workspaceRoot,
          ipcDirectory,
          path.dirname(runtime.proxyPath),
          runtime.proxyPath,
        ], { windowsHide: true });
      }
    },
    70_000,
  );
});
