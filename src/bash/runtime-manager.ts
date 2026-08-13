import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
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

import type { BashRuntimeManifest } from './runtime-manifest';

const execFileAsync = promisify(execFile);
const DOWNLOAD_HOSTS = new Set([
  'cdn.wasmer.io',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

type VerifiedFile = { bytes: number; sha256: string };
type DownloadFile = VerifiedFile & { url: string };

export type BashRuntimeInstallationStatus =
  | { state: 'missing'; runtimeDirectory: string }
  | { state: 'invalid'; runtimeDirectory: string; reason: string }
  | { state: 'installed'; runtimeDirectory: string; verified: boolean };

export type BashRuntimeProgress = {
  asset: 'runner' | 'bash' | 'coreutils';
  receivedBytes: number;
  totalBytes: number;
};

export class BashRuntimeManagerError extends Error {
  constructor(
    readonly code:
      | 'ARCHIVE_INVALID'
      | 'DOWNLOAD_FAILED'
      | 'EXTRACTION_FAILED'
      | 'INSTALL_CONFLICT'
      | 'PLATFORM_UNSUPPORTED'
      | 'RUNTIME_INVALID'
      | 'UNINSTALL_NOT_CONFIRMED',
    message: string,
  ) {
    super(message);
    this.name = 'BashRuntimeManagerError';
  }
}

function hasErrorCode(reason: unknown, code: string): boolean {
  return reason instanceof Error
    && 'code' in reason
    && (reason as Error & { code?: unknown }).code === code;
}

function assertDescendant(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new BashRuntimeManagerError(
      'RUNTIME_INVALID',
      'Bash runtime path escaped its managed root.',
    );
  }
  return resolvedCandidate;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyFile(filePath: string, expected: VerifiedFile): Promise<boolean> {
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
    throw new BashRuntimeManagerError(
      'DOWNLOAD_FAILED',
      'Bash runtime download URL is not trusted.',
    );
  }
  return url;
}

export function validateBashRuntimeArchiveEntries(entries: string[]): void {
  const normalized = entries
    .map((entry) => entry.trim().replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter(Boolean);
  for (const entry of normalized) {
    const segments = entry.split('/').filter(Boolean);
    if (
      entry.startsWith('/')
      || /^[a-zA-Z]:/.test(entry)
      || segments.includes('..')
    ) {
      throw new BashRuntimeManagerError(
        'ARCHIVE_INVALID',
        'Bash runtime archive contains an unsafe path.',
      );
    }
  }
  for (const required of [
    'bin/wasmer.exe',
    'bin/wasmer-headless.exe',
    'LICENSE',
    'ATTRIBUTIONS',
  ]) {
    if (!normalized.includes(required)) {
      throw new BashRuntimeManagerError(
        'ARCHIVE_INVALID',
        'Bash runtime archive is incomplete.',
      );
    }
  }
}

export class BashRuntimeManager {
  readonly #runtimesRoot: string;
  readonly #systemRoot: string;
  readonly #fetch: typeof fetch;

  constructor(options: {
    runtimesRoot: string;
    systemRoot?: string;
    fetchImplementation?: typeof fetch;
  }) {
    this.#runtimesRoot = path.resolve(options.runtimesRoot);
    this.#systemRoot = path.resolve(options.systemRoot ?? process.env.SYSTEMROOT ?? '');
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  runtimeDirectory(manifest: BashRuntimeManifest): string {
    return assertDescendant(
      this.#runtimesRoot,
      path.join(this.#runtimesRoot, manifest.id),
    );
  }

  downloadPath(
    manifest: BashRuntimeManifest,
    asset: BashRuntimeProgress['asset'],
  ): string {
    return assertDescendant(
      this.#runtimesRoot,
      path.join(this.#runtimesRoot, `.${manifest.id}.${asset}.download`),
    );
  }

  async #prepareRoot(): Promise<void> {
    await mkdir(this.#runtimesRoot, { recursive: true });
    const metadata = await lstat(this.#runtimesRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new BashRuntimeManagerError(
        'RUNTIME_INVALID',
        'The managed Bash runtime root is unsafe.',
      );
    }
  }

  #installedFiles(manifest: BashRuntimeManifest): Array<{
    relativePath: string;
    expected: VerifiedFile;
  }> {
    return [
      { relativePath: 'bin/wasmer.exe', expected: manifest.runner.files['bin/wasmer.exe'] },
      {
        relativePath: 'bin/wasmer-headless.exe',
        expected: manifest.runner.files['bin/wasmer-headless.exe'],
      },
      { relativePath: 'LICENSE', expected: manifest.runner.files.LICENSE },
      { relativePath: 'ATTRIBUTIONS', expected: manifest.runner.files.ATTRIBUTIONS },
      { relativePath: 'packages/bash.webc', expected: manifest.packages.bash.artifact },
      { relativePath: 'packages/coreutils.webc', expected: manifest.packages.coreutils.artifact },
    ];
  }

  async inspect(
    manifest: BashRuntimeManifest,
    verifyHashes = false,
  ): Promise<BashRuntimeInstallationStatus> {
    const runtimeDirectory = this.runtimeDirectory(manifest);
    try {
      const root = await lstat(this.#runtimesRoot);
      if (!root.isDirectory() || root.isSymbolicLink()) {
        return { state: 'invalid', runtimeDirectory, reason: 'unsafe-runtime-root' };
      }
    } catch (reason) {
      return hasErrorCode(reason, 'ENOENT')
        ? { state: 'missing', runtimeDirectory }
        : { state: 'invalid', runtimeDirectory, reason: 'unreadable-runtime-root' };
    }
    try {
      const directory = await lstat(runtimeDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        return { state: 'invalid', runtimeDirectory, reason: 'not-a-managed-directory' };
      }
    } catch (reason) {
      return hasErrorCode(reason, 'ENOENT')
        ? { state: 'missing', runtimeDirectory }
        : { state: 'invalid', runtimeDirectory, reason: 'unreadable-runtime-directory' };
    }

    for (const { relativePath, expected } of this.#installedFiles(manifest)) {
      const filePath = assertDescendant(
        runtimeDirectory,
        path.join(runtimeDirectory, relativePath),
      );
      try {
        const metadata = await stat(filePath);
        if (!metadata.isFile() || metadata.size !== expected.bytes) {
          return { state: 'invalid', runtimeDirectory, reason: `${relativePath}:size` };
        }
      } catch {
        return { state: 'invalid', runtimeDirectory, reason: `${relativePath}:missing` };
      }
      if (verifyHashes && !(await verifyFile(filePath, expected))) {
        return { state: 'invalid', runtimeDirectory, reason: `${relativePath}:hash` };
      }
    }
    return { state: 'installed', runtimeDirectory, verified: verifyHashes };
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
        throw new BashRuntimeManagerError(
          'DOWNLOAD_FAILED',
          'Too many Bash runtime download redirects.',
        );
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new BashRuntimeManagerError(
          'DOWNLOAD_FAILED',
          'Bash runtime redirect omitted its destination.',
        );
      }
      return this.#requestWithRedirects(
        assertDownloadUrl(new URL(location, url).toString()),
        headers,
        remainingRedirects - 1,
      );
    }
    return response;
  }

  async #downloadAsset(
    manifest: BashRuntimeManifest,
    asset: BashRuntimeProgress['asset'],
    source: DownloadFile,
    onProgress?: (progress: BashRuntimeProgress) => void,
  ): Promise<string> {
    await this.#prepareRoot();
    const destination = this.downloadPath(manifest, asset);
    let offset = 0;
    try {
      const partial = await lstat(destination);
      if (!partial.isFile() || partial.isSymbolicLink()) {
        throw new BashRuntimeManagerError(
          'DOWNLOAD_FAILED',
          'Partial Bash runtime download path is unsafe.',
        );
      }
      offset = partial.size;
    } catch (reason) {
      if (!hasErrorCode(reason, 'ENOENT')) throw reason;
    }
    if (offset > source.bytes) {
      await rm(destination, { force: true });
      offset = 0;
    }
    if (offset === source.bytes) {
      if (await verifyFile(destination, source)) return destination;
      await rm(destination, { force: true });
      offset = 0;
    }

    const headers = new Headers();
    if (offset > 0) headers.set('Range', `bytes=${offset}-`);
    const response = await this.#requestWithRedirects(
      assertDownloadUrl(source.url),
      headers,
    );
    let append = offset > 0 && response.status === 206;
    if (append) {
      const contentRange = response.headers.get('content-range');
      if (!contentRange?.startsWith(`bytes ${offset}-`)) {
        throw new BashRuntimeManagerError(
          'DOWNLOAD_FAILED',
          'Bash runtime range response is inconsistent.',
        );
      }
    } else if (response.status === 200) {
      append = false;
      offset = 0;
    } else {
      throw new BashRuntimeManagerError(
        'DOWNLOAD_FAILED',
        `Bash runtime download failed with HTTP ${response.status}.`,
      );
    }
    if (!response.body) {
      throw new BashRuntimeManagerError(
        'DOWNLOAD_FAILED',
        'Bash runtime download returned no body.',
      );
    }

    let receivedBytes = offset;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > source.bytes) {
          callback(new BashRuntimeManagerError(
            'DOWNLOAD_FAILED',
            'Bash runtime download exceeded its manifest size.',
          ));
          return;
        }
        onProgress?.({ asset, receivedBytes, totalBytes: source.bytes });
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream),
      meter,
      createWriteStream(destination, { flags: append ? 'a' : 'w' }),
    );
    if (!(await verifyFile(destination, source))) {
      await rm(destination, { force: true });
      throw new BashRuntimeManagerError(
        'DOWNLOAD_FAILED',
        'Downloaded Bash runtime asset failed verification.',
      );
    }
    return destination;
  }

  #tarPath(): string {
    if (process.platform !== 'win32' || !this.#systemRoot) {
      throw new BashRuntimeManagerError(
        'PLATFORM_UNSUPPORTED',
        'The P0 Bash runtime installer requires Windows.',
      );
    }
    return path.join(this.#systemRoot, 'System32', 'tar.exe');
  }

  async installFromFiles(
    manifest: BashRuntimeManifest,
    input: { runnerArchive: string; bashWebc: string; coreutilsWebc: string },
  ): Promise<string> {
    await this.#prepareRoot();
    if (!(await verifyFile(input.runnerArchive, manifest.runner.archive))) {
      throw new BashRuntimeManagerError('ARCHIVE_INVALID', 'Wasmer archive failed verification.');
    }
    if (!(await verifyFile(input.bashWebc, manifest.packages.bash.artifact))) {
      throw new BashRuntimeManagerError('RUNTIME_INVALID', 'Bash WebC failed verification.');
    }
    if (!(await verifyFile(input.coreutilsWebc, manifest.packages.coreutils.artifact))) {
      throw new BashRuntimeManagerError('RUNTIME_INVALID', 'Coreutils WebC failed verification.');
    }

    const existing = await this.inspect(manifest, true);
    if (existing.state === 'installed') return existing.runtimeDirectory;
    if (existing.state === 'invalid') {
      throw new BashRuntimeManagerError(
        'INSTALL_CONFLICT',
        'An invalid Bash runtime already exists and must be removed explicitly.',
      );
    }

    const tarPath = this.#tarPath();
    await access(tarPath);
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(tarPath, ['-tzf', input.runnerArchive], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      }));
    } catch {
      throw new BashRuntimeManagerError('ARCHIVE_INVALID', 'Wasmer archive could not be listed.');
    }
    validateBashRuntimeArchiveEntries(stdout.split(/\r?\n/));

    const stagingDirectory = assertDescendant(
      this.#runtimesRoot,
      path.join(this.#runtimesRoot, `.staging-${manifest.id}-${randomUUID()}`),
    );
    const destination = this.runtimeDirectory(manifest);
    await mkdir(path.join(stagingDirectory, 'packages'), { recursive: true });
    try {
      await execFileAsync(tarPath, [
        '-xzf',
        input.runnerArchive,
        '-C',
        stagingDirectory,
        'bin/wasmer.exe',
        'bin/wasmer-headless.exe',
        'LICENSE',
        'ATTRIBUTIONS',
      ], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
      await Promise.all([
        copyFile(input.bashWebc, path.join(stagingDirectory, 'packages', 'bash.webc')),
        copyFile(input.coreutilsWebc, path.join(stagingDirectory, 'packages', 'coreutils.webc')),
      ]);
      for (const { relativePath, expected } of this.#installedFiles(manifest)) {
        const filePath = assertDescendant(
          stagingDirectory,
          path.join(stagingDirectory, relativePath),
        );
        if (!(await verifyFile(filePath, expected))) {
          throw new BashRuntimeManagerError(
            'RUNTIME_INVALID',
            `Extracted Bash runtime asset failed verification: ${relativePath}.`,
          );
        }
      }
      await writeFile(
        path.join(stagingDirectory, 'installation.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          runtimeId: manifest.id,
          runnerSha256: manifest.runner.archive.sha256,
          bashSha256: manifest.packages.bash.artifact.sha256,
          coreutilsSha256: manifest.packages.coreutils.artifact.sha256,
          installedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      await rename(stagingDirectory, destination);
      return destination;
    } catch (reason) {
      if (reason instanceof BashRuntimeManagerError) throw reason;
      throw new BashRuntimeManagerError('EXTRACTION_FAILED', 'Bash runtime extraction failed.');
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  async install(
    manifest: BashRuntimeManifest,
    onProgress?: (progress: BashRuntimeProgress) => void,
  ): Promise<string> {
    const runnerArchive = await this.#downloadAsset(
      manifest,
      'runner',
      manifest.runner.archive,
      onProgress,
    );
    const bashWebc = await this.#downloadAsset(
      manifest,
      'bash',
      manifest.packages.bash.artifact,
      onProgress,
    );
    const coreutilsWebc = await this.#downloadAsset(
      manifest,
      'coreutils',
      manifest.packages.coreutils.artifact,
      onProgress,
    );
    const runtimeDirectory = await this.installFromFiles(manifest, {
      runnerArchive,
      bashWebc,
      coreutilsWebc,
    });
    await Promise.all([
      rm(this.downloadPath(manifest, 'runner'), { force: true }),
      rm(this.downloadPath(manifest, 'bash'), { force: true }),
      rm(this.downloadPath(manifest, 'coreutils'), { force: true }),
    ]);
    return runtimeDirectory;
  }

  async uninstall(
    manifest: BashRuntimeManifest,
    confirmedRuntimeId: string,
  ): Promise<void> {
    if (confirmedRuntimeId !== manifest.id) {
      throw new BashRuntimeManagerError(
        'UNINSTALL_NOT_CONFIRMED',
        'Bash runtime removal requires an exact confirmation.',
      );
    }
    const runtimeDirectory = this.runtimeDirectory(manifest);
    try {
      const metadata = await lstat(runtimeDirectory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new BashRuntimeManagerError(
          'RUNTIME_INVALID',
          'Refusing to remove an unmanaged Bash runtime path.',
        );
      }
      const marker = JSON.parse(
        await readFile(path.join(runtimeDirectory, 'installation.json'), 'utf8'),
      ) as { runtimeId?: unknown };
      if (marker.runtimeId !== manifest.id) {
        throw new BashRuntimeManagerError(
          'RUNTIME_INVALID',
          'Refusing to remove a Bash runtime without its exact installation marker.',
        );
      }
    } catch (reason) {
      if (reason instanceof BashRuntimeManagerError) throw reason;
      if (hasErrorCode(reason, 'ENOENT')) return;
      throw new BashRuntimeManagerError('RUNTIME_INVALID', 'Bash runtime could not be inspected.');
    }
    const trashDirectory = assertDescendant(
      this.#runtimesRoot,
      path.join(this.#runtimesRoot, `.deleting-${manifest.id}-${randomUUID()}`),
    );
    await rename(runtimeDirectory, trashDirectory);
    await rm(trashDirectory, { recursive: true, force: true });
  }
}
