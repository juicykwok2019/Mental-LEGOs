import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  const pythonCommand = process.env.MENTAL_LEGOS_TEST_PYTHON ?? 'python';
  const result = spawnSync(pythonCommand, [scriptPath, value], {
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
      'select-hint.py',
      { state: 'QUESTION_CREATED' },
    )).toEqual({
      state: 'QUESTION_CREATED',
      prompt: 'Take a moment, then give your first unaided response.',
    });
  });

  it('validates a synthetic three-layer language module', () => {
    expect(runSkillScript(
      'lego-extraction',
      'validate-candidate.py',
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
      'scan-output.py',
      { text: 'Synthetic public-safe test content.' },
    )).toEqual({ safe: true, findings: [] });
  });

  it('parses an authorized Markdown material copy', () => {
    const result = runSkillScript(
      'scenario-preparation',
      'extract-material.py',
      path.join(bundleRoot, 'CLAUDE.md'),
    );

    expect(result).toMatchObject({ source_name: 'CLAUDE.md' });
    expect(result).toHaveProperty('sections');
  });

  it('executes the remaining deterministic Skill baselines', () => {
    expect(runSkillScript('deep-research', 'synthesize-evidence.py', {
      claims: [{ text: 'Synthetic claim', status: 'supported', source_refs: ['source-1'] }],
    })).toEqual({
      claims: [{
        claim_id: 'claim-1',
        text: 'Synthetic claim',
        source_refs: ['source-1'],
        status: 'supported',
        as_of: null,
      }],
    });
    expect(runSkillScript('post-event-review', 'align-turns.py', {
      turns: [
        { ref: 'later', start_ms: 20, text: 'Second' },
        { ref: 'earlier', start_ms: 10, text: 'First' },
      ],
    })).toMatchObject({ turns: [{ ref: 'earlier' }, { ref: 'later' }] });
    expect(runSkillScript('professional-speaking', 'segment-timing.py', {
      segments: [{ start_ms: 100, end_ms: 350, text: 'Opening' }],
    })).toMatchObject({ total_ms: 250 });
    expect(runSkillScript('profile-evidence', 'check-profile-candidate.py', {
      state: 'observation',
      claim: 'A synthetic observation',
      evidence_refs: ['attempt-1'],
      scope: 'synthetic test',
    })).toEqual({ valid: true, errors: [] });
    expect(runSkillScript('response-diagnosis', 'score-structure.py', {
      text: '具体来看，我认为第一点有一个案例，所以可以总结。',
    })).toMatchObject({
      signals: {
        convergence: true,
        judgment: true,
        structure: true,
        evidence: true,
        closure: true,
      },
    });
    expect(runSkillScript('transfer-question-design', 'build-transfer-matrix.py', {
      module_id: 'synthetic-module',
      dimensions: { audience: ['peer'], objective: ['explain'], seconds: [30] },
    })).toEqual({
      matrix: [{
        module_id: 'synthetic-module',
        audience: 'peer',
        objective: 'explain',
        seconds: 30,
      }],
    });
  });

  it('keeps every Skill reference on a sandbox-executable Python file', () => {
    const references = [
      ['deep-research', 'synthesize-evidence.py'],
      ['first-attempt-coach', 'select-hint.py'],
      ['lego-extraction', 'validate-candidate.py'],
      ['post-event-review', 'align-turns.py'],
      ['privacy-provenance', 'scan-output.py'],
      ['professional-speaking', 'segment-timing.py'],
      ['profile-evidence', 'check-profile-candidate.py'],
      ['response-diagnosis', 'score-structure.py'],
      ['scenario-preparation', 'extract-material.py'],
      ['transfer-question-design', 'build-transfer-matrix.py'],
    ];
    for (const [skill, script] of references) {
      expect(existsSync(path.join(
        bundleRoot,
        '.claude',
        'skills',
        skill ?? '',
        'scripts',
        script ?? '',
      ))).toBe(true);
    }
  });
});
