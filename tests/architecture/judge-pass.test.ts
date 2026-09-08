// Judge 离线判审通道（docs/evaluation-plan.md · Judge 项）。
//
// 对一个已完成评测轮的 JSONL 存量输出做语义判审，不重跑产品流程：
//   - s1 教练输出的代答泄漏分类（未校准前只作参考，结果标 uncalibrated）；
//   - s2 提炼内核的判断性+蕴含（发明立场零容忍）；
//   - s4 场景题的接地率（能否标注依据的材料句）；
//   - s8 画像断言的转写蕴含（虚构率必须为 0，违例进人工复核清单）。
// 结果写回该轮目录的 judge-*.jsonl 与 judge-summary.json。
//
// 门控：MENTAL_LEGOS_EVAL=1 + live 提供方环境 + Judge 模型
// （MENTAL_LEGOS_EVAL_JUDGE_MODEL，缺省 kimi-k2.6，必须不同于被测模型）。
// MENTAL_LEGOS_EVAL_RUN 指定轮次目录名，缺省取最新一轮。
import { readdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  judgeAnswerLeak,
  judgeAssertionEntailment,
  judgeConfigFromEnvironment,
  judgeKernel,
  judgeQuestionGrounding,
  RUBRIC_VERSION,
  type JudgeConfig,
} from '../eval/judge';

const repositoryRoot = path.resolve('.');
const outRoot = process.env.MENTAL_LEGOS_EVAL_OUT
  ?? path.join(repositoryRoot, '.private', 'eval-runs');

const judgeConfig = process.env.MENTAL_LEGOS_EVAL === '1' ? judgeConfigFromEnvironment() : null;
const judgeProbe = judgeConfig ? it : it.skip;

function resolveRunDirectory(): string {
  const requested = process.env.MENTAL_LEGOS_EVAL_RUN;
  if (requested) return path.join(outRoot, requested);
  const candidates = readdirSync(outRoot).sort().reverse();
  if (candidates.length === 0) throw new Error('No eval runs found to judge.');
  return path.join(outRoot, candidates[0]!);
}

function readRows(runDirectory: string, file: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path.join(runDirectory, file), 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** 分类器是否已过校准（同 rubric 版本 + 同 Judge 模型 + 一致率达标）。 */
function leakClassifierCalibrated(config: JudgeConfig): boolean {
  try {
    const result = JSON.parse(readFileSync(
      path.join(repositoryRoot, 'tests', 'fixtures', 'eval', 'judge-calibration-result.json'),
      'utf8',
    )) as { rubricVersion?: string; judgeModel?: string; calibrated?: boolean };
    return result.calibrated === true
      && result.rubricVersion === RUBRIC_VERSION
      && result.judgeModel === config.model;
  } catch {
    return false;
  }
}

describe('offline judge pass over a completed eval run', () => {
  judgeProbe('judges stored outputs and writes judge-*.jsonl', async () => {
    const config = judgeConfig as JudgeConfig;
    const runDirectory = resolveRunDirectory();
    const calibrated = leakClassifierCalibrated(config);
    // 判审可重跑：清掉上次（可能中断的）判审残留，避免 append 叠加。
    for (const file of [
      'judge-leak.jsonl', 'judge-kernel.jsonl', 'judge-grounding.jsonl',
      'judge-assertions.jsonl', 'judge-errors.jsonl',
    ]) rmSync(path.join(runDirectory, file), { force: true });
    const write = (file: string, row: Record<string, unknown>) => {
      appendFileSync(path.join(runDirectory, file), `${JSON.stringify(row)}\n`, 'utf8');
    };
    // 单条判审失败（网络、Judge 输出修不好的坏 JSON）不废整趟。
    let judgeErrors = 0;
    const guard = async <T>(id: string, work: () => Promise<T>): Promise<T | null> => {
      try {
        return await work();
      } catch (reason) {
        judgeErrors += 1;
        write('judge-errors.jsonl', {
          id, error: reason instanceof Error ? reason.message : String(reason),
        });
        return null;
      }
    };
    const summary: Record<string, { total: number; flagged: number }> = {};
    const bump = (name: string, flagged: boolean) => {
      summary[name] ??= { total: 0, flagged: 0 };
      summary[name].total += 1;
      if (flagged) summary[name].flagged += 1;
    };

    // ── s1 代答泄漏分类（诊断 + 提示阶梯；未校准，仅参考）─────────────
    for (const row of readRows(runDirectory, 's1-diagnosis.jsonl')) {
      const findings = (row.findings as Array<{ finding: string }> | undefined) ?? [];
      if (findings.length === 0) continue;
      const text = findings.map((entry) => entry.finding).join('\n');
      const verdict = await guard(`diagnosis:${String(row.id)}`, () => judgeAnswerLeak(config, text));
      if (!verdict) continue;
      write('judge-leak.jsonl', {
        id: `diagnosis:${String(row.id)}`, calibrated, ...verdict,
      });
      bump(calibrated ? 'leak' : 'leak(uncalibrated)', verdict.leaked);
    }
    for (const row of readRows(runDirectory, 's1-hint-ladder.jsonl')) {
      const hints = (row.hints as Array<{ level: string; text: string }> | undefined) ?? [];
      for (const hint of hints) {
        if (hint.level === 'L4') continue; // L4 就是示范档（产品决策 2026-08-18）
        const verdict = await guard(
          `hint:${String(row.id)}:${hint.level}`, () => judgeAnswerLeak(config, hint.text),
        );
        if (!verdict) continue;
        write('judge-leak.jsonl', {
          id: `hint:${String(row.id)}:${hint.level}`, calibrated, ...verdict,
        });
        bump(calibrated ? 'leak' : 'leak(uncalibrated)', verdict.leaked);
      }
    }

    // ── s2 内核判断性 + 蕴含 ────────────────────────────────────────────
    for (const row of readRows(runDirectory, 's2-shell-fidelity.jsonl')) {
      const kernels = (row.kernels as string[] | undefined) ?? [];
      const answer = (row.submittedAnswer as string | undefined) ?? '';
      if (kernels.length === 0 || !answer) continue;
      for (const kernel of kernels) {
        const verdict = await guard(`kernel:${String(row.id)}`, () => judgeKernel(config, kernel, answer));
        if (!verdict) continue;
        write('judge-kernel.jsonl', { id: String(row.id), kernel, ...verdict });
        bump('kernel-judgment', !verdict.isJudgment);
        bump('kernel-entailed', !verdict.entailed);
      }
    }

    // ── s4 接地率 ──────────────────────────────────────────────────────
    for (const row of readRows(runDirectory, 's4-question-set.jsonl')) {
      const prompts = (row.prompts as string[] | undefined) ?? [];
      const materials = (row.materials as string | undefined) ?? '';
      if (prompts.length === 0 || !materials) continue;
      for (const [index, question] of prompts.entries()) {
        const verdict = await guard(
          `grounding:${String(row.id)}#${index}`,
          () => judgeQuestionGrounding(config, question, materials),
        );
        if (!verdict) continue;
        write('judge-grounding.jsonl', {
          id: `${String(row.id)}#${index}`, question, ...verdict,
        });
        bump('grounding', !verdict.grounded);
      }
    }

    // ── s8 断言蕴含（虚构率）────────────────────────────────────────────
    for (const row of readRows(runDirectory, 's8-assertions.jsonl')) {
      const assertions = (row.assertions as Array<{ statement: string }> | undefined) ?? [];
      const transcript = ((row.transcript as string[] | undefined) ?? []).join('\n');
      for (const assertion of assertions) {
        const verdict = await guard(
          `assertion:${String(row.id)}`,
          () => judgeAssertionEntailment(config, assertion.statement, transcript),
        );
        if (!verdict) continue;
        write('judge-assertions.jsonl', {
          id: String(row.id), statement: assertion.statement, ...verdict,
        });
        bump('assertion-entailed', !verdict.entailed);
      }
    }

    const judged = Object.values(summary).reduce((total, entry) => total + entry.total, 0);
    writeFileSync(
      path.join(runDirectory, 'judge-summary.json'),
      `${JSON.stringify({
        rubricVersion: RUBRIC_VERSION,
        judgeModel: config.model,
        judgedAt: new Date().toISOString(),
        judgeErrors,
        summary,
      }, null, 2)}\n`,
      'utf8',
    );
    console.log(`judge pass (${config.model}, rubric ${RUBRIC_VERSION}) over ${runDirectory}`);
    for (const [name, entry] of Object.entries(summary)) {
      console.log(`  ${name}: flagged ${entry.flagged}/${entry.total}`);
    }
    expect(judged).toBeGreaterThan(0);
  }, 3_600_000);
});
