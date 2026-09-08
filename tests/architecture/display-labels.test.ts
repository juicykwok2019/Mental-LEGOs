import { describe, expect, it } from 'vitest';

import {
  legoCategorySchema,
  legoVersionSchema,
  masteryStageSchema,
  moduleLinkSchema,
} from '../../src/data/contracts';
import {
  authorshipLabel,
  categoryLabel,
  relationLabel,
  stageLabel,
} from '../../src/renderer/labels';

// Every enum value the library screen renders must have a Chinese label. The
// label helpers fall back to the raw value, so a missing entry does not crash —
// it quietly shows a slug like "co-extracted" to the reader.
const CASES: Array<{ name: string; values: readonly string[]; label: (value: string) => string }> = [
  {
    name: 'version authorship',
    values: legoVersionSchema.shape.authorship.options,
    label: authorshipLabel,
  },
  {
    name: 'module link relation',
    values: moduleLinkSchema.shape.relation.options,
    label: relationLabel,
  },
  { name: 'brick category', values: legoCategorySchema.options, label: categoryLabel },
  { name: 'mastery stage', values: masteryStageSchema.options, label: stageLabel },
];

describe('renderer display labels', () => {
  for (const { name, values, label } of CASES) {
    it(`translates every ${name} value`, () => {
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        const rendered = label(value);
        expect(rendered, `${name} "${value}" falls back to the raw slug`).not.toBe(value);
        expect(rendered).toMatch(/[一-龥]/);
      }
    });
  }
});
