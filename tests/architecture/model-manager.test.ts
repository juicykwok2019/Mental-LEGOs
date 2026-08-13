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
  LocalAsrModelManager,
  ModelManagerError,
  validateArchiveEntries,
} from '../../src/asr/model-manager';
import {
  localAsrModelManifestSchema,
  loadLocalAsrModelManifest,
  type LocalAsrModelManifest,
} from '../../src/asr/model-manifest';
import { transcribeLocalWave } from '../../src/asr/runtime';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const officialArchivePath = process.env.MENTAL_LEGOS_ASR_PROBE_ARCHIVE;
const officialAudioPath = process.env.MENTAL_LEGOS_ASR_PROBE_AUDIO;
const officialProbe = officialArchivePath && officialAudioPath ? it : it.skip;

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function manifestFor(input: {
  archive: Uint8Array;
  model: Uint8Array;
  tokens: Uint8Array;
}): LocalAsrModelManifest {
  return localAsrModelManifestSchema.parse({
    schemaVersion: 1,
    id: 'sensevoice-test-model',
    displayName: 'SenseVoice test model',
    runtime: 'sherpa-onnx-node@1.13.4',
    languages: ['zh', 'en', 'ja', 'ko', 'yue'],
    archive: {
      url: 'https://github.com/example/model.tar.bz2',
      bytes: input.archive.length,
      sha256: digest(input.archive),
    },
    rootDirectory: 'sensevoice-test-archive',
    files: {
      'model.int8.onnx': {
        bytes: input.model.length,
        sha256: digest(input.model),
      },
      'tokens.txt': {
        bytes: input.tokens.length,
        sha256: digest(input.tokens),
      },
    },
    attribution: {
      modelName: 'SenseVoiceSmall',
      modelProject: 'https://github.com/FunAudioLLM/SenseVoice',
      runtimeProject: 'https://github.com/k2-fsa/sherpa-onnx',
      modelLicense: 'FunASR Model Open Source License Agreement',
      commercialUseClarification: 'https://github.com/FunAudioLLM/SenseVoice/issues/286',
    },
  });
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mental-legos-model-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep)) {
      throw new Error('Refusing to clean a test path outside the temporary directory.');
    }
    await rm(resolved, { recursive: true, force: true });
  }));
});

describe('local ASR model manager', () => {
  it('rejects archive traversal and incomplete archives', () => {
    const bytes = new TextEncoder().encode('fixture');
    const manifest = manifestFor({ archive: bytes, model: bytes, tokens: bytes });
    expect(() => validateArchiveEntries([
      `${manifest.rootDirectory}/model.int8.onnx`,
      `${manifest.rootDirectory}/tokens.txt`,
      `${manifest.rootDirectory}/LICENSE`,
      `${manifest.rootDirectory}/README.md`,
      `${manifest.rootDirectory}/../escape.txt`,
    ], manifest)).toThrow(ModelManagerError);
    expect(() => validateArchiveEntries([
      `${manifest.rootDirectory}/model.int8.onnx`,
    ], manifest)).toThrow(ModelManagerError);
  });

  it('resumes a partial trusted download and verifies its hash', async () => {
    const root = await createTemporaryDirectory();
    const archive = new TextEncoder().encode('0123456789');
    const model = new TextEncoder().encode('model');
    const tokens = new TextEncoder().encode('tokens');
    const manifest = manifestFor({ archive, model, tokens });
    const fetchImplementation: typeof fetch = async (_url, init) => {
      expect(new Headers(init?.headers).get('range')).toBe('bytes=4-');
      return new Response(archive.slice(4), {
        status: 206,
        headers: { 'content-range': 'bytes 4-9/10' },
      });
    };
    const manager = new LocalAsrModelManager({
      modelsRoot: root,
      fetchImplementation,
    });

    await writeFile(manager.downloadPath(manifest), archive.slice(0, 4));
    const downloaded = await manager.download(manifest);
    expect(new Uint8Array(await readFile(downloaded))).toEqual(archive);
  });

  it('reuses a fully downloaded archive only after hash verification', async () => {
    const root = await createTemporaryDirectory();
    const archive = new TextEncoder().encode('complete-archive');
    const model = new TextEncoder().encode('model');
    const tokens = new TextEncoder().encode('tokens');
    const manifest = manifestFor({ archive, model, tokens });
    const manager = new LocalAsrModelManager({
      modelsRoot: root,
      fetchImplementation: async () => {
        throw new Error('fetch should not run for a verified complete archive');
      },
    });
    await writeFile(manager.downloadPath(manifest), archive);
    await expect(manager.download(manifest)).resolves.toBe(manager.downloadPath(manifest));
  });

  it.skipIf(process.platform !== 'win32')(
    'installs, verifies, and explicitly uninstalls a synthetic archive',
    async () => {
      const root = await createTemporaryDirectory();
      const source = path.join(root, 'source');
      const archiveRoot = path.join(source, 'sensevoice-test-archive');
      const modelsRoot = path.join(root, 'models');
      const archivePath = path.join(root, 'model.tar.bz2');
      const model = new TextEncoder().encode('synthetic-model-weights');
      const tokens = new TextEncoder().encode('synthetic tokens');
      await mkdir(archiveRoot, { recursive: true });
      await Promise.all([
        writeFile(path.join(archiveRoot, 'model.int8.onnx'), model),
        writeFile(path.join(archiveRoot, 'tokens.txt'), tokens),
        writeFile(path.join(archiveRoot, 'LICENSE'), 'synthetic fixture license'),
        writeFile(path.join(archiveRoot, 'README.md'), 'synthetic fixture'),
      ]);
      const tarPath = path.join(process.env.SYSTEMROOT ?? '', 'System32', 'tar.exe');
      await execFileAsync(tarPath, [
        '-cjf',
        archivePath,
        '-C',
        source,
        'sensevoice-test-archive',
      ], { windowsHide: true });
      const archive = new Uint8Array(await readFile(archivePath));
      const manifest = manifestFor({ archive, model, tokens });
      const manager = new LocalAsrModelManager({ modelsRoot });

      const installedDirectory = await manager.installFromArchive(manifest, archivePath);
      await expect(manager.inspect(manifest, true)).resolves.toMatchObject({
        state: 'installed',
        modelDirectory: installedDirectory,
        verified: true,
      });
      await expect(manager.uninstall(manifest, 'wrong-model')).rejects.toMatchObject({
        code: 'UNINSTALL_NOT_CONFIRMED',
      });
      await manager.uninstall(manifest, manifest.id);
      await expect(manager.inspect(manifest)).resolves.toMatchObject({ state: 'missing' });
    },
  );

  officialProbe(
    'installs, transcribes, verifies, and removes the audited official model',
    async () => {
      if (!officialArchivePath || !officialAudioPath) return;
      const root = await createTemporaryDirectory();
      const modelsRoot = path.join(root, 'models');
      const manifest = await loadLocalAsrModelManifest(path.join(
        process.cwd(),
        'resources',
        'asr-models',
        'sensevoice-small-int8-2024-07-17.json',
      ));
      const manager = new LocalAsrModelManager({ modelsRoot });
      const modelDirectory = await manager.installFromArchive(
        manifest,
        officialArchivePath,
      );
      await expect(manager.inspect(manifest, true)).resolves.toMatchObject({
        state: 'installed',
        verified: true,
      });
      const transcription = await transcribeLocalWave({
        modelDirectory,
        audioPath: officialAudioPath,
        language: 'auto',
        numThreads: 2,
      });
      expect(transcription.text.trim().length).toBeGreaterThan(4);
      expect(transcription.realTimeFactor).toBeLessThan(1);
      await manager.uninstall(manifest, manifest.id);
      await expect(manager.inspect(manifest)).resolves.toMatchObject({ state: 'missing' });
    },
    120_000,
  );
});
