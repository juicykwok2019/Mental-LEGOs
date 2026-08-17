import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { z } from 'zod';

import { FieldCodec, openWithPassword, sealWithPassword, type SealedBundle } from './crypto';
import type { ProductDatabase } from './product-database';

// Encrypted export and restore (PRD §23.4, FR-012). The bundle carries decrypted
// content sealed with a user password so it can be restored on an install with a
// different local data key. Field-level ciphertext never leaves as-is.

const EXPORT_FORMAT = 'mental-legos-export';
const EXPORT_VERSION = 1;

const EXPORT_TABLES = [
  'profile_seed',
  'scenarios',
  'sources',
  'source_segments',
  'knowledge_items',
  'profile_assertions',
  'questions',
  'attempts',
  'diagnostics',
  'lego_modules',
  'lego_versions',
  'module_links',
  'mastery_states',
  'practice_events',
  'consent_events',
  'audit_events',
] as const;

const ENCRYPTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  profile_seed: ['direction_enc', 'current_work_enc', 'target_scenarios_enc', 'material_enc'],
  source_segments: ['content_enc'],
  knowledge_items: ['content_enc'],
  profile_assertions: ['statement_enc'],
  questions: ['prompt_enc'],
  attempts: ['response_enc'],
  diagnostics: ['finding_enc', 'evidence_quote_enc'],
  lego_versions: ['payload_enc'],
};

const exportManifestSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  schemaVersion: z.number().int().positive(),
  exportedAt: z.string().datetime({ offset: true }),
  tableCounts: z.record(z.string(), z.number().int().nonnegative()),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type ExportManifest = z.infer<typeof exportManifestSchema>;

const exportEnvelopeSchema = z.object({
  manifest: exportManifestSchema,
  sealed: z.object({
    salt: z.string(),
    iv: z.string(),
    tag: z.string(),
    payload: z.string(),
  }),
});
export type ExportEnvelope = z.infer<typeof exportEnvelopeSchema>;

export function exportDatabase(
  database: ProductDatabase,
  password: string,
  exportedAt = new Date().toISOString(),
): ExportEnvelope {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const tableCounts: Record<string, number> = {};
  for (const table of EXPORT_TABLES) {
    const rows = database.dumpTable(table);
    const encryptedColumns = ENCRYPTED_COLUMNS[table] ?? [];
    tables[table] = rows.map((row) => {
      const copy: Record<string, unknown> = { ...row };
      for (const column of encryptedColumns) {
        const value = copy[column];
        if (typeof value === 'string' && FieldCodec.isEncrypted(value)) {
          copy[column] = database.decryptField(value);
        }
      }
      return copy;
    });
    tableCounts[table] = rows.length;
  }
  const content = Buffer.from(JSON.stringify(tables), 'utf8');
  const sealed: SealedBundle = sealWithPassword(gzipSync(content), password);
  const manifest = exportManifestSchema.parse({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    schemaVersion: database.migratedVersion,
    exportedAt,
    tableCounts,
    contentSha256: createHash('sha256').update(content).digest('hex'),
  });
  return { manifest, sealed };
}

export function restoreDatabase(
  database: ProductDatabase,
  envelope: ExportEnvelope,
  password: string,
): ExportManifest {
  const parsed = exportEnvelopeSchema.parse(envelope);
  if (parsed.manifest.schemaVersion > database.migratedVersion) {
    throw new Error('Export was created by a newer schema; update the app before restoring.');
  }
  for (const table of EXPORT_TABLES) {
    if (database.dumpTable(table).length > 0) {
      throw new Error('Restore requires an empty database.');
    }
  }
  const content = gunzipSync(openWithPassword(parsed.sealed, password));
  const digest = createHash('sha256').update(content).digest('hex');
  if (digest !== parsed.manifest.contentSha256) {
    throw new Error('Export content hash mismatch; the bundle is corrupt.');
  }
  const tables = z.record(z.string(), z.array(z.record(z.string(), z.unknown())))
    .parse(JSON.parse(content.toString('utf8')));
  for (const table of EXPORT_TABLES) {
    const rows = tables[table] ?? [];
    const encryptedColumns = ENCRYPTED_COLUMNS[table] ?? [];
    for (const row of rows) {
      const copy: Record<string, unknown> = { ...row };
      for (const column of encryptedColumns) {
        const value = copy[column];
        if (typeof value === 'string') {
          copy[column] = database.encryptField(value);
        }
      }
      database.restoreRow(table, copy);
    }
  }
  database.rebuildSearchIndex();
  return parsed.manifest;
}
