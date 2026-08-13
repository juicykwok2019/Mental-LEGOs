import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
} from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';

import type { LocalAsrModelManifest } from './model-manifest';

const execFileAsync = promisify(execFile);
const DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

function hasErrorCode(reason: unknown, code: string): boolean {
  return reason instanceof Error
    && 'code' in reason
    && (reason as Error & { code?: unknown }).code === code;
}

export type ModelInstallationStatus =
  | { state: 'missing'; modelDirectory: string }
  | { state: 'invalid'; modelDirectory: string; reason: string }
  | { state: 'installed'; modelDirectory: string; verified: boolean };

export class ModelManagerError extends Error {
  constructor(
    readonly code:
      | 'ARCHIVE_INVALID'
      | 'DOWNLOAD_FAILED'
      | 'EXTRACTION_FAILED'
      | 'INSTALL_CONFLICT'
      | 'MODEL_INVALID'
      | 'PLATFORM_UNSUPPORTED'
      | 'UNINSTALL_NOT_CONFIRMED',
    message: string,
  ) {
    super(message);
    this.name = 'ModelManagerError';
  }
}

function assertDescendant(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ModelManagerError('MODEL_INVALID', 'Model path escaped its managed root.');
  }
  return resolvedCandidate;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyFile(
  filePath: string,
  expected: { bytes: number; sha256: string },
): Promise<boolean> {
  try {
    const metadata = await lstat(filePath);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.size !== expected.bytes
    ) return false;
    return await sha256(filePath) === expected.sha256;
  } catch {
    return false;
  }
}

function assertDownloadUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || !DOWNLOAD_HOSTS.has(url.hostname)
  ) {
    throw new ModelManagerError('DOWNLOAD_FAILED', 'Model download URL is not trusted.');
  }
  return url;
}

export function validateArchiveEntries(
  entries: string[],
  manifest: LocalAsrModelManifest,
): void {
  const normalizedRoot = `${manifest.rootDirectory}/`;
  const normalized = entries
    .map((entry) => entry.trim().replaceAll('\\', '/'))
    .filter(Boolean);

  for (const entry of normalized) {
    const segments = entry.split('/').filter(Boolean);
    if (
      entry.startsWith('/')
      || /^[a-zA-Z]:/.test(entry)
      || segments.includes('..')
      || (entry !== manifest.rootDirectory && !entry.startsWith(normalizedRoot))
    ) {
      throw new ModelManagerError('ARCHIVE_INVALID', 'Model archive contains an unsafe path.');
    }
  }

  for (const required of [
    `${normalizedRoot}model.int8.onnx`,
    `${normalizedRoot}tokens.txt`,
    `${normalizedRoot}LICENSE`,
    `${normalizedRoot}README.md`,
  ]) {
    if (!normalized.includes(required)) {
      throw new ModelManagerError('ARCHIVE_INVALID', 'Model archive is incomplete.');
    }
  }
}

export class LocalAsrModelManager {
  readonly #modelsRoot: string;
  readonly #systemRoot: string;
  readonly #fetch: typeof fetch;

  constructor(options: {
    modelsRoot: string;
    systemRoot?: string;
    fetchImplementation?: typeof fetch;
  }) {
    this.#modelsRoot = path.resolve(options.modelsRoot);
    this.#systemRoot = path.resolve(options.systemRoot ?? process.env.SYSTEMROOT ?? '');
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  modelDirectory(manifest: LocalAsrModelManifest): string {
    return assertDescendant(this.#modelsRoot, path.join(this.#modelsRoot, manifest.id));
  }

  downloadPath(manifest: LocalAsrModelManifest): string {
    return assertDescendant(
      this.#modelsRoot,
      path.join(this.#modelsRoot, `.${manifest.id}.download`),
    );
  }

  async #prepareModelsRoot(): Promise<void> {
    await mkdir(this.#modelsRoot, { recursive: true });
    const metadata = await lstat(this.#modelsRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ModelManagerError('MODEL_INVALID', 'The managed model root is unsafe.');
    }
  }

  async inspect(
    manifest: LocalAsrModelManifest,
    verifyHashes = false,
  ): Promise<ModelInstallationStatus> {
    const modelDirectory = this.modelDirectory(manifest);
    try {
      const root = await lstat(this.#modelsRoot);
      if (!root.isDirectory() || root.isSymbolicLink()) {
        return { state: 'invalid', modelDirectory, reason: 'unsafe-model-root' };
      }
    } catch (reason) {
      return hasErrorCode(reason, 'ENOENT')
        ? { state: 'missing', modelDirectory }
        : { state: 'invalid', modelDirectory, reason: 'unreadable-model-root' };
    }
    try {
      const directory = await lstat(modelDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        return { state: 'invalid', modelDirectory, reason: 'not-a-managed-directory' };
      }
    } catch (reason) {
      return hasErrorCode(reason, 'ENOENT')
        ? { state: 'missing', modelDirectory }
        : { state: 'invalid', modelDirectory, reason: 'unreadable-model-directory' };
    }

    for (const fileName of ['model.int8.onnx', 'tokens.txt'] as const) {
      const expected = manifest.files[fileName];
      const filePath = assertDescendant(modelDirectory, path.join(modelDirectory, fileName));
      try {
        const metadata = await stat(filePath);
        if (!metadata.isFile() || metadata.size !== expected.bytes) {
          return { state: 'invalid', modelDirectory, reason: `${fileName}:size` };
        }
      } catch {
        return { state: 'invalid', modelDirectory, reason: `${fileName}:missing` };
      }
      if (verifyHashes && !(await verifyFile(filePath, expected))) {
        return { state: 'invalid', modelDirectory, reason: `${fileName}:hash` };
      }
    }

    return { state: 'installed', modelDirectory, verified: verifyHashes };
  }

  async #requestWithRedirects(
    url: URL,
    headers: Headers,
    remainingRedirects = 5,
  ): Promise<Response> {
    const response = await this.#fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (remainingRedirects === 0) {
        throw new ModelManagerError('DOWNLOAD_FAILED', 'Too many model download redirects.');
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new ModelManagerError('DOWNLOAD_FAILED', 'Model redirect omitted its destination.');
      }
      return this.#requestWithRedirects(
        assertDownloadUrl(new URL(location, url).toString()),
        headers,
        remainingRedirects - 1,
      );
    }
    return response;
  }

  async download(
    manifest: LocalAsrModelManifest,
    onProgress?: (receivedBytes: number, totalBytes: number) => void,
  ): Promise<string> {
    await this.#prepareModelsRoot();
    const destination = this.downloadPath(manifest);
    let offset = 0;
    try {
      const partial = await lstat(destination);
      if (!partial.isFile() || partial.isSymbolicLink()) {
        throw new ModelManagerError('DOWNLOAD_FAILED', 'Partial model download path is unsafe.');
      }
      offset = partial.size;
    } catch (reason) {
      if (!hasErrorCode(reason, 'ENOENT')) throw reason;
    }
    if (offset > manifest.archive.bytes) {
      await rm(destination, { force: true });
      offset = 0;
    }
    if (offset === manifest.archive.bytes) {
      if (await verifyFile(destination, manifest.archive)) return destination;
      await rm(destination, { force: true });
      offset = 0;
    }

    const headers = new Headers();
    if (offset > 0) headers.set('Range', `bytes=${offset}-`);
    const response = await this.#requestWithRedirects(
      assertDownloadUrl(manifest.archive.url),
      headers,
    );

    let append = offset > 0 && response.status === 206;
    if (append) {
      const contentRange = response.headers.get('content-range');
      if (!contentRange?.startsWith(`bytes ${offset}-`)) {
        throw new ModelManagerError('DOWNLOAD_FAILED', 'Model range response is inconsistent.');
      }
    } else if (response.status === 200) {
      append = false;
      offset = 0;
    } else {
      throw new ModelManagerError(
        'DOWNLOAD_FAILED',
        `Model download failed with HTTP ${response.status}.`,
      );
    }
    if (!response.body) {
      throw new ModelManagerError('DOWNLOAD_FAILED', 'Model download returned no body.');
    }

    let receivedBytes = offset;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > manifest.archive.bytes) {
          callback(new ModelManagerError('DOWNLOAD_FAILED', 'Model download exceeded its manifest size.'));
          return;
        }
        onProgress?.(receivedBytes, manifest.archive.bytes);
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream),
      meter,
      createWriteStream(destination, { flags: append ? 'a' : 'w' }),
    );

    if (!(await verifyFile(destination, manifest.archive))) {
      await rm(destination, { force: true });
      throw new ModelManagerError('ARCHIVE_INVALID', 'Downloaded model archive failed verification.');
    }
    return destination;
  }

  #tarPath(): string {
    if (process.platform !== 'win32' || !this.#systemRoot) {
      throw new ModelManagerError(
        'PLATFORM_UNSUPPORTED',
        'The P0 model installer requires Windows.',
      );
    }
    return path.join(this.#systemRoot, 'System32', 'tar.exe');
  }

  async installFromArchive(
    manifest: LocalAsrModelManifest,
    archivePath: string,
  ): Promise<string> {
    await this.#prepareModelsRoot();
    if (!(await verifyFile(archivePath, manifest.archive))) {
      throw new ModelManagerError('ARCHIVE_INVALID', 'Model archive failed verification.');
    }

    const existing = await this.inspect(manifest, true);
    if (existing.state === 'installed') return existing.modelDirectory;
    if (existing.state === 'invalid') {
      throw new ModelManagerError(
        'INSTALL_CONFLICT',
        'An invalid model installation already exists and must be removed explicitly.',
      );
    }

    const tarPath = this.#tarPath();
    await access(tarPath);
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(tarPath, ['-tjf', archivePath], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      }));
    } catch {
      throw new ModelManagerError('ARCHIVE_INVALID', 'Model archive could not be listed.');
    }
    validateArchiveEntries(stdout.split(/\r?\n/), manifest);

    const stagingDirectory = assertDescendant(
      this.#modelsRoot,
      path.join(this.#modelsRoot, `.staging-${manifest.id}-${randomUUID()}`),
    );
    const extractedRoot = assertDescendant(
      stagingDirectory,
      path.join(stagingDirectory, manifest.rootDirectory),
    );
    const destination = this.modelDirectory(manifest);
    await mkdir(stagingDirectory, { recursive: false });

    try {
      const archiveEntries = [
        `${manifest.rootDirectory}/model.int8.onnx`,
        `${manifest.rootDirectory}/tokens.txt`,
        `${manifest.rootDirectory}/LICENSE`,
        `${manifest.rootDirectory}/README.md`,
      ];
      await execFileAsync(tarPath, [
        '-xjf',
        archivePath,
        '-C',
        stagingDirectory,
        ...archiveEntries,
      ], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });

      for (const fileName of ['model.int8.onnx', 'tokens.txt'] as const) {
        const filePath = assertDescendant(extractedRoot, path.join(extractedRoot, fileName));
        if (!(await verifyFile(filePath, manifest.files[fileName]))) {
          throw new ModelManagerError('MODEL_INVALID', 'Extracted model failed verification.');
        }
      }
      await writeFile(
        path.join(extractedRoot, 'installation.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          modelId: manifest.id,
          archiveSha256: manifest.archive.sha256,
          installedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      await rename(extractedRoot, destination);
      return destination;
    } catch (reason) {
      if (reason instanceof ModelManagerError) throw reason;
      throw new ModelManagerError('EXTRACTION_FAILED', 'Model extraction failed.');
    } finally {
      assertDescendant(this.#modelsRoot, stagingDirectory);
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  async install(
    manifest: LocalAsrModelManifest,
    onProgress?: (receivedBytes: number, totalBytes: number) => void,
  ): Promise<string> {
    const archivePath = await this.download(manifest, onProgress);
    const modelDirectory = await this.installFromArchive(manifest, archivePath);
    await rm(this.downloadPath(manifest), { force: true });
    return modelDirectory;
  }

  async uninstall(
    manifest: LocalAsrModelManifest,
    confirmedModelId: string,
  ): Promise<void> {
    if (confirmedModelId !== manifest.id) {
      throw new ModelManagerError(
        'UNINSTALL_NOT_CONFIRMED',
        'Model removal requires an exact confirmation.',
      );
    }
    const modelDirectory = this.modelDirectory(manifest);
    try {
      const metadata = await lstat(modelDirectory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new ModelManagerError('MODEL_INVALID', 'Refusing to remove an unmanaged model path.');
      }
    } catch (reason) {
      if (reason instanceof ModelManagerError) throw reason;
      if (hasErrorCode(reason, 'ENOENT')) return;
      throw new ModelManagerError('MODEL_INVALID', 'Model directory could not be inspected.');
    }

    const trashDirectory = assertDescendant(
      this.#modelsRoot,
      path.join(this.#modelsRoot, `.deleting-${manifest.id}-${randomUUID()}`),
    );
    await rename(modelDirectory, trashDirectory);
    assertDescendant(this.#modelsRoot, trashDirectory);
    await rm(trashDirectory, { recursive: true, force: true });
  }
}
