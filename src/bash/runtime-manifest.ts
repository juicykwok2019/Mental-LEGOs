import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const verifiedFileSchema = z.object({
  bytes: z.number().int().positive(),
  sha256: hashSchema,
});
const downloadSchema = verifiedFileSchema.extend({
  url: z.url(),
});

export const bashRuntimeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
  displayName: z.string().min(1).max(120),
  platform: z.literal('win32'),
  architecture: z.literal('x64'),
  runner: z.object({
    name: z.literal('Wasmer'),
    version: z.literal('7.2.1'),
    archive: downloadSchema,
    files: z.object({
      'bin/wasmer.exe': verifiedFileSchema,
      'bin/wasmer-headless.exe': verifiedFileSchema,
      LICENSE: verifiedFileSchema,
      ATTRIBUTIONS: verifiedFileSchema,
    }),
    project: z.url(),
    license: z.literal('MIT'),
  }),
  packages: z.object({
    bash: z.object({
      name: z.literal('wasmer/bash'),
      version: z.literal('1.0.25'),
      artifact: downloadSchema,
      registry: z.url(),
      runtimeReportedLicense: z.literal('GPLv3+'),
    }),
    coreutils: z.object({
      name: z.literal('wasmer/coreutils'),
      version: z.literal('1.0.25'),
      artifact: downloadSchema,
      registry: z.url(),
      license: z.literal('MIT'),
      unpackedManifest: verifiedFileSchema,
    }),
    python: z.object({
      name: z.literal('python/python'),
      version: z.literal('3.13.5'),
      artifact: downloadSchema,
      registry: z.url(),
      license: z.literal('PSF-2.0'),
      unpackedManifest: verifiedFileSchema,
    }),
  }),
});

export type BashRuntimeManifest = z.infer<typeof bashRuntimeManifestSchema>;

export async function loadBashRuntimeManifest(
  manifestPath: string,
): Promise<BashRuntimeManifest> {
  const source = await readFile(manifestPath, 'utf8');
  return bashRuntimeManifestSchema.parse(JSON.parse(source) as unknown);
}
