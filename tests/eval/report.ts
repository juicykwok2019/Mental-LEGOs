// 评测报告基建（docs/evaluation-plan.md · 执行与判分基建）：
// JSONL 明细 + summary.json 汇总，固定四栏：指标值 / 与上轮差 / 失败样本明细 / 成本。
// 输出默认落在 .private/eval-runs/（被 .gitignore 排除），评测产物不进 Git。
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface EvalCost {
  agentCalls: number;
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
}

export interface EvalSummary {
  runId: string;
  startedAt: string;
  sampleFraction: number;
  metrics: Record<string, number>;
  /** 指标名 → 与上一轮的差值（本轮 - 上轮）；上轮缺该指标时不出现。 */
  deltas: Record<string, number>;
  failures: Record<string, string[]>;
  cost: EvalCost;
}

interface EvalRow {
  id: string;
  ok: boolean;
  [key: string]: unknown;
}

export class EvalReporter {
  readonly #runDirectory: string;
  readonly #outRoot: string;
  readonly #startedAt: number;
  readonly #sampleFraction: number;
  readonly #rows = new Map<string, EvalRow[]>();
  readonly cost: EvalCost = { agentCalls: 0, inputTokens: 0, outputTokens: 0, wallMs: 0 };

  constructor(outRoot: string, runId: string, sampleFraction: number) {
    this.#outRoot = outRoot;
    this.#runDirectory = path.join(outRoot, runId);
    this.#sampleFraction = sampleFraction;
    this.#startedAt = Date.now();
    mkdirSync(this.#runDirectory, { recursive: true });
  }

  get runDirectory(): string {
    return this.#runDirectory;
  }

  addUsage(usage: { inputTokens: number; outputTokens: number }): void {
    this.cost.agentCalls += 1;
    this.cost.inputTokens += usage.inputTokens;
    this.cost.outputTokens += usage.outputTokens;
  }

  record(suite: string, row: EvalRow): void {
    const rows = this.#rows.get(suite) ?? [];
    rows.push(row);
    this.#rows.set(suite, rows);
    appendFileSync(
      path.join(this.#runDirectory, `${suite}.jsonl`),
      `${JSON.stringify(row)}\n`,
      'utf8',
    );
  }

  rate(suite: string): { total: number; passed: number; rate: number } {
    const rows = this.#rows.get(suite) ?? [];
    const passed = rows.filter((row) => row.ok).length;
    return { total: rows.length, passed, rate: rows.length === 0 ? 0 : passed / rows.length };
  }

  finalize(runId: string): EvalSummary {
    this.cost.wallMs = Date.now() - this.#startedAt;
    const metrics: Record<string, number> = {};
    const failures: Record<string, string[]> = {};
    for (const [suite, rows] of this.#rows) {
      const passed = rows.filter((row) => row.ok).length;
      metrics[`${suite}.pass_rate`] = rows.length === 0 ? 0 : passed / rows.length;
      const failing = rows.filter((row) => !row.ok).map((row) => row.id);
      if (failing.length > 0) failures[suite] = failing;
    }

    const previous = this.#latestPreviousSummary(runId);
    const deltas: Record<string, number> = {};
    if (previous) {
      for (const [name, value] of Object.entries(metrics)) {
        const before = previous.metrics[name];
        if (typeof before === 'number') deltas[name] = value - before;
      }
    }

    const summary: EvalSummary = {
      runId,
      startedAt: new Date(this.#startedAt).toISOString(),
      sampleFraction: this.#sampleFraction,
      metrics,
      deltas,
      failures,
      cost: this.cost,
    };
    writeFileSync(
      path.join(this.#runDirectory, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    );

    // 控制台汇总表：指标 / 值 / 与上轮差。
    const lines = [
      `eval run ${runId} (sample=${this.#sampleFraction})`,
      ...Object.entries(metrics).map(([name, value]) => {
        const delta = deltas[name];
        const deltaText = delta === undefined
          ? 'n/a'
          : `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp`;
        return `  ${name}: ${(value * 100).toFixed(1)}%  (Δ ${deltaText})`;
      }),
      `  cost: ${this.cost.agentCalls} calls, `
        + `${this.cost.inputTokens} in / ${this.cost.outputTokens} out tokens, `
        + `${Math.round(this.cost.wallMs / 1000)}s`,
      ...Object.entries(failures).map(([suite, ids]) => `  FAIL ${suite}: ${ids.join(', ')}`),
    ];
    console.log(lines.join('\n'));
    return summary;
  }

  #latestPreviousSummary(currentRunId: string): EvalSummary | null {
    let candidates: string[];
    try {
      candidates = readdirSync(this.#outRoot).filter((name) => name !== currentRunId).sort();
    } catch {
      return null;
    }
    for (const name of candidates.reverse()) {
      try {
        const raw = readFileSync(path.join(this.#outRoot, name, 'summary.json'), 'utf8');
        return JSON.parse(raw) as EvalSummary;
      } catch {
        continue;
      }
    }
    return null;
  }
}

/** 确定性抽样（成本分层：冒烟轮 20%）。不使用随机数，取等距样本，至少一条。 */
export function sampleCases<T>(cases: T[], fraction: number): T[] {
  if (fraction >= 1) return cases;
  const step = Math.max(1, Math.round(1 / Math.max(fraction, 0.01)));
  const sampled = cases.filter((_, index) => index % step === 0);
  return sampled.length > 0 ? sampled : cases.slice(0, 1);
}
