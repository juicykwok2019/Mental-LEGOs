import {
  asrWorkerRequestSchema,
  type AsrWorkerResult,
} from './contracts';
import { diagnoseAsrRuntime, transcribeLocalWave } from './runtime';

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error('ASR worker must run as an Electron utility process.');
}

function failure(
  requestId: string,
  errorCode: NonNullable<AsrWorkerResult['errorCode']>,
  error: string,
): AsrWorkerResult {
  return {
    type: 'asr:result',
    requestId,
    ok: false,
    errorCode,
    error,
  };
}

function diagnosticMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message
    .replace(/[A-Za-z]:[\\/][^\r\n]*/g, '<local-path>')
    .replace(/\\\\[^\r\n]*/g, '<network-path>')
    .slice(0, 500);
}

parentPort.on('message', (event) => {
  const parsed = asrWorkerRequestSchema.safeParse(event.data);
  if (!parsed.success) {
    parentPort.postMessage(failure(
      'invalid-request',
      'INVALID_REQUEST',
      'ASR worker received an invalid request.',
    ));
    return;
  }

  if (parsed.data.type === 'asr:diagnose') {
    try {
      const response: AsrWorkerResult = {
        type: 'asr:result',
        requestId: parsed.data.requestId,
        ok: true,
        diagnostic: diagnoseAsrRuntime(),
      };
      parentPort.postMessage(response);
    } catch {
      parentPort.postMessage(failure(
        parsed.data.requestId,
        'RUNTIME_UNAVAILABLE',
        'The local speech runtime is unavailable.',
      ));
    }
    return;
  }

  void transcribeLocalWave(parsed.data).then((transcription) => {
    const response: AsrWorkerResult = {
      type: 'asr:result',
      requestId: parsed.data.requestId,
      ok: true,
      transcription,
    };
    parentPort.postMessage(response);
  }).catch((reason: unknown) => {
    if (process.env.MENTAL_LEGOS_ASR_DIAGNOSTIC === '1') {
      console.error(`asr_failure=${diagnosticMessage(reason)}`);
    }
    const message = reason instanceof Error ? reason.message : '';
    const errorCode = message.includes('model') || message.includes('token')
      ? 'MODEL_UNAVAILABLE'
      : message.includes('WAV') || message.includes('Audio')
        ? 'AUDIO_UNSUPPORTED'
        : 'TRANSCRIPTION_FAILED';
    parentPort.postMessage(failure(
      parsed.data.requestId,
      errorCode,
      'Local transcription failed. The original audio was not modified.',
    ));
  });
});
