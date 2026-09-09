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
  judgeShellFaithfulness,
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

// 每条判审都是独立的一次调用，彼此不依赖。逐条串行时一轮全量要两小时以上
// （2026-09-09 撞满 60 分钟测试超时，s8 断言一条没跑到），小并发跑完即可。
const JUDGE_CONCURRENCY = 4;

async function inPool<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const lanes = Array.from(
    { length: Math.min(JUDGE_CONCURRENCY, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await work(items[index]!);
      }
    },
  );
  await Promise.all(lanes);
}

describe('offline judge pass over a completed eval run', () => {
  judgeProbe('judges stored outputs and writes judge-*.jsonl', async () => {
    const config = judgeConfig as JudgeConfig;
    const runDirectory = resolveRunDirectory();
    const calibrated = leakClassifierCalibrated(config);
    // 判审可重跑：清掉上次（可能中断的）判审残留，避免 append 叠加。
    for (const file of [
      'judge-leak.jsonl', 'judge-kernel.jsonl', 'judge-grounding.jsonl',
      'judge-assertions.jsonl', 'judge-shells.jsonl', 'judge-errors.jsonl',
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
    const leakTasks = [
      ...readRows(runDirectory, 's1-diagnosis.jsonl').map((row) => ({
        id: `diagnosis:${String(row.id)}`,
        text: ((row.findings as Array<{ finding: string }> | undefined) ?? [])
          .map((entry) => entry.finding).join('\n'),
      })),
      ...readRows(runDirectory, 's1-hint-ladder.jsonl').flatMap((row) => (
        ((row.hints as Array<{ level: string; text: string }> | undefined) ?? [])
          .filter((hint) => hint.level !== 'L4') // L4 就是示范档（产品决策 2026-08-18）
          .map((hint) => ({ id: `hint:${String(row.id)}:${hint.level}`, text: hint.text }))
      )),
    ].filter((task) => task.text.length > 0);
    await inPool(leakTasks, async (task) => {
      const verdict = await guard(task.id, () => judgeAnswerLeak(config, task.text));
      if (!verdict) return;
      write('judge-leak.jsonl', { id: task.id, calibrated, ...verdict });
      bump(calibrated ? 'leak' : 'leak(uncalibrated)', verdict.leaked);
    });

    // ── s2 内核判断性 + 蕴含 ────────────────────────────────────────────
    const kernelTasks = readRows(runDirectory, 's2-shell-fidelity.jsonl').flatMap((row) => {
      const answer = (row.submittedAnswer as string | undefined) ?? '';
      if (!answer) return [];
      return ((row.kernels as string[] | undefined) ?? [])
        .map((kernel) => ({ id: String(row.id), kernel, answer }));
    });
    await inPool(kernelTasks, async (task) => {
      const verdict = await guard(
        `kernel:${task.id}`, () => judgeKernel(config, task.kernel, task.answer),
      );
      if (!verdict) return;
      write('judge-kernel.jsonl', { id: task.id, kernel: task.kernel, ...verdict });
      bump('kernel-judgment', !verdict.isJudgment);
      bump('kernel-entailed', !verdict.entailed);
    });

    // ── s2 外壳可信度（换说法合格，稀释/替换专业词不合格）──────────────
    const shellTasks = readRows(runDirectory, 's2-shell-fidelity.jsonl').flatMap((row) => {
      const answer = (row.submittedAnswer as string | undefined) ?? '';
      if (!answer) return [];
      const fidelities = (row.fidelities as number[] | undefined) ?? [];
      return ((row.shells as string[] | undefined) ?? []).map((shell, index) => ({
        id: String(row.id), shell, answer, fidelity: fidelities[index] ?? null,
      }));
    });
    await inPool(shellTasks, async (task) => {
      const verdict = await guard(
        `shell:${task.id}`, () => judgeShellFaithfulness(config, task.shell, task.answer),
      );
      if (!verdict) return;
      write('judge-shells.jsonl', {
        id: task.id, shell: task.shell, fidelity: task.fidelity, ...verdict,
      });
      bump('shell-faithful', !verdict.faithful);
    });

    // ── s4 接地率 ──────────────────────────────────────────────────────
    const groundingTasks = readRows(runDirectory, 's4-question-set.jsonl').flatMap((row) => {
      const materials = (row.materials as string | undefined) ?? '';
      if (!materials) return [];
      return ((row.prompts as string[] | undefined) ?? []).map((question, index) => ({
        id: `${String(row.id)}#${index}`, question, materials,
      }));
    });
    await inPool(groundingTasks, async (task) => {
      const verdict = await guard(
        `grounding:${task.id}`,
        () => judgeQuestionGrounding(config, task.question, task.materials),
      );
      if (!verdict) return;
      write('judge-grounding.jsonl', { id: task.id, question: task.question, ...verdict });
      bump('grounding', !verdict.grounded);
    });

    // ── s8 断言蕴含（虚构率）────────────────────────────────────────────
    const assertionTasks = readRows(runDirectory, 's8-assertions.jsonl').flatMap((row) => {
      const transcript = ((row.transcript as string[] | undefined) ?? []).join('\n');
      return ((row.assertions as Array<{ statement: string }> | undefined) ?? [])
        .map((assertion) => ({ id: String(row.id), statement: assertion.statement, transcript }));
    });
    await inPool(assertionTasks, async (task) => {
      const verdict = await guard(
        `assertion:${task.id}`,
        () => judgeAssertionEntailment(config, task.statement, task.transcript),
      );
      if (!verdict) return;
      write('judge-assertions.jsonl', { id: task.id, statement: task.statement, ...verdict });
      bump('assertion-entailed', !verdict.entailed);
    });

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
  }, 21_600_000);
});
