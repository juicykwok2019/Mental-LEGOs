// 三条未校准 Judge rubric 的构造对照（docs/evaluation-plan.md · Judge 项）。
//
// 代答泄漏分类器有 30 条人工金标签托底；内核蕴含、场景题接地、画像断言蕴含
// 三条没有，却一直在报告里当数字用。人工标注要花用户的时间，但"这条 rubric
// 到底会不会响"不需要标注就能测：喂它必然违规的构造样本，看检出率；再喂它
// 必然合格的样本，看误报率。一条从不报警的检测器和一条坏掉的检测器，输出
// 完全一样——这个测试就是用来区分这两者的。
//
// 门控与判审通道相同：MENTAL_LEGOS_EVAL=1 + live 提供方环境 + Judge 模型。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  judgeAssertionEntailment,
  judgeConfigFromEnvironment,
  judgeKernel,
  judgeQuestionGrounding,
  RUBRIC_VERSION,
  type JudgeConfig,
} from '../eval/judge';

interface KernelCase {
  id: string; kernel: string; userAnswer: string; expect?: 'not-entailed' | 'not-judgment';
}
interface GroundingCase { id: string; question: string; materials: string }
interface AssertionCase { id: string; statement: string; transcript: string[] }
interface Controls {
  kernel: { positives: KernelCase[]; negatives: KernelCase[] };
  grounding: { positives: GroundingCase[]; negatives: GroundingCase[] };
  assertion: { positives: AssertionCase[]; negatives: AssertionCase[] };
}

const kitPath = path.resolve(__dirname, '..', 'fixtures', 'eval', 'judge-rubric-controls.json');
const resultPath = path.resolve(
  __dirname, '..', 'fixtures', 'eval', 'judge-rubric-controls-result.json',
);

const judgeConfig = process.env.MENTAL_LEGOS_EVAL === '1' ? judgeConfigFromEnvironment() : null;
const controlProbe = judgeConfig ? it : it.skip;

interface Row { rubric: string; id: string; expected: 'violation' | 'clean'; got: string; ok: boolean }

describe('judge rubric synthetic controls', () => {
  controlProbe('each unvalidated rubric fires on planted violations', async () => {
    const config = judgeConfig as JudgeConfig;
    const kit = JSON.parse(readFileSync(kitPath, 'utf8')) as Controls;
    const rows: Row[] = [];

    for (const entry of kit.kernel.positives) {
      const verdict = await judgeKernel(config, entry.kernel, entry.userAnswer);
      // 构造样本各自只违反一条：要么不是判断，要么不被回答蕴含。
      const caught = entry.expect === 'not-judgment' ? !verdict.isJudgment : !verdict.entailed;
      rows.push({
        rubric: 'kernel',
        id: entry.id,
        expected: 'violation',
        got: `isJudgment=${verdict.isJudgment} entailed=${verdict.entailed}`,
        ok: caught,
      });
    }
    for (const entry of kit.kernel.negatives) {
      const verdict = await judgeKernel(config, entry.kernel, entry.userAnswer);
      rows.push({
        rubric: 'kernel',
        id: entry.id,
        expected: 'clean',
        got: `isJudgment=${verdict.isJudgment} entailed=${verdict.entailed}`,
        ok: verdict.isJudgment && verdict.entailed,
      });
    }

    for (const entry of kit.grounding.positives) {
      const verdict = await judgeQuestionGrounding(config, entry.question, entry.materials);
      rows.push({
        rubric: 'grounding',
        id: entry.id,
        expected: 'violation',
        got: `grounded=${verdict.grounded}`,
        ok: !verdict.grounded,
      });
    }
    for (const entry of kit.grounding.negatives) {
      const verdict = await judgeQuestionGrounding(config, entry.question, entry.materials);
      rows.push({
        rubric: 'grounding',
        id: entry.id,
        expected: 'clean',
        got: `grounded=${verdict.grounded} evidence=${verdict.evidence.slice(0, 40)}`,
        ok: verdict.grounded,
      });
    }

    for (const entry of kit.assertion.positives) {
      const verdict = await judgeAssertionEntailment(
        config, entry.statement, entry.transcript.join('\n'),
      );
      rows.push({
        rubric: 'assertion',
        id: entry.id,
        expected: 'violation',
        got: `entailed=${verdict.entailed}`,
        ok: !verdict.entailed,
      });
    }
    for (const entry of kit.assertion.negatives) {
      const verdict = await judgeAssertionEntailment(
        config, entry.statement, entry.transcript.join('\n'),
      );
      rows.push({
        rubric: 'assertion',
        id: entry.id,
        expected: 'clean',
        got: `entailed=${verdict.entailed}`,
        ok: verdict.entailed,
      });
    }

    const score = (rubric: string, expected: 'violation' | 'clean') => {
      const subset = rows.filter((row) => row.rubric === rubric && row.expected === expected);
      return { passed: subset.filter((row) => row.ok).length, total: subset.length };
    };
    const summary = Object.fromEntries(['kernel', 'grounding', 'assertion'].map((rubric) => [
      rubric, { detection: score(rubric, 'violation'), falseAlarm: score(rubric, 'clean') },
    ]));
    writeFileSync(resultPath, `${JSON.stringify({
      rubricVersion: RUBRIC_VERSION,
      judgeModel: config.model,
      ranAt: new Date().toISOString(),
      summary,
      rows,
    }, null, 2)}\n`, 'utf8');
    for (const [rubric, entry] of Object.entries(summary)) {
      console.log(
        `${rubric}: 检出 ${entry.detection.passed}/${entry.detection.total}, `
        + `合格样本未误报 ${entry.falseAlarm.passed}/${entry.falseAlarm.total}`,
      );
    }

    // 记录先行：先看清三条 rubric 各自什么水平，再决定哪条能进发版门禁。
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);
});
