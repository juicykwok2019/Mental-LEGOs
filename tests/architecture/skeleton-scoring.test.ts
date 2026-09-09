// Suite 7 骨架判分器的单元测试（docs/evaluation-plan.md）。
import { describe, expect, it } from 'vitest';

import {
  extractSkeletonReferences,
  scoreReferenceRetention,
  scoreTimeBudget,
  validateSkeletonReferences,
} from '../eval/skeleton-scoring';

const OUTLINE = [
  '开场钩子（1 分钟）：从"市面上见不到"的质疑切入',
  '要点一（3 分钟）：引用模块【把没销量翻译回业务模式】，原话开头"我们产品面对的垂类市场……"',
  '要点二（3 分钟）：引用模块【三组数字作证】，用经销商、用户、营业额三个数',
  '要点三（2 分钟）：【缺积木：竞品对比的差异化说法】',
  '收尾落点（1 分钟）：回到"见不到不等于不存在"',
].join('\n');

describe('extractSkeletonReferences', () => {
  it('separates module references from missing-brick annotations', () => {
    const references = extractSkeletonReferences(OUTLINE);
    expect(references.modules).toEqual(['把没销量翻译回业务模式', '三组数字作证']);
    expect(references.missingBricks).toEqual(['竞品对比的差异化说法']);
  });

  it('deduplicates repeated references and handles both colon styles', () => {
    const outline = '【模块甲】…再次【模块甲】…【缺积木:开场自我介绍】';
    const references = extractSkeletonReferences(outline);
    expect(references.modules).toEqual(['模块甲']);
    expect(references.missingBricks).toEqual(['开场自我介绍']);
  });
});

describe('validateSkeletonReferences (引用集合校验)', () => {
  const library = ['把没销量翻译回业务模式', '三组数字作证', '化解质疑后锚定个人贡献'];

  it('passes when every reference exists in the library', () => {
    const validation = validateSkeletonReferences(OUTLINE, library);
    expect(validation.ok).toBe(true);
    expect(validation.unknown).toHaveLength(0);
  });

  it('fails on an invented module (the exact risk Suite 7 guards)', () => {
    const outline = '要点一：引用模块【行业大势三段论】展开';
    const validation = validateSkeletonReferences(outline, library);
    expect(validation.ok).toBe(false);
    expect(validation.unknown).toEqual(['行业大势三段论']);
  });

  it('fails an outline with no module references at all', () => {
    expect(validateSkeletonReferences('全是新写的内容，没有引用。', library).ok).toBe(false);
  });

  it('ignores the speech title restated in brackets when whitelisted', () => {
    const outline = '【季度经营会：管道质量汇报】\n要点：引用模块【三组数字作证】';
    const validation = validateSkeletonReferences(outline, library, ['季度经营会：管道质量汇报']);
    expect(validation.ok).toBe(true);
    expect(validation.references).toEqual(['三组数字作证']);
  });
});

describe('scoreTimeBudget (时间预算加和)', () => {
  it('sums per-section budgets and accepts within ±10%', () => {
    const report = scoreTimeBudget(OUTLINE, 10);
    expect(report.sections).toEqual([1, 3, 3, 2, 1]);
    expect(report.totalMinutes).toBe(10);
    expect(report.withinTolerance).toBe(true);
  });

  it('rejects a sum outside tolerance', () => {
    expect(scoreTimeBudget(OUTLINE, 15).withinTolerance).toBe(false);
  });

  it('parses ranges, seconds, and 分半', () => {
    const outline = '开场（90 秒）\n要点（2-3 分钟）\n收尾（1 分半）';
    const report = scoreTimeBudget(outline, 5.5);
    expect(report.totalMinutes).toBeCloseTo(1.5 + 2.5 + 1.5, 5);
    expect(report.withinTolerance).toBe(true);
  });

  it('drops a stated total line instead of double counting', () => {
    const outline = '总时长 10 分钟\n开场 2 分钟\n主体 6 分钟\n收尾 2 分钟';
    const report = scoreTimeBudget(outline, 10);
    expect(report.totalMinutes).toBe(10);
    expect(report.withinTolerance).toBe(true);
  });

  it('ignores a whole-talk duration repeated in the title and the total line', () => {
    // 2026-09-09 全量轮里真实出现的形状：标题、各节、结尾合计三处都写了时长，
    // 只剔除一个重复值不够，整份骨架被误判为 20 分钟。
    const outline = [
      '# 演讲骨架：垂类 SaaS 的交付确定性（5 分钟）',
      '## 一、开场钩子（0:00–0:40，40 秒）',
      '## 二、要点 1：大厂进来又出去（0:40–1:40，60 秒）',
      '## 三、要点 2：交付确定性（1:40–3:10，90 秒）',
      '## 四、要点 3：风险由条款兜底（3:10–4:20，70 秒）',
      '## 五、收尾落点（4:20–5:00，40 秒）',
      '- 时间合计：40+60+90+70+40 = 300 秒 = 5 分钟。',
    ].join('\n');
    const report = scoreTimeBudget(outline, 5);
    expect(report.totalMinutes).toBeCloseTo(5, 5);
    expect(report.sections).toHaveLength(5);
    expect(report.withinTolerance).toBe(true);
  });

  it('does not let a title-only duration masquerade as a budget', () => {
    // 正文一节都没标时间时，加和恰好等于目标只是因为标题被算了进来。
    const report = scoreTimeBudget('# 季度经营会汇报骨架（5 分钟）\n一、开场\n二、要点\n三、收尾', 5);
    expect(report.sections).toHaveLength(1);
    expect(report.withinTolerance).toBe(true);
  });

  it('resolves the two-value ambiguity toward the target', () => {
    // "总时长 5 分钟 + 正文 5 分钟"：目标 5 时按剔除总行解释——
    const asTotal = scoreTimeBudget('总时长 5 分钟\n正文 5 分钟', 5);
    expect(asTotal.totalMinutes).toBe(5);
    expect(asTotal.withinTolerance).toBe(true);
    // ——目标 10 时按两段相加解释，两种歧义都不误伤。
    const asSections = scoreTimeBudget('上半场 5 分钟\n下半场 5 分钟', 10);
    expect(asSections.totalMinutes).toBe(10);
    expect(asSections.withinTolerance).toBe(true);
  });
});

describe('scoreReferenceRetention (变换后引用保持)', () => {
  it('reports full retention when the backbone survives', () => {
    const after = '压缩版：【把没销量翻译回业务模式】+【三组数字作证】收尾';
    const report = scoreReferenceRetention(OUTLINE, after);
    expect(report.retentionRate).toBe(1);
    expect(report.lost).toHaveLength(0);
  });

  it('reports losses when a transform drops a module', () => {
    const after = '换听众版：只保留【三组数字作证】';
    const report = scoreReferenceRetention(OUTLINE, after);
    expect(report.retentionRate).toBe(0.5);
    expect(report.lost).toEqual(['把没销量翻译回业务模式']);
  });
});
