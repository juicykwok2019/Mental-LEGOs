import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AgentRunUsage {
  inputTokens: number;
  outputTokens: number;
}

interface UsageBucket {
  inputTokens: number;
  outputTokens: number;
  runs: number;
}

interface LedgerState {
  days: Record<string, UsageBucket>;
  total: UsageBucket;
}

const EMPTY_BUCKET: UsageBucket = { inputTokens: 0, outputTokens: 0, runs: 0 };
const RETAINED_DAYS = 90;

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Pull raw token usage out of an Agent SDK message stream. Providers differ in
 * which usage fields they populate, so cache reads/writes count as input and
 * anything missing counts as zero rather than failing the run.
 */
export function usageFromAgentMessages(messages: unknown[]): AgentRunUsage | null {
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.type !== 'result') continue;
    const usage = record.usage;
    if (!usage || typeof usage !== 'object') return null;
    const fields = usage as Record<string, unknown>;
    return {
      inputTokens: asCount(fields.input_tokens)
        + asCount(fields.cache_creation_input_tokens)
        + asCount(fields.cache_read_input_tokens),
      outputTokens: asCount(fields.output_tokens),
    };
  }
  return null;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Aggregate, non-sensitive token counters persisted as plain JSON in the user
 * data directory. Raw counts only — third-party pricing is uncertain, so no
 * currency estimates anywhere (PRD §24.5).
 */
export class UsageLedger {
  #filePath: string;
  #state: LedgerState;
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string, state: LedgerState) {
    this.#filePath = filePath;
    this.#state = state;
  }

  static async open(directory: string): Promise<UsageLedger> {
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, 'usage-ledger.json');
    let state: LedgerState = { days: {}, total: { ...EMPTY_BUCKET } };
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<LedgerState>;
      if (parsed && typeof parsed === 'object') {
        state = {
          days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
          total: {
            inputTokens: asCount(parsed.total?.inputTokens),
            outputTokens: asCount(parsed.total?.outputTokens),
            runs: asCount(parsed.total?.runs),
          },
        };
      }
    } catch {
      // Missing or corrupt ledger starts fresh; usage data is best-effort.
    }
    return new UsageLedger(filePath, state);
  }

  record(usage: AgentRunUsage): void {
    const key = todayKey();
    const day = this.#state.days[key] ?? { ...EMPTY_BUCKET };
    day.inputTokens += usage.inputTokens;
    day.outputTokens += usage.outputTokens;
    day.runs += 1;
    this.#state.days[key] = day;
    this.#state.total.inputTokens += usage.inputTokens;
    this.#state.total.outputTokens += usage.outputTokens;
    this.#state.total.runs += 1;

    const keys = Object.keys(this.#state.days).sort();
    for (const staleKey of keys.slice(0, Math.max(0, keys.length - RETAINED_DAYS))) {
      delete this.#state.days[staleKey];
    }

    const snapshot = JSON.stringify(this.#state);
    this.#writeChain = this.#writeChain.then(async () => {
      const temporaryPath = `${this.#filePath}.tmp`;
      await writeFile(temporaryPath, snapshot, 'utf8');
      await rename(temporaryPath, this.#filePath);
    }).catch(() => {
      // A failed ledger write must never break training.
    });
  }

  overview(): { today: UsageBucket; total: UsageBucket } {
    const today = this.#state.days[todayKey()] ?? { ...EMPTY_BUCKET };
    return { today: { ...today }, total: { ...this.#state.total } };
  }

  flush(): Promise<void> {
    return this.#writeChain;
  }
}
