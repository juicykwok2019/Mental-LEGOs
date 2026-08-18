// Suite 1/2 规则判分库（docs/evaluation-plan.md）。
//
// 设计原则第 2 条：凡能硬测的绝不用 LLM Judge。这里收集全部可确定性
// 计算的评分函数——教练纪律（诊断引用、代答泄漏、提示阶梯越级）与
// 提炼保真（外壳 n-gram 保真度、可说带宽）。语义质量（内核是否为判断、
// 蕴含检查）属于 Judge，不在本文件。
//
// 纯函数、零 token；被单元测试与 MENTAL_LEGOS_EVAL 评测 runner 共用。

// ---------------------------------------------------------------- 归一化

/** 去掉空白、标点和符号并转小写——引用与 n-gram 比对都在这个空间进行，
 * 让 ASR 标点缺失和排版差异不影响判分。 */
export function normalizeForMatch(value: string): string {
  return value.replace(/[\p{P}\p{S}\p{Z}\s]/gu, '').toLowerCase();
}

/** 字符 n-gram 集合（在归一化文本上取）。 */
function characterNgrams(value: string, size: number): Set<string> {
  const grams = new Set<string>();
  for (let index = 0; index + size <= value.length; index += 1) {
    grams.add(value.slice(index, index + size));
  }
  return grams;
}

// ------------------------------------------------- Suite 1: 诊断引用检查

export interface FindingGrounding {
  finding: string;
  /** finding 里是否出现了引号包裹的引用。 */
  hasQuote: boolean;
  /** 引用内容是否真实存在于用户原话（归一化子串匹配）。 */
  grounded: boolean;
}

export interface DiagnosisGroundingReport {
  findings: FindingGrounding[];
  /** grounded 的 finding 占比；无 finding 时为 0。 */
  groundedRate: number;
}

const QUOTE_SPAN_PATTERN = /[「『“"]([^」』”"]{2,})[」』”"]/gu;
const NUMBERED_FINDING_PATTERN = /(?:^|\n)\s*(?:\*{0,2})\d+[.、）)]/u;

/** 把诊断文本拆成 finding 单元。真实模型输出常见"前言 + 编号小节"结构
 * （标题行与内容行分行）——按编号块切分，标题与内容归入同一 finding；
 * 无编号时退回按行切分（与主流程存储口径一致）。 */
function splitFindings(diagnosis: string): string[] {
  if (NUMBERED_FINDING_PATTERN.test(diagnosis)) {
    const blocks = diagnosis
      .split(/(?=(?:^|\n)\s*(?:\*{0,2})\d+[.、）)])/u)
      .map((block) => block.trim())
      .filter(Boolean);
    // 首块若不带编号则是前言（"以下是五个诊断要点："），不算 finding。
    const findings = blocks.filter((block) => /^(?:\*{0,2})\d+[.、）)]/u.test(block));
    if (findings.length > 0) return findings.slice(0, 8);
  }
  return diagnosis
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);
}

/** 诊断的每条发现必须包含用户原话的直接引用（Suite 1 规则项，
 * 指标：诊断引用率 = 100%）。 */
export function scoreDiagnosisGrounding(
  diagnosis: string,
  userResponse: string,
): DiagnosisGroundingReport {
  const normalizedResponse = normalizeForMatch(userResponse);
  const findings = splitFindings(diagnosis)
    .map((finding) => {
      const spans = [...finding.matchAll(QUOTE_SPAN_PATTERN)]
        .flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
      const hasQuote = spans.length > 0;
      const grounded = spans.some((span) => {
        const normalizedSpan = normalizeForMatch(span);
        return normalizedSpan.length >= 2 && normalizedResponse.includes(normalizedSpan);
      });
      return { finding, hasQuote, grounded };
    });
  const groundedCount = findings.filter((entry) => entry.grounded).length;
  return {
    findings,
    groundedRate: findings.length === 0 ? 0 : groundedCount / findings.length,
  };
}

// ------------------------------------------------- Suite 1: 代答泄漏规则

export interface LeakageReport {
  leaked: boolean;
  reasons: string[];
}

const DEMONSTRATION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /参考答案|标准答案|范文/u, reason: '出现"参考/标准答案"式表述' },
  { pattern: /示范回答|示例回答|回答示例|示范表述/u, reason: '出现"示范/示例回答"式表述' },
  { pattern: /你可以这样(说|讲|回答|表述)|不妨这样(说|回答)|建议(你)?这样表述/u, reason: '出现替用户组织措辞的句式' },
  { pattern: /可以参考以下|以下(是|为)一(个|段)?(示例|范例|参考)/u, reason: '出现"以下示例"式引导' },
];

const OUTLINE_LINE_PATTERN = /^\s*(?:[-*•]|\d{1,2}[.、).]|[①②③④⑤⑥⑦⑧⑨⑩]|第[一二三四五六七八九十]+[步点条])/u;

/** 只查示范措辞（不查大纲/长度）——用于诊断这类本就该分条的输出。 */
export function scoreDemonstrationLeakage(text: string): LeakageReport {
  const reasons: string[] = [];
  for (const { pattern, reason } of DEMONSTRATION_PATTERNS) {
    if (pattern.test(text)) reasons.push(reason);
  }
  return { leaked: reasons.length > 0, reasons };
}

/** 出题输出不得包含大纲或示范回答结构（Suite 1 规则项：模式匹配 + 长度上限）。
 * `maxLength` 按归一化字符数计，默认 300（场景题可引用材料，留出余量）。 */
export function scoreQuestionLeakage(question: string, maxLength = 300): LeakageReport {
  const reasons: string[] = [];
  for (const { pattern, reason } of DEMONSTRATION_PATTERNS) {
    if (pattern.test(question)) reasons.push(reason);
  }
  const outlineLines = question
    .split('\n')
    .filter((line) => OUTLINE_LINE_PATTERN.test(line));
  if (outlineLines.length >= 2) {
    reasons.push(`含 ${outlineLines.length} 行大纲/列表结构`);
  }
  const normalizedLength = [...normalizeForMatch(question)].length;
  if (normalizedLength > maxLength) {
    reasons.push(`长度 ${normalizedLength} 超过上限 ${maxLength}`);
  }
  return { leaked: reasons.length > 0, reasons };
}

// ------------------------------------------------- Suite 1: 提示阶梯规则

export type HintLevelLabel = 'L1' | 'L2' | 'L3' | 'L4';

export interface HintSample {
  level: HintLevelLabel;
  text: string;
}

export interface HintLadderReport {
  violations: string[];
}

/** 提示阶梯的可硬测部分：低层级不得越级给高层级的内容。
 *
 * - L1（目标提示）不得出现步骤/大纲结构（那是 L2 的内容）；
 * - L1-L3 不得出现示范措辞句式（按实现，示范只属于 L4）。
 *
 * "信息量递增"的语义部分属于 Judge，不在规则内。 */
export function scoreHintLadder(hints: HintSample[]): HintLadderReport {
  const violations: string[] = [];
  for (const hint of hints) {
    const outlineLines = hint.text.split('\n').filter((line) => OUTLINE_LINE_PATTERN.test(line));
    if (hint.level === 'L1' && outlineLines.length >= 2) {
      violations.push('L1 出现步骤大纲（越级到 L2）');
    }
    if (hint.level !== 'L4') {
      for (const { pattern } of DEMONSTRATION_PATTERNS) {
        if (pattern.test(hint.text)) {
          violations.push(`${hint.level} 出现示范措辞（越级到 L4）`);
          break;
        }
      }
    }
  }
  return { violations };
}

// ------------------------------------------------- Suite 2: 外壳保真度

/** 语言外壳对第二遍原文的字符 n-gram 包含度（0..1）。
 * 归一化后取 3-gram；外壳过短时退化为直接子串检查。
 * 指标：保真度 ≥ 0.6 判合格（Suite 2）。 */
export function scoreShellFidelity(shell: string, secondAttempt: string, ngramSize = 3): number {
  const normalizedShell = normalizeForMatch(shell);
  const normalizedAttempt = normalizeForMatch(secondAttempt);
  if (normalizedShell.length === 0) return 0;
  if (normalizedShell.length < ngramSize) {
    return normalizedAttempt.includes(normalizedShell) ? 1 : 0;
  }
  const shellGrams = characterNgrams(normalizedShell, ngramSize);
  const attemptGrams = characterNgrams(normalizedAttempt, ngramSize);
  let hit = 0;
  for (const gram of shellGrams) {
    if (attemptGrams.has(gram)) hit += 1;
  }
  return hit / shellGrams.size;
}

export const SHELL_FIDELITY_THRESHOLD = 0.6;

/** 外壳长度须在"5-30 秒可说"带宽内：约 15-120 个字符（Suite 2 规则项）。
 * 长度按去除空白后的字符数计。 */
export function scoreShellLength(shell: string): { length: number; ok: boolean } {
  const length = [...shell.replace(/\s/gu, '')].length;
  return { length, ok: length >= 15 && length <= 120 };
}

// ------------------------------------------------------------- 汇总工具

export interface RateSummary {
  total: number;
  passed: number;
  rate: number;
}

export function summarizeRate(outcomes: boolean[]): RateSummary {
  const passed = outcomes.filter(Boolean).length;
  return {
    total: outcomes.length,
    passed,
    rate: outcomes.length === 0 ? 0 : passed / outcomes.length,
  };
}
