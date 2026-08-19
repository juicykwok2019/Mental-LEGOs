// 代答泄漏 Judge 校准集的完整性校验（docs/evaluation-plan.md Suite 1）。
// humanLabel 只能由人工填写；这里锁结构：30 条、id 唯一、文本非空、
// 标签为空或合法。校准集来自真实冒烟轮输出（合成人设语料驱动）。
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

interface CalibrationCase {
  id: string;
  kind: string;
  text: string;
  humanLabel: 'leaked' | 'clean' | null;
}
interface CalibrationKit { labels: string[]; cases: CalibrationCase[] }

let kit: CalibrationKit;

beforeAll(async () => {
  kit = JSON.parse(await readFile(
    path.resolve(__dirname, '..', 'fixtures', 'eval', 'judge-calibration.json'),
    'utf8',
  )) as CalibrationKit;
});

describe('judge calibration kit (answer-leak classifier)', () => {
  it('holds thirty unique, non-empty samples', () => {
    expect(kit.cases).toHaveLength(30);
    expect(new Set(kit.cases.map((entry) => entry.id)).size).toBe(30);
    for (const entry of kit.cases) {
      expect(entry.text.trim().length, entry.id).toBeGreaterThan(20);
    }
  });

  it('mixes diagnoses and sub-L4 hints, never the L4 demonstration tier', () => {
    expect(kit.cases.some((entry) => entry.kind === 'diagnosis')).toBe(true);
    expect(kit.cases.some((entry) => entry.kind.startsWith('hint-'))).toBe(true);
    expect(kit.cases.some((entry) => entry.kind === 'hint-L4')).toBe(false);
  });

  it('keeps labels legal or empty until a human fills them', () => {
    for (const entry of kit.cases) {
      if (entry.humanLabel !== null) {
        expect(kit.labels, entry.id).toContain(entry.humanLabel);
      }
    }
  });
});
