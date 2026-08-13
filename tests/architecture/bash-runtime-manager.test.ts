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
      await mkdir(path.join(runnerRoot, 'bin'), { recursive: true });
      await Promise.all([
        writeFile(path.join(runnerRoot, 'bin', 'wasmer.exe'), wasmer),
        writeFile(path.join(runnerRoot, 'bin', 'wasmer-headless.exe'), headless),
        writeFile(path.join(runnerRoot, 'LICENSE'), license),
        writeFile(path.join(runnerRoot, 'ATTRIBUTIONS'), attributions),
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
      });
      const assets = new Map<string, Uint8Array>([
        [manifest.runner.archive.url, archive],
        [manifest.packages.bash.artifact.url, bash],
        [manifest.packages.coreutils.artifact.url, coreutils],
      ]);
      const manager = new BashRuntimeManager({
        runtimesRoot: path.join(root, 'runtimes'),
        fetchImplementation: async (input) => {
          const bytes = assets.get(input.toString());
          if (!bytes) return new Response(null, { status: 404 });
          return new Response(Uint8Array.from(bytes).buffer, { status: 200 });
        },
      });

      const runtimeDirectory = await manager.install(manifest);
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
});
