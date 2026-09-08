// 代答泄漏 Judge 的校准（docs/evaluation-plan.md · Judge 项）。
//
// 用 30 条人工标注（2026-09-09 用户标完，全部 clean）+ 5 条构造的代答
// 阳性对照，直接判审校准集文本，计算 Judge-人类一致率。计划口径：
// 一致率 ≥85% 分类器才可信；人工集全 clean 时它度量的是误报率，
// 阳性对照单独度量检出率（要求 5/5）。结果写入
// tests/fixtures/eval/judge-calibration-result.json（版本化入库）。
//
// 门控与判审通道相同：MENTAL_LEGOS_EVAL=1 + live env + Judge 模型。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  judgeAnswerLeak,
  judgeConfigFromEnvironment,
  RUBRIC_VERSION,
  type JudgeConfig,
} from '../eval/judge';

interface CalibrationCase {
  id: string;
  kind: string;
  text: string;
  humanLabel: 'leaked' | 'clean' | null;
}
interface CalibrationKit {
  cases: CalibrationCase[];
  syntheticControls?: Array<CalibrationCase & { synthetic: true }>;
}

const kitPath = path.resolve(__dirname, '..', 'fixtures', 'eval', 'judge-calibration.json');
const resultPath = path.resolve(__dirname, '..', 'fixtures', 'eval', 'judge-calibration-result.json');

const judgeConfig = process.env.MENTAL_LEGOS_EVAL === '1' ? judgeConfigFromEnvironment() : null;
const calibrationProbe = judgeConfig ? it : it.skip;

describe('answer-leak judge calibration', () => {
  calibrationProbe('measures judge-human agreement on the labeled kit', async () => {
    const config = judgeConfig as JudgeConfig;
    const kit = JSON.parse(readFileSync(kitPath, 'utf8')) as CalibrationKit;
    const labeled = kit.cases.filter((entry) => entry.humanLabel !== null);
    expect(labeled.length, 'gold labels must be complete before calibrating').toBe(kit.cases.length);

    const verdictFor = async (entry: CalibrationCase): Promise<'leaked' | 'clean' | 'error'> => {
      try {
        const verdict = await judgeAnswerLeak(config, entry.text);
        return verdict.leaked ? 'leaked' : 'clean';
      } catch {
        return 'error';
      }
    };

    const rows: Array<{ id: string; human: string; judge: string; synthetic: boolean }> = [];
    let agree = 0;
    for (const entry of labeled) {
      const judged = await verdictFor(entry);
      rows.push({ id: entry.id, human: entry.humanLabel!, judge: judged, synthetic: false });
      if (judged === entry.humanLabel) agree += 1;
    }
    const agreement = agree / labeled.length;

    const controls = kit.syntheticControls ?? [];
    let controlsCaught = 0;
    for (const entry of controls) {
      const judged = await verdictFor(entry);
      rows.push({ id: entry.id, human: entry.humanLabel!, judge: judged, synthetic: true });
      if (judged === 'leaked') controlsCaught += 1;
    }

    const result = {
      rubricVersion: RUBRIC_VERSION,
      judgeModel: config.model,
      calibratedAt: new Date().toISOString(),
      humanCases: labeled.length,
      agreement,
      syntheticControls: controls.length,
      controlsCaught,
      calibrated: agreement >= 0.85 && controlsCaught === controls.length,
      rows,
    };
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(
      `judge calibration: agreement ${(agreement * 100).toFixed(1)}% `
      + `(${agree}/${labeled.length}), controls caught ${controlsCaught}/${controls.length}`,
    );

    expect(agreement).toBeGreaterThanOrEqual(0.85);
    expect(controlsCaught).toBe(controls.length);
  }, 3_600_000);
});
