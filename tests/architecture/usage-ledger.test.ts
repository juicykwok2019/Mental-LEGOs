import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UsageLedger, usageFromAgentMessages } from '../../src/main/usage-ledger';

let workDirectory: string;

beforeAll(async () => {
  workDirectory = await mkdtemp(path.join(tmpdir(), 'mental-legos-usage-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

describe('usageFromAgentMessages', () => {
  it('sums direct and cached input tokens from the result message', () => {
    const usage = usageFromAgentMessages([
      { type: 'assistant', message: {} },
      {
        type: 'result',
        result: 'done',
        usage: {
          input_tokens: 120,
          cache_creation_input_tokens: 400,
          cache_read_input_tokens: 1000,
          output_tokens: 88,
        },
      },
    ]);
    expect(usage).toEqual({ inputTokens: 1520, outputTokens: 88 });
  });

  it('returns null when the provider reports no usage', () => {
    expect(usageFromAgentMessages([{ type: 'result', result: 'done' }])).toBeNull();
    expect(usageFromAgentMessages([])).toBeNull();
  });
});

describe('UsageLedger', () => {
  it('accumulates runs into today and total, and survives reopen', async () => {
    const ledger = await UsageLedger.open(workDirectory);
    ledger.record({ inputTokens: 100, outputTokens: 20 });
    ledger.record({ inputTokens: 50, outputTokens: 5 });
    await ledger.flush();

    const overview = ledger.overview();
    expect(overview.today).toEqual({ inputTokens: 150, outputTokens: 25, runs: 2 });
    expect(overview.total).toEqual({ inputTokens: 150, outputTokens: 25, runs: 2 });

    const reopened = await UsageLedger.open(workDirectory);
    expect(reopened.overview().total).toEqual({ inputTokens: 150, outputTokens: 25, runs: 2 });
  });

  it('starts fresh from a corrupt ledger file', async () => {
    const corruptDirectory = path.join(workDirectory, 'corrupt');
    const ledger = await UsageLedger.open(corruptDirectory);
    ledger.record({ inputTokens: 1, outputTokens: 1 });
    await ledger.flush();
    const filePath = path.join(corruptDirectory, 'usage-ledger.json');
    expect(JSON.parse(await readFile(filePath, 'utf8')).total.runs).toBe(1);

    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, 'not json', 'utf8');
    const recovered = await UsageLedger.open(corruptDirectory);
    expect(recovered.overview().total.runs).toBe(0);
  });
});
