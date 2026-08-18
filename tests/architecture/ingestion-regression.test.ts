// Suite 6 摄入健壮性回归（docs/evaluation-plan.md）：15+ 文件回归库，
// 每个文件对照 tests/fixtures/ingestion/expectations.json 里的期望结果表。
// 全确定性、零 token、随 npm run check 进 CI。固定文件全部为合成内容，
// 由 scripts/generate-ingestion-fixtures.mjs 生成（可复跑审计）。
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MATERIAL_TEXT_LIMIT,
  configurePdfAssets,
  parseMaterialFile,
} from '../../src/main/material-file';

const repositoryRoot = path.resolve(__dirname, '..', '..');
const fixturesDirectory = path.join(repositoryRoot, 'tests', 'fixtures', 'ingestion');

interface IngestionCase {
  file: string;
  kind?: 'pdf' | 'docx' | 'text';
  contains?: string[];
  exactText?: string;
  warnings?: string[];
  error?: string;
}

let cases: IngestionCase[];
let workDirectory: string;

beforeAll(async () => {
  // Mirrors main.ts: dev builds read the pdfjs CMap / standard-font assets
  // straight out of node_modules (CID Chinese PDFs stall without them).
  const pdfAssetsRoot = path.join(repositoryRoot, 'node_modules', 'pdfjs-dist');
  configurePdfAssets({
    cMapDirectory: path.join(pdfAssetsRoot, 'cmaps'),
    standardFontDirectory: path.join(pdfAssetsRoot, 'standard_fonts'),
  });
  const manifest = JSON.parse(
    await readFile(path.join(fixturesDirectory, 'expectations.json'), 'utf8'),
  ) as { cases: IngestionCase[] };
  cases = manifest.cases;
  workDirectory = await mkdtemp(path.join(tmpdir(), 'mental-legos-ingestion-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

describe('ingestion regression library (Suite 6)', () => {
  it('covers at least 15 fixture files', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  it('runs every fixture against its expectation row', async () => {
    const failures: string[] = [];

    for (const expectation of cases) {
      const filePath = path.join(fixturesDirectory, expectation.file);
      try {
        if (expectation.error !== undefined) {
          await expect(parseMaterialFile(filePath), expectation.file)
            .rejects.toThrow(new RegExp(expectation.error, 'u'));
          continue;
        }

        const parsed = await parseMaterialFile(filePath);
        expect(parsed.kind, `${expectation.file} kind`).toBe(expectation.kind);
        expect(parsed.truncated, `${expectation.file} truncated`).toBe(false);
        if (expectation.exactText !== undefined) {
          expect(parsed.text, `${expectation.file} text`).toBe(expectation.exactText);
        }
        for (const fragment of expectation.contains ?? []) {
          expect(parsed.text, `${expectation.file} fragment`).toContain(fragment);
        }
        const expectedWarnings = expectation.warnings ?? [];
        expect(parsed.warnings, `${expectation.file} warning count`)
          .toHaveLength(expectedWarnings.length);
        for (const pattern of expectedWarnings) {
          expect(
            parsed.warnings.some((warning) => new RegExp(pattern, 'u').test(warning)),
            `${expectation.file} expected a warning matching /${pattern}/, got: ${parsed.warnings.join(' | ')}`,
          ).toBe(true);
        }
      } catch (reason) {
        failures.push(`${expectation.file}: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    }

    expect(failures, `failed fixtures:\n${failures.join('\n')}`).toHaveLength(0);
  }, 120_000);

  // 超大与截断样本按需生成，不入库（回归库只提交小于 2KB 的合成文件）。
  it('refuses files over the 25MB cap with guidance', async () => {
    const filePath = path.join(workDirectory, 'oversize.txt');
    await writeFile(filePath, Buffer.alloc(25 * 1024 * 1024 + 1, 0x61));
    await expect(parseMaterialFile(filePath)).rejects.toThrow(/25MB/u);
  });

  it('truncates text beyond the material limit and says so', async () => {
    const filePath = path.join(workDirectory, 'truncate.txt');
    await writeFile(filePath, 'b'.repeat(MATERIAL_TEXT_LIMIT + 50), 'utf8');
    const parsed = await parseMaterialFile(filePath);
    expect(parsed.truncated).toBe(true);
    expect(parsed.text).toHaveLength(MATERIAL_TEXT_LIMIT);
    expect(parsed.warnings.some((warning) => /截断/u.test(warning))).toBe(true);
  });
});
