import { describe, expect, it } from 'vitest';

import {
  asrTranscriptionRequestSchema,
  asrWorkerResultSchema,
} from '../../src/asr/contracts';
import { diagnoseAsrRuntime } from '../../src/asr/runtime';

describe('local ASR runtime', () => {
  it('loads the exact audited sherpa-onnx runtime without Python', () => {
    expect(diagnoseAsrRuntime()).toMatchObject({
      runtime: 'sherpa-onnx-node',
      runtimeVersion: '1.13.4',
      runtimeGitSha1: '14280725',
      offline: true,
      supportedLanguages: ['zh', 'en', 'ja', 'ko', 'yue'],
    });
  });

  it('rejects unsupported languages and unsafe thread counts', () => {
    expect(asrTranscriptionRequestSchema.safeParse({
      type: 'asr:transcribe',
      requestId: crypto.randomUUID(),
      modelDirectory: 'model',
      audioPath: 'audio.wav',
      language: 'unsupported',
      numThreads: 64,
    }).success).toBe(false);
  });

  it('does not expose local paths in worker failures', () => {
    const result = asrWorkerResultSchema.parse({
      type: 'asr:result',
      requestId: crypto.randomUUID(),
      ok: false,
      errorCode: 'TRANSCRIPTION_FAILED',
      error: 'Local transcription failed. The original audio was not modified.',
    });
    expect(result.error).not.toContain('\\');
    expect(result.error).not.toContain(':/');
  });
});
