import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const bundleRoot = path.resolve('resources', 'capability-bundle');

function runSkillScript(
  skill: string,
  script: string,
  argument: string | Record<string, unknown>,
): unknown {
  const scriptPath = path.join(
    bundleRoot,
    '.claude',
    'skills',
    skill,
    'scripts',
    script,
  );
  const value = typeof argument === 'string'
    ? argument
    : JSON.stringify(argument);
  const result = spawnSync(process.execPath, [scriptPath, value], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `${script} failed`);
  }

  return JSON.parse(result.stdout) as unknown;
}

describe('editable Skill reference scripts', () => {
  it('keeps the pre-attempt prompt free of answer content', () => {
    expect(runSkillScript(
      'first-attempt-coach',
      'select-hint.mjs',
      { state: 'QUESTION_CREATED' },
    )).toEqual({
      state: 'QUESTION_CREATED',
      prompt: 'Take a moment, then give your first unaided response.',
    });
  });

  it('validates a synthetic three-layer language module', () => {
    expect(runSkillScript(
      'lego-extraction',
      'validate-candidate.mjs',
      {
        semantic_core: 'A bounded judgment',
        logical_skeleton: 'signal -> mechanism -> implication',
        language_shells: ['If we narrow the question...'],
        retrieval_cues: ['open question'],
        scope: 'professional discussion',
        provenance: 'synthetic test',
      },
    )).toEqual({ valid: true, errors: [] });
  });

  it('passes public-safe synthetic output through the privacy reference', () => {
    expect(runSkillScript(
      'privacy-provenance',
      'scan-output.mjs',
      { text: 'Synthetic public-safe test content.' },
    )).toEqual({ safe: true, findings: [] });
  });

  it('parses an authorized Markdown material copy', () => {
    const result = runSkillScript(
      'scenario-preparation',
      'extract-material.mjs',
      path.join(bundleRoot, 'CLAUDE.md'),
    );

    expect(result).toMatchObject({ source_name: 'CLAUDE.md' });
    expect(result).toHaveProperty('sections');
  });
});
