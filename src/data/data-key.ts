import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { runCredentialHelper } from '../main/credential-vault';
import { generateDataKey, StaticDataKeyProvider, type DataKeyProvider } from './crypto';

// The database master key lives in Windows Credential Manager (itself DPAPI
// protected per user) via the existing native vault helper (PRD §21.5). Only the
// key *name* is stored beside the database; the marker file carries no secret.

const markerSchema = z.object({ keyId: z.string().uuid() });

const KEY_KIND = 'data-key';
const MARKER_FILE = 'data-key.json';

export async function loadVaultDataKeyProvider(options: {
  vaultExecutablePath: string;
  databaseDirectory: string;
}): Promise<DataKeyProvider> {
  await mkdir(options.databaseDirectory, { recursive: true });
  const markerPath = path.join(options.databaseDirectory, MARKER_FILE);

  let keyId: string | null;
  try {
    keyId = markerSchema.parse(JSON.parse(await readFile(markerPath, 'utf8'))).keyId;
  } catch {
    keyId = null;
  }

  if (keyId) {
    const stored = await runCredentialHelper({
      executablePath: options.vaultExecutablePath,
      command: 'read',
      target: `MentalLEGOs/${KEY_KIND}/${keyId}`,
    });
    const key = Buffer.from(stored.trim(), 'base64url');
    if (key.length !== 32) {
      throw new Error('Stored data key is malformed; the database cannot be opened.');
    }
    return new StaticDataKeyProvider(key);
  }

  const newKeyId = randomUUID();
  const key = generateDataKey();
  await runCredentialHelper({
    executablePath: options.vaultExecutablePath,
    command: 'write',
    target: `MentalLEGOs/${KEY_KIND}/${newKeyId}`,
    secret: key.toString('base64url'),
  });
  await writeFile(markerPath, `${JSON.stringify({ keyId: newKeyId })}\n`, 'utf8');
  return new StaticDataKeyProvider(key);
}
