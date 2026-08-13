import type { UtilityProcess } from 'electron';
import { utilityProcess } from 'electron';

import {
  asrWorkerResultSchema,
  type AsrDiagnosticReport,
  type AsrTranscription,
} from '../asr/contracts';

interface PendingRequest<T> {
  resolve: (result: T) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function buildWorkerEnvironment(diagnosticLogging: boolean): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  if (diagnosticLogging) environment.MENTAL_LEGOS_ASR_DIAGNOSTIC = '1';
  return environment;
}

export class AsrWorkerHost {
  readonly #worker: UtilityProcess;
  readonly #pending = new Map<string, PendingRequest<unknown>>();

  constructor(workerPath: string, diagnosticLogging = false) {
    this.#worker = utilityProcess.fork(workerPath, [], {
      env: buildWorkerEnvironment(diagnosticLogging),
      serviceName: 'Mental LEGOs Local Speech Runtime',
      stdio: 'pipe',
    });

    if (diagnosticLogging) {
      this.#worker.stdout?.on('data', (chunk: Buffer) => {
        console.log(`[asr-worker] ${chunk.toString('utf8').trimEnd()}`);
      });
      this.#worker.stderr?.on('data', (chunk: Buffer) => {
        console.error(`[asr-worker] ${chunk.toString('utf8').trimEnd()}`);
      });
    }

    this.#worker.on('message', (value: unknown) => {
      const parsed = asrWorkerResultSchema.safeParse(value);
      if (!parsed.success) return;
      const pending = this.#pending.get(parsed.data.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(parsed.data.requestId);

      if (!parsed.data.ok) {
        const errorCode = parsed.data.errorCode ?? 'TRANSCRIPTION_FAILED';
        pending.reject(new Error(
          `${errorCode}: ${parsed.data.error ?? 'Local speech request failed.'}`,
        ));
      } else {
        pending.resolve(parsed.data.diagnostic ?? parsed.data.transcription);
      }
    });

    this.#worker.on('exit', (code) => {
      const error = new Error(`ASR worker exited unexpectedly with code ${code}.`);
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.#pending.clear();
    });
  }

  #request<T>(payload: Record<string, unknown>, timeoutMilliseconds: number): Promise<T> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error('Local speech request timed out.'));
      }, timeoutMilliseconds);
      this.#pending.set(requestId, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });
      this.#worker.postMessage({ ...payload, requestId });
    });
  }

  diagnose(): Promise<AsrDiagnosticReport> {
    return this.#request({ type: 'asr:diagnose' }, 15_000);
  }

  transcribe(input: {
    modelDirectory: string;
    audioPath: string;
    language?: string;
    numThreads?: number;
  }): Promise<AsrTranscription> {
    return this.#request({
      type: 'asr:transcribe',
      modelDirectory: input.modelDirectory,
      audioPath: input.audioPath,
      language: input.language ?? 'auto',
      numThreads: input.numThreads ?? 2,
    }, 10 * 60_000);
  }

  close(): void {
    this.#worker.kill();
  }
}
