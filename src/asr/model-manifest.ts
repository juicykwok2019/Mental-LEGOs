import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const fileSchema = z.object({
  bytes: z.number().int().positive(),
  sha256: hashSchema,
});

export const localAsrModelManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
  displayName: z.string().min(1).max(120),
  runtime: z.literal('sherpa-onnx-node@1.13.4'),
  languages: z.tuple([
    z.literal('zh'),
    z.literal('en'),
    z.literal('ja'),
    z.literal('ko'),
    z.literal('yue'),
  ]),
  archive: fileSchema.extend({
    url: z.url(),
  }),
  rootDirectory: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,160}$/),
  files: z.object({
    'model.int8.onnx': fileSchema,
    'tokens.txt': fileSchema,
  }),
  attribution: z.object({
    modelName: z.literal('SenseVoiceSmall'),
    modelProject: z.url(),
    runtimeProject: z.url(),
    modelLicense: z.literal('FunASR Model Open Source License Agreement'),
    commercialUseClarification: z.url(),
  }),
});

export type LocalAsrModelManifest = z.infer<typeof localAsrModelManifestSchema>;

export async function loadLocalAsrModelManifest(
  manifestPath: string,
): Promise<LocalAsrModelManifest> {
  const source = await readFile(manifestPath, 'utf8');
  return localAsrModelManifestSchema.parse(JSON.parse(source) as unknown);
}
