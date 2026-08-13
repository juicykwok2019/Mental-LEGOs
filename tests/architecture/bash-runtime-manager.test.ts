import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BashRuntimeManager,
  BashRuntimeManagerError,
  validateBashRuntimeArchiveEntries,
} from '../../src/bash/runtime-manager';
import {
  bashRuntimeManifestSchema,
  loadBashRuntimeManifest,
  type BashRuntimeManifest,
} from '../../src/bash/runtime-manifest';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const officialRunnerArchive = process.env.MENTAL_LEGOS_BASH_PROBE_ARCHIVE;
const officialBashWebc = process.env.MENTAL_LEGOS_BASH_PROBE_BASH_WEBC;
const officialCoreutilsWebc = process.env.MENTAL_LEGOS_BASH_PROBE_COREUTILS_WEBC;
const officialPythonWebc = process.env.MENTAL_LEGOS_BASH_PROBE_PYTHON_WEBC;
const officialProbe = officialRunnerArchive
  && officialBashWebc
  && officialCoreutilsWebc
  && officialPythonWebc
  ? it
  : it.skip;

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function manifestFor(input: {
  archive: Uint8Array;
  wasmer: Uint8Array;
  headless: Uint8Array;
  license: Uint8Array;
  attributions: Uint8Array;
  bash: Uint8Array;
  coreutils: Uint8Array;
  python: Uint8Array;
  coreutilsManifest: Uint8Array;
  pythonManifest: Uint8Array;
}): BashRuntimeManifest {
  return bashRuntimeManifestSchema.parse({
    schemaVersion: 1,
    id: 'wasmer-bash-windows-test',
    displayName: 'Synthetic Wasmer Bash runtime',
    platform: 'win32',
    architecture: 'x64',
    runner: {
      name: 'Wasmer',
      version: '7.2.1',
      archive: {
        url: 'https://github.com/example/wasmer.tar.gz',
        bytes: input.archive.length,
        sha256: digest(input.archive),
      },
      files: {
        'bin/wasmer.exe': { bytes: input.wasmer.length, sha256: digest(input.wasmer) },
        'bin/wasmer-headless.exe': {
          bytes: input.headless.length,
          sha256: digest(input.headless),
        },
        LICENSE: { bytes: input.license.length, sha256: digest(input.license) },
        ATTRIBUTIONS: {
          bytes: input.attributions.length,
          sha256: digest(input.attributions),
        },
      },
      project: 'https://github.com/wasmerio/wasmer',
      license: 'MIT',
    },
    packages: {
      bash: {
        name: 'wasmer/bash',
        version: '1.0.25',
        artifact: {
          url: 'https://cdn.wasmer.io/webcimages/bash.webc',
          bytes: input.bash.length,
          sha256: digest(input.bash),
        },
        registry: 'https://wasmer.io/wasmer/bash',
        runtimeReportedLicense: 'GPLv3+',
      },
      coreutils: {
        name: 'wasmer/coreutils',
        version: '1.0.25',
        artifact: {
          url: 'https://cdn.wasmer.io/webcimages/coreutils.webc',
          bytes: input.coreutils.length,
          sha256: digest(input.coreutils),
        },
        registry: 'https://wasmer.io/wasmer/coreutils',
        license: 'MIT',
        unpackedManifest: {
          bytes: input.coreutilsManifest.length,
          sha256: digest(input.coreutilsManifest),
        },
      },
      python: {
        name: 'python/python',
        version: '3.13.5',
        artifact: {
          url: 'https://cdn.wasmer.io/webcimages/python.webc',
          bytes: input.python.length,
          sha256: digest(input.python),
        },
        registry: 'https://wasmer.io/python/python',
        license: 'PSF-2.0',
        unpackedManifest: {
          bytes: input.pythonManifest.length,
          sha256: digest(input.pythonManifest),
        },
      },
    },
  });
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mental-legos-bash-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`)) {
      throw new Error('Refusing to clean a Bash test path outside the temporary directory.');
    }
    await rm(resolved, { recursive: true, force: true });
  }));
});

describe('sandboxed Bash runtime manager', () => {
  it('loads the pinned public runtime manifest', async () => {
    const manifest = await loadBashRuntimeManifest(path.join(
      process.cwd(),
      'resources',
      'bash-runtime',
      'windows-x64-wasmer-bash.json',
    ));
    expect(manifest.runner.version).toBe('7.2.1');
    expect(manifest.packages.bash.version).toBe('1.0.25');
    expect(manifest.packages.coreutils.version).toBe('1.0.25');
    expect(manifest.packages.python.version).toBe('3.13.5');
  });

  it('rejects archive traversal and incomplete archives', () => {
    expect(() => validateBashRuntimeArchiveEntries([
      'bin/wasmer.exe',
      'bin/wasmer-headless.exe',
      'LICENSE',
      'ATTRIBUTIONS',
      '../escape.exe',
    ])).toThrow(BashRuntimeManagerError);
    expect(() => validateBashRuntimeArchiveEntries([
      'bin/wasmer.exe',
      'LICENSE',
    ])).toThrow(BashRuntimeManagerError);
  });

  it('downloads every fixed asset with verification and progress attribution', async () => {
    const root = await createTemporaryDirectory();
    const fixture = new TextEncoder().encode('fixed-download-fixture');
    const input = {
      archive: fixture,
      wasmer: fixture,
      headless: fixture,
      license: fixture,
      attributions: fixture,
      bash: fixture,
      coreutils: fixture,
      python: fixture,
      coreutilsManifest: fixture,
      pythonManifest: fixture,
    };
    const manifest = manifestFor(input);
    const assets = new Map<string, Uint8Array>([
      [manifest.runner.archive.url, input.archive],
      [manifest.packages.bash.artifact.url, input.bash],
      [manifest.packages.coreutils.artifact.url, input.coreutils],
      [manifest.packages.python.artifact.url, input.python],
    ]);
    const progress = new Set<string>();
    const manager = new BashRuntimeManager({
      runtimesRoot: path.join(root, 'runtimes'),
      fetchImplementation: async (request) => {
        const bytes = assets.get(request.toString());
        return bytes
          ? new Response(Uint8Array.from(bytes).buffer, { status: 200 })
          : new Response(null, { status: 404 });
      },
    });
    const downloads = await manager.downloadAssets(manifest, (event) => {
      progress.add(event.asset);
    });
    await expect(Promise.all([
      readFile(downloads.runnerArchive),
      readFile(downloads.bashWebc),
      readFile(downloads.coreutilsWebc),
      readFile(downloads.pythonWebc),
    ])).resolves.toHaveLength(4);
    expect(progress).toEqual(new Set(['runner', 'bash', 'coreutils', 'python']));
  });

  it.skipIf(process.platform !== 'win32')(
    'downloads, installs, verifies, and explicitly removes fixed assets',
    async () => {
      const root = await createTemporaryDirectory();
      const source = path.join(root, 'source');
      const runnerRoot = path.join(source, 'runner');
      const archivePath = path.join(source, 'wasmer.tar.gz');
      const wasmer = new TextEncoder().encode('synthetic-wasmer-runner');
      const headless = new TextEncoder().encode('synthetic-headless-runner');
      const license = new TextEncoder().encode('synthetic MIT license');
      const attributions = new TextEncoder().encode('synthetic attributions');
      const bash = new TextEncoder().encode('synthetic bash WebC');
      const coreutils = new TextEncoder().encode('synthetic coreutils WebC');
      const python = new TextEncoder().encode('synthetic Python WebC');
      const coreutilsManifest = new TextEncoder().encode(JSON.stringify({
        package: { wapm: { license: 'MIT' } },
        atoms: {},
        commands: {},
      }));
      const pythonManifest = new TextEncoder().encode(JSON.stringify({
        package: { wapm: { license: 'PSF-2.0' } },
        atoms: {},
        commands: {},
      }));
      const coreutilsManifestPath = path.join(source, 'coreutils-manifest.json');
      const pythonManifestPath = path.join(source, 'python-manifest.json');
      const bashPath = path.join(source, 'bash.webc');
      const coreutilsPath = path.join(source, 'coreutils.webc');
      const pythonPath = path.join(source, 'python.webc');
      await mkdir(path.join(runnerRoot, 'bin'), { recursive: true });
      await Promise.all([
        writeFile(path.join(runnerRoot, 'bin', 'wasmer.exe'), wasmer),
        writeFile(path.join(runnerRoot, 'bin', 'wasmer-headless.exe'), headless),
        writeFile(path.join(runnerRoot, 'LICENSE'), license),
        writeFile(path.join(runnerRoot, 'ATTRIBUTIONS'), attributions),
        writeFile(coreutilsManifestPath, coreutilsManifest),
        writeFile(pythonManifestPath, pythonManifest),
        writeFile(bashPath, bash),
        writeFile(coreutilsPath, coreutils),
        writeFile(pythonPath, python),
      ]);
      const tarPath = path.join(process.env.SYSTEMROOT ?? '', 'System32', 'tar.exe');
      await execFileAsync(tarPath, [
        '-czf',
        archivePath,
        '-C',
        runnerRoot,
        'bin/wasmer.exe',
        'bin/wasmer-headless.exe',
        'LICENSE',
        'ATTRIBUTIONS',
      ], { windowsHide: true });
      const archive = new Uint8Array(await readFile(archivePath));
      const manifest = manifestFor({
        archive,
        wasmer,
        headless,
        license,
        attributions,
        bash,
        coreutils,
        python,
        coreutilsManifest,
        pythonManifest,
      });
      const manager = new BashRuntimeManager({
        runtimesRoot: path.join(root, 'runtimes'),
      });

      const runtimeDirectory = await manager.installFromFiles(manifest, {
        runnerArchive: archivePath,
        bashWebc: bashPath,
        coreutilsWebc: coreutilsPath,
        pythonWebc: pythonPath,
        coreutilsManifest: coreutilsManifestPath,
        pythonManifest: pythonManifestPath,
      });
      await expect(manager.inspect(manifest, true)).resolves.toMatchObject({
        state: 'installed',
        runtimeDirectory,
        verified: true,
      });
      await expect(manager.uninstall(manifest, 'wrong-runtime')).rejects.toMatchObject({
        code: 'UNINSTALL_NOT_CONFIRMED',
      });
      await manager.uninstall(manifest, manifest.id);
      await expect(manager.inspect(manifest)).resolves.toMatchObject({ state: 'missing' });
    },
  );

  officialProbe(
    'installs and verifies the complete audited official runtime',
    async () => {
      if (
        !officialRunnerArchive
        || !officialBashWebc
        || !officialCoreutilsWebc
        || !officialPythonWebc
      ) return;
      const root = await createTemporaryDirectory();
      const manifest = await loadBashRuntimeManifest(path.join(
        process.cwd(),
        'resources',
        'bash-runtime',
        'windows-x64-wasmer-bash.json',
      ));
      const manager = new BashRuntimeManager({
        runtimesRoot: path.join(root, 'runtimes'),
      });
      const runtimeDirectory = await manager.installFromFiles(manifest, {
        runnerArchive: officialRunnerArchive,
        bashWebc: officialBashWebc,
        coreutilsWebc: officialCoreutilsWebc,
        pythonWebc: officialPythonWebc,
      });
      await expect(manager.inspect(manifest, true)).resolves.toMatchObject({
        state: 'installed',
        runtimeDirectory,
        verified: true,
      });
      await manager.uninstall(manifest, manifest.id);
      await expect(manager.inspect(manifest)).resolves.toMatchObject({ state: 'missing' });
    },
    120_000,
  );
});
