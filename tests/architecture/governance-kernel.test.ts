import { describe, expect, it } from 'vitest';

import {
  createGovernanceKernel,
  GovernanceRepository,
  governanceToolNames,
} from '../../src/agent/governance';

const provenance = {
  source_refs: ['synthetic:source-1'],
  method: 'synthetic architecture test',
  generated_by: 'mental-legos-agent' as const,
};

describe('minimal MCP governance kernel', () => {
  it('exposes six logical servers without a giant workflow tool', () => {
    const repository = new GovernanceRepository();
    try {
      expect(Object.keys(createGovernanceKernel(repository)).sort()).toEqual([
        'artifact', 'commit', 'context', 'lifecycle', 'media', 'practice',
      ]);
      expect(governanceToolNames).not.toContain('run_complete_training_workflow');
      expect(governanceToolNames.every((name) => name.startsWith('mcp__'))).toBe(true);
    } finally {
      repository.close();
    }
  });

  it('keeps answer content and answer-shaped candidates behind the first-attempt gate', () => {
    const repository = new GovernanceRepository();
    try {
      repository.seedContext({
        ref: 'context:general',
        scope: 'scenario',
        kind: 'brief',
        content: 'Synthetic goal: explain a product decision.',
        disclosure: 'general',
        provenance,
      });
      repository.seedContext({
        ref: 'context:answer',
        scope: 'personal',
        kind: 'module',
        content: 'Synthetic target judgment and reusable wording.',
        disclosure: 'answer',
        provenance,
      });
      repository.createQuestion({
        attemptId: 'attempt-1',
        sessionId: 'session-1',
        questionRef: 'question-1',
      });

      const hidden = repository.searchContext({
        query: 'Synthetic',
        scopes: ['scenario', 'personal'],
        kinds: ['brief', 'module'],
        limit: 10,
        attemptId: 'attempt-1',
      });
      expect(hidden).toEqual(expect.arrayContaining([
        expect.objectContaining({ ref: 'context:general', withheld: false }),
        expect.objectContaining({ ref: 'context:answer', withheld: true }),
      ]));
      expect(() => repository.readContextExcerpt({
        ref: 'context:answer',
        purpose: 'premature answer request',
        maxChars: 200,
        attemptId: 'attempt-1',
      })).toThrow(/withheld/u);
      expect(() => repository.submitCandidate({
        sessionId: 'session-1',
        attemptId: 'attempt-1',
        kind: 'language_module',
        payload: { semantic_core: 'premature' },
        provenance,
        scope: 'session',
        idempotencyKey: 'candidate-before-gate',
      })).toThrow(/blocked/u);

      expect(repository.recordAttempt({
        sessionId: 'session-1',
        attemptId: 'attempt-1',
        questionRef: 'question-1',
        response: '',
        idempotencyKey: 'attempt-record-0001',
      })).toMatchObject({ state: 'FIRST_ATTEMPT_RECORDING', duplicate: false });
      expect(repository.closeFirstAttempt({
        attemptId: 'attempt-1',
        outcome: 'blank',
        idempotencyKey: 'attempt-close-0001',
      })).toMatchObject({ state: 'FIRST_ATTEMPT_CLOSED', duplicate: false });
      expect(repository.allowAssistance('attempt-1')).toBe('ASSISTANCE_ALLOWED');

      expect(repository.readContextExcerpt({
        ref: 'context:answer',
        purpose: 'post-attempt assistance',
        maxChars: 200,
        attemptId: 'attempt-1',
      })).toMatchObject({
        ref: 'context:answer',
        content: 'Synthetic target judgment and reusable wording.',
      });
    } finally {
      repository.close();
    }
  });

  it('commits candidates only with a preview-bound single-use host token', () => {
    const repository = new GovernanceRepository();
    try {
      repository.createQuestion({
        attemptId: 'attempt-2',
        sessionId: 'session-2',
        questionRef: 'question-2',
      });
      repository.recordAttempt({
        sessionId: 'session-2',
        attemptId: 'attempt-2',
        questionRef: 'question-2',
        response: 'A synthetic first response.',
        idempotencyKey: 'attempt-record-0002',
      });
      repository.closeFirstAttempt({
        attemptId: 'attempt-2',
        outcome: 'completed',
        idempotencyKey: 'attempt-close-0002',
      });
      repository.allowAssistance('attempt-2');

      const first = repository.submitCandidate({
        sessionId: 'session-2',
        attemptId: 'attempt-2',
        kind: 'language_module',
        payload: {
          semantic_core: 'A bounded synthetic judgment',
          logical_skeleton: 'signal -> mechanism -> implication',
          language_shells: ['If we narrow the question...'],
        },
        provenance,
        scope: 'personal',
        idempotencyKey: 'candidate-after-gate-0002',
      });
      const duplicate = repository.submitCandidate({
        sessionId: 'session-2',
        attemptId: 'attempt-2',
        kind: 'language_module',
        payload: { ignored_on_duplicate: true },
        provenance,
        scope: 'personal',
        idempotencyKey: 'candidate-after-gate-0002',
      });
      expect(duplicate).toMatchObject({ candidateId: first.candidateId, duplicate: true });

      const preview = repository.prepareCommit([first.candidateId]);
      expect(() => repository.commitConfirmed({
        token: 'not-a-host-token-value-that-can-work',
        previewId: preview.previewId,
        userEdits: {},
      })).toThrow(/token/u);

      const token = repository.issueConfirmationToken({
        action: 'commit',
        previewId: preview.previewId,
      });
      const committed = repository.commitConfirmed({
        token,
        previewId: preview.previewId,
        userEdits: {
          [first.candidateId]: { user_confirmed: true },
        },
      });
      expect(committed.assetIds).toHaveLength(1);
      expect(repository.getFormalAssetCount()).toBe(1);
      expect(() => repository.commitConfirmed({
        token,
        previewId: preview.previewId,
        userEdits: {},
      })).toThrow(/already used|invalid/u);
      expect(repository.getFormalAssetCount()).toBe(1);
    } finally {
      repository.close();
    }
  });

  it('keeps media paths and secrets out of transcript results', () => {
    const repository = new GovernanceRepository();
    try {
      repository.seedSyntheticTranscript({
        transcriptId: 'transcript-synthetic-1',
        segments: [
          { start_ms: 0, end_ms: 900, text: 'Synthetic spoken segment.' },
          { start_ms: 1_100, end_ms: 2_000, text: 'Second synthetic segment.' },
        ],
        timing: { duration_ms: 2_000, pause_count: 1 },
        provenance: { source: 'synthetic-test-fixture' },
      });

      const transcript = repository.getTranscript({
        transcriptId: 'transcript-synthetic-1',
        startMs: 1_000,
      });
      expect(transcript.segments).toHaveLength(1);
      expect(JSON.stringify(transcript)).not.toMatch(/(?:path|key|secret)/iu);
      expect(repository.getTimingFeatures('transcript-synthetic-1'))
        .toEqual({ duration_ms: 2_000, pause_count: 1 });
    } finally {
      repository.close();
    }
  });

  it('requires a separate single-use token for destructive actions', () => {
    const repository = new GovernanceRepository();
    try {
      const event = repository.recordPracticeEvent({
        sessionId: 'session-delete',
        eventType: 'hint',
        payload: { level: 1 },
        idempotencyKey: 'practice-delete-0001',
      });
      expect(repository.recordPracticeEvent({
        sessionId: 'session-delete',
        eventType: 'hint',
        payload: { level: 9 },
        idempotencyKey: 'practice-delete-0001',
      })).toMatchObject({ eventId: event.eventId, duplicate: true });

      const preview = repository.previewDelete({
        targetType: 'practice_event',
        targetIds: [event.eventId],
      });
      expect(() => repository.executeDelete({
        previewId: preview.previewId,
        token: 'not-a-host-delete-token-value',
      })).toThrow(/token/u);
      const token = repository.issueConfirmationToken({
        action: 'delete',
        previewId: preview.previewId,
      });
      expect(repository.executeDelete({ previewId: preview.previewId, token }))
        .toEqual({ deleted: 1 });
      expect(() => repository.executeDelete({ previewId: preview.previewId, token }))
        .toThrow(/already used|invalid/u);
    } finally {
      repository.close();
    }
  });
});
