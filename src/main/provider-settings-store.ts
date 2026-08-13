import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { credentialStorageSchema } from '../shared/contracts';
import { providerProfileSchema } from '../shared/providers';

const storedProviderSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  profile: providerProfileSchema,
  storage: credentialStorageSchema,
  credentialHint: z.string().regex(/^••••.{1,4}$/u),
});

export type StoredProviderSettings = z.infer<typeof storedProviderSettingsSchema>;

export class ProviderSettingsStore {
  readonly #directory: string;
  readonly #filePath: string;

  constructor(directory: string) {
    this.#directory = path.resolve(directory);
    this.#filePath = path.join(this.#directory, 'provider-settings.json');
  }

  async load(): Promise<StoredProviderSettings | null> {
    try {
      const metadata = await lstat(this.#filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('Provider settings path is unsafe.');
      }
      const value = storedProviderSettingsSchema.parse(
        JSON.parse(await readFile(this.#filePath, 'utf8')) as unknown,
      );
      if (value.storage === 'session') {
        await this.clear();
        return null;
      }
      return value;
    } catch (reason) {
      if (
        reason instanceof Error
        && 'code' in reason
        && (reason as NodeJS.ErrnoException).code === 'ENOENT'
      ) return null;
      throw reason;
    }
  }

  async save(settings: StoredProviderSettings): Promise<void> {
    const value = storedProviderSettingsSchema.parse(settings);
    await mkdir(this.#directory, { recursive: true });
    const directoryMetadata = await lstat(this.#directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new Error('Provider settings directory is unsafe.');
    }
    const temporaryPath = path.join(
      this.#directory,
      `.provider-settings-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await rename(temporaryPath, this.#filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async clear(): Promise<void> {
    await rm(this.#filePath, { force: true });
  }
}
