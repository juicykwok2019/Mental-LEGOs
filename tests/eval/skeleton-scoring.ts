// Suite 7 演讲套件的规则判分（docs/evaluation-plan.md）。
//
// 骨架是纯文本大纲：模块引用写作【标题】，缺口诚实标注写作【缺积木：主题】，
// 各节自带时间预算（"3 分钟"、"90 秒"、"2-3 分钟"等自由写法）。
// 这里的判分全部是确定性规则：引用集合校验、缺积木诚实性、时间预算加和、
// 变换后的引用保持率。纯函数、零 token。

export interface SkeletonReferences {
  /** 出现的模块引用标题（去重、保序）。 */
  modules: string[];
  /** 【缺积木：主题】 标注的主题列表。 */
  missingBricks: string[];
}

const BRACKET_PATTERN = /【([^【】]+)】/gu;

/** 从骨架大纲里抽出模块引用与缺积木标注。 */
export function extractSkeletonReferences(outline: string): SkeletonReferences {
  const modules: string[] = [];
  const missingBricks: string[] = [];
  const seen = new Set<string>();
  for (const match of outline.matchAll(BRACKET_PATTERN)) {
    const inner = (match[1] ?? '').trim();
    if (inner.length === 0) continue;
    const missing = /^缺积木\s*[:：]?\s*(.*)$/u.exec(inner);
    if (missing) {
      missingBricks.push((missing[1] ?? '').trim());
      continue;
    }
    if (!seen.has(inner)) {
      seen.add(inner);
      modules.push(inner);
    }
  }
  return { modules, missingBricks };
}

export interface ReferenceValidation {
  references: string[];
  unknown: string[];
  ok: boolean;
}

/** 每个【模块引用】必须存在于该用户的模块库（集合校验，Suite 7 规则）。
 * `ignoreTitles` 用于排除非模块性引用（如骨架里复述的演讲标题）。 */
export function validateSkeletonReferences(
  outline: string,
  libraryTitles: string[],
  ignoreTitles: string[] = [],
): ReferenceValidation {
  const ignored = new Set(ignoreTitles.map((title) => title.trim()));
  const modules = extractSkeletonReferences(outline).modules
    .filter((title) => !ignored.has(title));
  const library = new Set(libraryTitles.map((title) => title.trim()));
  const unknown = modules.filter((title) => !library.has(title));
  return { references: modules, unknown, ok: modules.length > 0 && unknown.length === 0 };
}

export interface TimeBudgetReport {
  /** 各节解析出的预算（分钟）。 */
  sections: number[];
  totalMinutes: number;
  targetMinutes: number;
  withinTolerance: boolean;
}

const MINUTE_PATTERN = /(\d+(?:\.\d+)?)(?:\s*[-~至]\s*(\d+(?:\.\d+)?))?\s*(分钟|分半|分)/gu;
const SECOND_PATTERN = /(\d+(?:\.\d+)?)\s*秒/gu;

/** 各节时间预算加和应等于目标时长（±10%，Suite 7 规则）。
 *
 * 解析"3 分钟 / 90 秒 / 2-3 分钟 / 1 分半"等写法；若某个解析值本身
 * 约等于其余值之和（±5%），视为大纲里写的"总时长"行，剔除后再加和。 */
export function scoreTimeBudget(
  outline: string,
  targetMinutes: number,
  tolerance = 0.1,
): TimeBudgetReport {
  const values: number[] = [];
  for (const match of outline.matchAll(MINUTE_PATTERN)) {
    const low = Number.parseFloat(match[1] ?? '0');
    const high = match[2] !== undefined ? Number.parseFloat(match[2]) : low;
    let minutes = (low + high) / 2;
    if (match[3] === '分半') minutes = low + 0.5;
    values.push(minutes);
  }
  for (const match of outline.matchAll(SECOND_PATTERN)) {
    values.push(Number.parseFloat(match[1] ?? '0') / 60);
  }

  // 大纲里可能夹一行"总时长 X 分钟"造成重复计数。两种解释都算：
  // 全部相加，或剔除一个"约等于其余之和"的候选总时长值——哪种命中
  // 目标容差就采信哪种；都不命中时取相对误差较小的一种。
  const sum = (list: number[]): number => list.reduce((acc, value) => acc + value, 0);
  const interpretations: number[][] = [values];
  if (values.length >= 2) {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index]!;
      const rest = sum(values) - value;
      if (rest > 0 && Math.abs(value - rest) / rest <= 0.05) {
        interpretations.push(values.filter((_, i) => i !== index));
        break;
      }
    }
  }
  const scored = interpretations.map((sections) => {
    const totalMinutes = sum(sections);
    const relativeError = targetMinutes > 0
      ? Math.abs(totalMinutes - targetMinutes) / targetMinutes
      : Number.POSITIVE_INFINITY;
    return { sections, totalMinutes, relativeError };
  });
  scored.sort((left, right) => left.relativeError - right.relativeError);
  const best = scored[0]!;
  return {
    sections: best.sections,
    totalMinutes: best.totalMinutes,
    targetMinutes,
    withinTolerance: best.relativeError <= tolerance,
  };
}

export interface RetentionReport {
  before: string[];
  after: string[];
  retained: string[];
  lost: string[];
  retentionRate: number;
}

/** 压缩/扩展/换听众后，模块引用集合不得丢失核心项（Suite 7 规则）。
 * 返回保持率；压缩允许有损，阈值由调用方按变换类型决定。 */
export function scoreReferenceRetention(
  outlineBefore: string,
  outlineAfter: string,
): RetentionReport {
  const before = extractSkeletonReferences(outlineBefore).modules;
  const afterSet = new Set(extractSkeletonReferences(outlineAfter).modules);
  const retained = before.filter((title) => afterSet.has(title));
  const lost = before.filter((title) => !afterSet.has(title));
  return {
    before,
    after: [...afterSet],
    retained,
    lost,
    retentionRate: before.length === 0 ? 0 : retained.length / before.length,
  };
}
