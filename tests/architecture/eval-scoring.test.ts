// Suite 1/2 规则判分库的单元测试（docs/evaluation-plan.md）。
// 每个判分函数都要有正/反两侧样本——判分器自己失真，整个评测就失真。
import { describe, expect, it } from 'vitest';

import {
  normalizeForMatch,
  scoreDemonstrationLeakage,
  scoreDiagnosisGrounding,
  scoreNovelEnglish,
  scoreHintLadder,
  scoreQuestionLeakage,
  scoreShellFidelity,
  scoreShellLength,
  summarizeRate,
  SHELL_FIDELITY_THRESHOLD,
} from '../eval/scoring';

describe('normalizeForMatch', () => {
  it('strips punctuation, whitespace, and case so ASR noise does not matter', () => {
    expect(normalizeForMatch('我们 面对的，垂类市场！')).toBe('我们面对的垂类市场');
    expect(normalizeForMatch('Local-First APP')).toBe('localfirstapp');
  });
});

describe('scoreDiagnosisGrounding (Suite 1 诊断引用率)', () => {
  const userResponse = '我们产品面对的垂类市场，一般不会在大众渠道上见到，所以看不到不代表卖不动。';

  it('accepts findings that quote the user verbatim', () => {
    const diagnosis = [
      '你说「看不到不代表卖不动」，这个翻译很准，但缺少下一步去向。',
      '「垂类市场」的判断成立，不过没有给出规模证据。',
    ].join('\n');
    const report = scoreDiagnosisGrounding(diagnosis, userResponse);
    expect(report.findings).toHaveLength(2);
    expect(report.findings.every((finding) => finding.grounded)).toBe(true);
    expect(report.groundedRate).toBe(1);
  });

  it('tolerates punctuation differences between quote and transcript', () => {
    const diagnosis = '你提到「一般不会在大众渠道上见到」，证据还是空的。';
    expect(scoreDiagnosisGrounding(diagnosis, userResponse).groundedRate).toBe(1);
  });

  it('rejects findings without any quote', () => {
    const diagnosis = '整体结构松散，观点不突出，建议加强逻辑。';
    const report = scoreDiagnosisGrounding(diagnosis, userResponse);
    expect(report.findings[0]?.hasQuote).toBe(false);
    expect(report.groundedRate).toBe(0);
  });

  it('rejects fabricated quotes the user never said', () => {
    const diagnosis = '你说「我们的销量增长了三倍」，这个说法缺乏证据。';
    const report = scoreDiagnosisGrounding(diagnosis, userResponse);
    expect(report.findings[0]?.hasQuote).toBe(true);
    expect(report.findings[0]?.grounded).toBe(false);
  });

  it('caps findings at five lines, mirroring the runtime', () => {
    const diagnosis = Array.from({ length: 7 }, (_, i) => `第${i}条「垂类市场」观察。`).join('\n');
    expect(scoreDiagnosisGrounding(diagnosis, userResponse).findings).toHaveLength(5);
  });

  it('groups numbered blocks so headings do not count as quote-less findings', () => {
    // 真实模型输出形态：前言 + 加粗编号标题行 + 内容行。
    const diagnosis = [
      '基于你的回答，以下是诊断要点：',
      '**1. 立场表达**',
      '你说「看不到不代表卖不动」，翻译得准，但缺下一步。',
      '**2. 证据缺口**',
      '「垂类市场」的判断成立，但没有规模证据。',
    ].join('\n');
    const report = scoreDiagnosisGrounding(diagnosis, userResponse);
    expect(report.findings).toHaveLength(2);
    expect(report.groundedRate).toBe(1);
  });
});

describe('scoreQuestionLeakage (Suite 1 代答泄漏)', () => {
  it('passes a clean question', () => {
    const question = '投资人质疑"市面上根本见不到你们的产品"，你会如何当场回应？';
    expect(scoreQuestionLeakage(question).leaked).toBe(false);
  });

  it('flags demonstration phrasing', () => {
    const question = '你会如何回应？你可以这样说：我们走的是垂类渠道……';
    const report = scoreQuestionLeakage(question);
    expect(report.leaked).toBe(true);
    expect(report.reasons.join()).toContain('措辞');
  });

  it('flags outline scaffolding', () => {
    const question = '请回应质疑。\n1. 先承认现象\n2. 再归因渠道\n3. 最后给证据';
    expect(scoreQuestionLeakage(question).leaked).toBe(true);
  });

  it('flags over-length questions', () => {
    const question = `请回应：${'很长的背景铺垫'.repeat(60)}`;
    const report = scoreQuestionLeakage(question);
    expect(report.leaked).toBe(true);
    expect(report.reasons.join()).toContain('上限');
  });

  it('does not confuse a single numbered reference with an outline', () => {
    const question = '材料第 2 段提到融资节奏，你怎么看其中的取舍？';
    expect(scoreQuestionLeakage(question).leaked).toBe(false);
  });
});

describe('scoreNovelEnglish (Suite 1 白话度)', () => {
  const question = '董事会问你为什么 pipeline 数字好看却 miss 了？';
  const answer = '我们的 pipeline 有质量分层，我只看客户立没立项。';

  it('flags English jargon the user never said', () => {
    const report = scoreNovelEnglish('替代方案提出过于 abrupt，结构断层明显。', [question, answer]);
    expect(report.ok).toBe(false);
    expect(report.novelWords).toEqual(['abrupt']);
  });

  it('allows English quoted from the user or the question', () => {
    expect(scoreNovelEnglish('你说 pipeline 有分层，但 miss 的归因没讲。', [question, answer]).ok)
      .toBe(true);
  });

  it('exempts proper nouns, acronyms, and product terms', () => {
    const report = scoreNovelEnglish('提示 L2：像 Python 社区常说的那样，先给 VP 一个结论。', [question, answer]);
    expect(report.ok).toBe(true);
  });

  it('passes pure Chinese output', () => {
    expect(scoreNovelEnglish('你把结论放在最后，听的人要等太久。', [question, answer]).ok).toBe(true);
  });
});

describe('scoreDemonstrationLeakage (诊断专用：只查示范措辞)', () => {
  it('tolerates numbered diagnosis structure but flags demonstrations', () => {
    const structured = '1. 观点缺证据\n2. 结构松散\n3. 「原话」引用到位';
    expect(scoreDemonstrationLeakage(structured).leaked).toBe(false);
    expect(scoreDemonstrationLeakage('你可以这样说：我们的模式是……').leaked).toBe(true);
  });
});

describe('scoreHintLadder (Suite 1 提示阶梯)', () => {
  it('accepts a well-behaved ladder', () => {
    const report = scoreHintLadder([
      { level: 'L1', text: '这类质疑题要求你先接住情绪，再完成一次归因转换。' },
      { level: 'L2', text: '骨架：\n1. 承认现象\n2. 归因而非辩解\n3. 给出可验证的下一步' },
      { level: 'L3', text: '想想你上季度处理渠道质疑的那次经历，里面有现成的证据。' },
      { level: 'L4', text: '示范回答：你可以这样说——「我们走的是垂类渠道……」' },
    ]);
    expect(report.violations).toHaveLength(0);
  });

  it('flags an L1 hint that already gives structure', () => {
    const report = scoreHintLadder([
      { level: 'L1', text: '你需要：\n1. 承认现象\n2. 归因渠道\n3. 给证据' },
    ]);
    expect(report.violations.join()).toContain('L1');
  });

  it('flags demonstration wording below L4', () => {
    const report = scoreHintLadder([
      { level: 'L3', text: '你可以这样说：我们面对的是垂类市场……' },
    ]);
    expect(report.violations.join()).toContain('L3');
  });
});

describe('scoreShellFidelity (Suite 2 外壳保真)', () => {
  const secondAttempt = '我们产品面对的垂类市场，一般不会在淘宝、京东、天猫等大众销售渠道上见的。';

  it('scores a verbatim shell at 1', () => {
    expect(scoreShellFidelity('我们产品面对的垂类市场', secondAttempt)).toBe(1);
  });

  it('tolerates ASR noise (punctuation loss) in the attempt', () => {
    const noisy = '我们产品面对的垂类市场 一般不会在淘宝京东天猫等大众销售渠道上见的';
    expect(scoreShellFidelity('一般不会在淘宝、京东、天猫等大众销售渠道上见的', noisy))
      .toBeGreaterThanOrEqual(SHELL_FIDELITY_THRESHOLD);
  });

  it('scores an invented shell far below threshold', () => {
    const invented = '我们的销量在三个季度里翻了三倍，远超行业平均水平。';
    expect(scoreShellFidelity(invented, secondAttempt)).toBeLessThan(SHELL_FIDELITY_THRESHOLD);
  });

  it('scores lightly-polished wording above invented wording', () => {
    const polished = '我们产品面对垂类市场，不会在大众销售渠道上见到。';
    const invented = '我们的销量在三个季度里翻了三倍，远超行业平均。';
    expect(scoreShellFidelity(polished, secondAttempt))
      .toBeGreaterThan(scoreShellFidelity(invented, secondAttempt));
  });

  it('handles degenerate short shells', () => {
    expect(scoreShellFidelity('', secondAttempt)).toBe(0);
    expect(scoreShellFidelity('垂类', secondAttempt)).toBe(1);
  });
});

describe('scoreShellLength (Suite 2 可说带宽)', () => {
  it('accepts a shell inside the 15-120 character band', () => {
    expect(scoreShellLength('我们产品面对的垂类市场，一般不会在大众渠道上见的。').ok).toBe(true);
  });

  it('rejects a fragment and a lecture', () => {
    expect(scoreShellLength('太短了').ok).toBe(false);
    expect(scoreShellLength('长'.repeat(121)).ok).toBe(false);
  });

  it('ignores whitespace when counting', () => {
    expect(scoreShellLength(`${'字'.repeat(15)}   \n`).length).toBe(15);
  });
});

describe('summarizeRate', () => {
  it('summarizes pass rates and handles empty input', () => {
    expect(summarizeRate([true, true, false])).toEqual({ total: 3, passed: 2, rate: 2 / 3 });
    expect(summarizeRate([]).rate).toBe(0);
  });
});
