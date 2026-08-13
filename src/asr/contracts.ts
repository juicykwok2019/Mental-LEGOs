import { z } from 'zod';

export const senseVoiceLanguages = ['auto', 'zh', 'en', 'ja', 'ko', 'yue'] as const;
export const senseVoiceLanguageSchema = z.enum(senseVoiceLanguages);

export const asrDiagnosticRequestSchema = z.object({
  type: z.literal('asr:diagnose'),
  requestId: z.string().uuid(),
});

export const asrTranscriptionRequestSchema = z.object({
  type: z.literal('asr:transcribe'),
  requestId: z.string().uuid(),
  modelDirectory: z.string().min(1),
  audioPath: z.string().min(1),
  language: senseVoiceLanguageSchema.default('auto'),
  numThreads: z.number().int().min(1).max(8).default(2),
});

export const asrWorkerRequestSchema = z.discriminatedUnion('type', [
  asrDiagnosticRequestSchema,
  asrTranscriptionRequestSchema,
]);

export type AsrWorkerRequest = z.infer<typeof asrWorkerRequestSchema>;

export const asrDiagnosticReportSchema = z.object({
  runtime: z.literal('sherpa-onnx-node'),
  runtimeVersion: z.literal('1.13.4'),
  runtimeGitSha1: z.string().min(1),
  model: z.literal('SenseVoiceSmall int8 2024-07-17'),
  offline: z.literal(true),
  supportedLanguages: z.tuple([
    z.literal('zh'),
    z.literal('en'),
    z.literal('ja'),
    z.literal('ko'),
    z.literal('yue'),
  ]),
});

export const asrTranscriptionSchema = z.object({
  text: z.string(),
  language: z.string(),
  emotion: z.string(),
  event: z.string(),
  tokens: z.array(z.string()),
  timestamps: z.array(z.number()),
  durations: z.array(z.number()),
  audioDurationSeconds: z.number().nonnegative(),
  elapsedMilliseconds: z.number().nonnegative(),
  realTimeFactor: z.number().nonnegative(),
});

export const asrWorkerResultSchema = z.object({
  type: z.literal('asr:result'),
  requestId: z.string().min(1),
  ok: z.boolean(),
  diagnostic: asrDiagnosticReportSchema.optional(),
  transcription: asrTranscriptionSchema.optional(),
  errorCode: z.enum([
    'INVALID_REQUEST',
    'RUNTIME_UNAVAILABLE',
    'MODEL_UNAVAILABLE',
    'AUDIO_UNSUPPORTED',
    'TRANSCRIPTION_FAILED',
  ]).optional(),
  error: z.string().optional(),
});

export type AsrDiagnosticReport = z.infer<typeof asrDiagnosticReportSchema>;
export type AsrTranscription = z.infer<typeof asrTranscriptionSchema>;
export type AsrWorkerResult = z.infer<typeof asrWorkerResultSchema>;
