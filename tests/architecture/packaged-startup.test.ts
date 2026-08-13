import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('packaged startup regression guard', () => {
  it('keeps the Claude Agent SDK out of the Electron main-process bundle boundary', async () => {
    const source = await readFile('src/main/provider-certification.ts', 'utf8');
    expect(source).toContain("from '../agent/governance/repository'");
    expect(source).not.toContain("from '../agent/governance'");
  });

  it('uses a waitable child process for packaged smoke tests', async () => {
    const source = await readFile('scripts/packaged-smoke.mjs', 'utf8');
    expect(source).toContain("spawn(executablePath");
    expect(source).toContain("child.once('exit'");
    expect(source).toContain("--disable-error-dialogs");
  });
});
