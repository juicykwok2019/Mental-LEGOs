import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LegoVersionPayload } from '../../src/data/contracts';
import { StaticDataKeyProvider } from '../../src/data/crypto';
import { ProductDatabase } from '../../src/data/product-database';
import {
  nextDueAt,
  promoteStage,
  regressStage,
  TrainingEngine,
} from '../../src/training/engine';

const NOW = '2026-08-17T09:00:00.000Z';
const LATER = '2026-08-17T09:30:00.000Z';

const payload: LegoVersionPayload = {
  semanticKernel: '先确认问题边界再回答',
  logicSkeleton: ['重述', '确认', '回答'],
  languageShells: ['我先确认一下问题的范围……'],
  anchorPhrase: '',
  slots: [],
  purpose: '',
  boundaries: '',
};

describe('training engine gate, hints, and scheduling', () => {
  let directory: string;
  let database: ProductDatabase;
  let engine: TrainingEngine;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'mental-legos-engine-'));
    database = new ProductDatabase(
      path.join(directory, 'product.db'),
      StaticDataKeyProvider.random(),
    );
    engine = new TrainingEngine(database);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  function confirmedModule(): string {
    const { module } = database.createLegoCandidate({
      id: randomUUID(),
      scope: 'global',
      scenarioId: null,
      category: 'opening',
      title: '确认边界模块',
      triggers: ['开放问题'],
      payload,
      authorship: 'user-native',
      now: NOW,
    });
    database.confirmLegoVersion(module.id, 1, NOW);
    return module.id;
  }

  it('walks the full gate: question → first attempt → close → assistance', () => {
    const question = engine.registerQuestion({
      prompt: '如何评估一个新方案的风险？',
      scope: 'global',
      origin: 'scheduler',
      now: NOW,
    });
    const gate = engine.beginFirstAttempt(question.id, NOW);
    expect(gate.state).toBe('FIRST_ATTEMPT_RECORDING');
    expect(gate.assistanceAllowed).toBe(false);
    expect(() => engine.assertAssistanceAllowed(gate.attemptId)).toThrow('gate is closed');
    expect(() => engine.issueHint(gate.attemptId, 'L1')).toThrow('gate is closed');

    const closed = engine.closeFirstAttempt(gate.attemptId, {
      outcome: 'answered',
      responseText: '我会先看不可逆性……',
      openingDelayMs: 3000,
      now: NOW,
    });
    expect(closed.state).toBe('FIRST_ATTEMPT_CLOSED');
    expect(closed.assistanceAllowed).toBe(false);
    expect(() => engine.issueHint(gate.attemptId, 'L1')).toThrow('gate is closed');

    const released = engine.releaseAssistance(gate.attemptId, NOW);
    expect(released.assistanceAllowed).toBe(true);
    expect(released.nextHintLevel).toBe('L1');
  });

  it('honors cannot-answer as a legitimate gate outcome', () => {
    const question = engine.registerQuestion({
      prompt: '一个当前答不出来的问题',
      scope: 'global',
      origin: 'scheduler',
      now: NOW,
    });
    const gate = engine.beginFirstAttempt(question.id, NOW);
    const closed = engine.closeFirstAttempt(gate.attemptId, {
      outcome: 'cannot-answer',
      now: NOW,
    });
    expect(closed.state).toBe('FIRST_ATTEMPT_CLOSED');
    expect(database.getAttempt(gate.attemptId)?.outcome).toBe('cannot-answer');
  });

  it('enforces one-level-at-a-time hint escalation', () => {
    const question = engine.registerQuestion({
      prompt: '问题', scope: 'global', origin: 'scheduler', now: NOW,
    });
    const gate = engine.beginFirstAttempt(question.id, NOW);
    engine.closeFirstAttempt(gate.attemptId, { outcome: 'answered', now: NOW });
    engine.releaseAssistance(gate.attemptId, NOW);
    expect(() => engine.issueHint(gate.attemptId, 'L3', LATER)).toThrow('one level at a time');
    engine.issueHint(gate.attemptId, 'L1', LATER);
    engine.issueHint(gate.attemptId, 'L2', LATER);
    expect(() => engine.issueHint(gate.attemptId, 'L2', LATER)).toThrow('one level at a time');
    const second = engine.recordSecondAttempt({
      questionId: question.id,
      firstAttemptId: gate.attemptId,
      responseText: '第二遍回答……',
      now: LATER,
    });
    expect(second.hintLevel).toBe('L2');
  });

  it('blocks the second attempt while the gate is closed', () => {
    const question = engine.registerQuestion({
      prompt: '问题', scope: 'global', origin: 'scheduler', now: NOW,
    });
    const gate = engine.beginFirstAttempt(question.id, NOW);
    expect(() => engine.recordSecondAttempt({
      questionId: question.id,
      firstAttemptId: gate.attemptId,
      responseText: '不应该被允许',
      now: NOW,
    })).toThrow('gate is closed');
  });

  it('promotes, regresses, and schedules mastery deterministically', () => {
    expect(promoteStage('confirmed')).toBe('visible-recall');
    expect(regressStage('visible-recall')).toBe('confirmed');
    expect(regressStage('confirmed')).toBe('confirmed');
    expect(promoteStage('real-world')).toBe('real-world');
    expect(nextDueAt('independent-recall', NOW))
      .toBe('2026-08-24T09:00:00.000Z');

    const moduleId = confirmedModule();
    const promoted = engine.recordPracticeResult({
      moduleId, kind: 'spaced-review', result: 'success', now: NOW,
    });
    expect(promoted.stage).toBe('visible-recall');
    expect(promoted.dueAt).toBe(nextDueAt('visible-recall', NOW));

    const regressed = engine.recordPracticeResult({
      moduleId, kind: 'variation-call', result: 'failure', now: LATER,
    });
    expect(regressed.stage).toBe('confirmed');
    expect(engine.dueQueue(nextDueAt('confirmed', LATER))).toHaveLength(1);
    expect(engine.dueQueue(LATER)).toHaveLength(0);
  });

  it('refuses practice results for unconfirmed modules', () => {
    const { module } = database.createLegoCandidate({
      id: randomUUID(),
      scope: 'global',
      scenarioId: null,
      category: 'viewpoint',
      title: '候选模块',
      triggers: [],
      payload,
      authorship: 'agent-candidate',
      now: NOW,
    });
    expect(() => engine.recordPracticeResult({
      moduleId: module.id, kind: 'spaced-review', result: 'success', now: NOW,
    })).toThrow('confirmed');
  });
});
