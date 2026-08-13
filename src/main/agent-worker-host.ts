import type { UtilityProcess } from 'electron';
import { utilityProcess } from 'electron';

import {
  agentDiagnosticResultSchema,
  type AgentDiagnosticResult,
} from '../agent/contracts';
import type { AgentRuntimePaths } from '../agent/runtime';

interface PendingRequest {
  resolve: (result: NonNullable<AgentDiagnosticResult['report']>) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function buildWorkerEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of [
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'PATH',
    'TEMP',
    'TMP',
    'LOCALAPPDATA',
  ]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

export class AgentWorkerHost {
  readonly #worker: UtilityProcess;
  readonly #pending = new Map<string, PendingRequest>();

  constructor(workerPath: string, diagnosticLogging = false) {
    this.#worker = utilityProcess.fork(workerPath, [], {
      env: buildWorkerEnvironment(),
      serviceName: 'Mental LEGOs Agent Runtime',
      stdio: 'pipe',
    });

    if (diagnosticLogging) {
      this.#worker.stdout?.on('data', (chunk: Buffer) => {
        console.log(`[agent-worker] ${chunk.toString('utf8').trimEnd()}`);
      });
      this.#worker.stderr?.on('data', (chunk: Buffer) => {
        console.error(`[agent-worker] ${chunk.toString('utf8').trimEnd()}`);
      });
    }

    this.#worker.on('message', (value: unknown) => {
      const parsed = agentDiagnosticResultSchema.safeParse(value);
      if (!parsed.success) return;
      const pending = this.#pending.get(parsed.data.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(parsed.data.requestId);

      if (!parsed.data.ok || !parsed.data.report) {
        pending.reject(new Error(parsed.data.error ?? 'Agent diagnostic failed.'));
      } else {
        pending.resolve(parsed.data.report);
      }
    });

    this.#worker.on('exit', (code) => {
      const error = new Error(`Agent worker exited unexpectedly with code ${code}.`);
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.#pending.clear();
    });
  }

  diagnose(paths: AgentRuntimePaths): Promise<NonNullable<AgentDiagnosticResult['report']>> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error('Agent runtime diagnostic timed out.'));
      }, 15_000);
      this.#pending.set(requestId, { resolve, reject, timeout });
      this.#worker.postMessage({
        type: 'runtime:diagnose',
        requestId,
        ...paths,
      });
    });
  }

  close(): void {
    this.#worker.kill();
  }
}
