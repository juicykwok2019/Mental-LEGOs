// Suite 3 标注包完整性校验（docs/evaluation-plan.md）。
// 金标签只能由人工填写；这里锁住的是标注包本身的结构：40 条、
// 难度类型全覆盖（含"逐字背诵"困难样本）、goldLabel 要么为空要么合法。
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

interface Suite3Module { id: string; title: string; kernel: string; shell: string }
interface Suite3Case {
  id: string; moduleId: string; difficulty: string;
  variationQuestion: string; userAnswer: string;
  proposedLabel: 'success' | 'partial' | 'failure';
  goldLabel: 'success' | 'partial' | 'failure' | null;
}
interface Suite3Kit {
  labels: string[];
  difficulties: Record<string, string>;
  modules: Suite3Module[];
  cases: Suite3Case[];
}

let kit: Suite3Kit;

beforeAll(async () => {
  const raw = await readFile(
    path.resolve(__dirname, '..', 'fixtures', 'eval', 'suite3-variation-gold.json'),
    'utf8',
  );
  kit = JSON.parse(raw) as Suite3Kit;
});

describe('suite 3 labeling kit', () => {
  it('holds exactly forty cases with unique ids', () => {
    expect(kit.cases).toHaveLength(40);
    expect(new Set(kit.cases.map((entry) => entry.id)).size).toBe(40);
  });

  it('links every case to a defined module', () => {
    const moduleIds = new Set(kit.modules.map((module) => module.id));
    for (const entry of kit.cases) {
      expect(moduleIds.has(entry.moduleId), entry.id).toBe(true);
    }
  });

  it('covers every declared difficulty for every module', () => {
    const difficulties = Object.keys(kit.difficulties);
    expect(difficulties).toContain('verbatim-recite');
    for (const module of kit.modules) {
      const covered = new Set(
        kit.cases.filter((entry) => entry.moduleId === module.id).map((entry) => entry.difficulty),
      );
      for (const difficulty of difficulties) {
        expect(covered.has(difficulty), `${module.id} 缺 ${difficulty}`).toBe(true);
      }
    }
  });

  it('keeps labels legal: proposed always set, gold empty until a human fills it', () => {
    for (const entry of kit.cases) {
      expect(kit.labels).toContain(entry.proposedLabel);
      if (entry.goldLabel !== null) {
        expect(kit.labels, entry.id).toContain(entry.goldLabel);
      }
    }
  });

  it('keeps the verbatim-recite hard cases literally verbatim', () => {
    const shells = new Map(kit.modules.map((module) => [module.id, module.shell]));
    for (const entry of kit.cases.filter((candidate) => candidate.difficulty === 'verbatim-recite')) {
      expect(entry.userAnswer, entry.id).toBe(shells.get(entry.moduleId));
    }
  });
});
