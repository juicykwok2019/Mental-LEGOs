import { randomUUID } from 'node:crypto';

import {
  type Attempt,
  type LegoModule,
  type MasteryStage,
  type MasteryState,
  type Question,
} from '../data/contracts';
import type { ProductDatabase } from '../data/product-database';

// Host-side training engine (WP-P1-04, WP-P1-06). Owns the product invariants
// the agent must never control: the first-attempt gate, the minimum-necessary
// hint ladder, and mastery scheduling. It never generates content — question
// text and diagnoses come from the agent through governed channels.

export type HintLevel = 'L1' | 'L2' | 'L3' | 'L4';

const HINT_ORDER: readonly HintLevel[] = ['L1', 'L2', 'L3', 'L4'];

// Stage-based spaced intervals in days (PRD §9; deterministic, adjustable later
// by real practice data). Regression shortens the interval automatically since
// the schedule always derives from the current stage.
const STAGE_INTERVAL_DAYS: Readonly<Record<MasteryStage, number>> = {
  candidate: 0,
  confirmed: 1,
  'visible-recall': 2,
  'prompted-recall': 4,
  'independent-recall': 7,
  transfer: 14,
  composition: 21,
  pressure: 30,
  'real-world': 45,
};

const STAGE_ORDER: readonly MasteryStage[] = [
  'candidate',
  'confirmed',
  'visible-recall',
  'prompted-recall',
  'independent-recall',
  'transfer',
  'composition',
  'pressure',
  'real-world',
];

export function nextDueAt(stage: MasteryStage, from: string): string {
  const days = STAGE_INTERVAL_DAYS[stage];
  const base = new Date(from).getTime();
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString();
}

export function promoteStage(stage: MasteryStage): MasteryStage {
  const index = STAGE_ORDER.indexOf(stage);
  const next = STAGE_ORDER[Math.min(index + 1, STAGE_ORDER.length - 1)];
  return next ?? stage;
}

export function regressStage(stage: MasteryStage): MasteryStage {
  const index = STAGE_ORDER.indexOf(stage);
  const floor = STAGE_ORDER.indexOf('confirmed');
  const previous = STAGE_ORDER[Math.max(index - 1, floor)];
  return previous ?? stage;
}

export interface GateView {
  attemptId: string;
  questionId: string;
  state: Attempt['state'];
  assistanceAllowed: boolean;
  nextHintLevel: HintLevel | null;
}

export class TrainingEngine {
  readonly #database: ProductDatabase;

  constructor(database: ProductDatabase) {
    this.#database = database;
  }

  // ─── Question intake ─────────────────────────────────────────────────────

  registerQuestion(input: {
    prompt: string;
    scope: Question['scope'];
    scenarioId?: string | null;
    origin: Question['origin'];
    questionType?: Question['questionType'];
    exploratory?: boolean;
    parentQuestionId?: string | null;
    targetModuleIds?: string[];
    pressure?: Question['pressure'];
    now?: string;
  }): Question {
    return this.#database.createQuestion({
      id: randomUUID(),
      scope: input.scope,
      scenarioId: input.scenarioId ?? null,
      prompt: input.prompt,
      origin: input.origin,
      questionType: input.questionType ?? null,
      exploratory: input.exploratory ?? false,
      parentQuestionId: input.parentQuestionId ?? null,
      targetModuleIds: input.targetModuleIds ?? [],
      pressure: input.pressure ?? 'none',
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }

  // ─── First-attempt gate ──────────────────────────────────────────────────

  beginFirstAttempt(questionId: string, now?: string): GateView {
    const question = this.#database.getQuestion(questionId);
    if (!question) throw new Error('Question does not exist.');
    const attempt = this.#database.createAttempt({
      id: randomUUID(),
      questionId,
      round: 'first',
      state: 'FIRST_ATTEMPT_RECORDING',
      outcome: null,
      responseText: '',
      recordingSourceId: null,
      openingDelayMs: null,
      durationMs: null,
      hintLevel: 'none',
      ...(now === undefined ? {} : { now }),
    });
    return this.#gateView(attempt);
  }

  closeFirstAttempt(
    attemptId: string,
    input: {
      outcome: 'answered' | 'cannot-answer' | 'skipped';
      responseText?: string;
      openingDelayMs?: number;
      durationMs?: number;
      recordingSourceId?: string | null;
      now?: string;
    },
  ): GateView {
    const attempt = this.#requireAttempt(attemptId);
    if (attempt.round !== 'first') throw new Error('Only first attempts pass through the gate.');
    if (attempt.state !== 'FIRST_ATTEMPT_RECORDING') {
      throw new Error('The first attempt is not recording.');
    }
    const closed = this.#database.updateAttempt(attemptId, {
      state: 'FIRST_ATTEMPT_CLOSED',
      outcome: input.outcome,
      responseText: input.responseText ?? '',
      openingDelayMs: input.openingDelayMs ?? null,
      durationMs: input.durationMs ?? null,
      recordingSourceId: input.recordingSourceId ?? null,
    }, input.now ?? new Date().toISOString());
    this.#database.recordPracticeEvent({
      id: randomUUID(),
      moduleId: null,
      attemptId,
      kind: 'first-attempt',
      result: input.outcome === 'answered' ? 'success' : 'partial',
      detail: input.outcome,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return this.#gateView(closed);
  }

  releaseAssistance(attemptId: string, now?: string): GateView {
    const attempt = this.#requireAttempt(attemptId);
    if (attempt.state !== 'FIRST_ATTEMPT_CLOSED') {
      throw new Error('Assistance opens only after the first attempt closes.');
    }
    const released = this.#database.updateAttempt(
      attemptId,
      { state: 'ASSISTANCE_ALLOWED' },
      now ?? new Date().toISOString(),
    );
    return this.#gateView(released);
  }

  assertAssistanceAllowed(attemptId: string): void {
    const attempt = this.#requireAttempt(attemptId);
    if (attempt.state !== 'ASSISTANCE_ALLOWED') {
      throw new Error('The first-attempt gate is closed; content assistance is blocked.');
    }
  }

  // ─── Minimum-necessary hint ladder ───────────────────────────────────────

  issueHint(attemptId: string, requested: HintLevel, now?: string): GateView {
    this.assertAssistanceAllowed(attemptId);
    const attempt = this.#requireAttempt(attemptId);
    const currentIndex = attempt.hintLevel === 'none'
      ? -1
      : HINT_ORDER.indexOf(attempt.hintLevel);
    const requestedIndex = HINT_ORDER.indexOf(requested);
    if (requestedIndex !== currentIndex + 1) {
      throw new Error('Hints escalate one level at a time from the lowest level.');
    }
    const updated = this.#database.updateAttempt(
      attemptId,
      { hintLevel: requested },
      now ?? new Date().toISOString(),
    );
    this.#database.recordPracticeEvent({
      id: randomUUID(),
      moduleId: null,
      attemptId,
      kind: 'hint-issued',
      result: 'not-applicable',
      detail: requested,
      ...(now === undefined ? {} : { now }),
    });
    return this.#gateView(updated);
  }

  // ─── Second attempt and practice results ─────────────────────────────────

  recordSecondAttempt(input: {
    questionId: string;
    firstAttemptId: string;
    responseText: string;
    durationMs?: number;
    recordingSourceId?: string | null;
    now?: string;
  }): Attempt {
    this.assertAssistanceAllowed(input.firstAttemptId);
    const attempt = this.#database.createAttempt({
      id: randomUUID(),
      questionId: input.questionId,
      round: 'second',
      state: 'ASSISTANCE_ALLOWED',
      outcome: 'answered',
      responseText: input.responseText,
      recordingSourceId: input.recordingSourceId ?? null,
      openingDelayMs: null,
      durationMs: input.durationMs ?? null,
      hintLevel: this.#requireAttempt(input.firstAttemptId).hintLevel,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    this.#database.recordPracticeEvent({
      id: randomUUID(),
      moduleId: null,
      attemptId: attempt.id,
      kind: 'second-attempt',
      result: 'success',
      detail: '',
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return attempt;
  }

  recordPracticeResult(input: {
    moduleId: string;
    attemptId?: string | null;
    kind: 'variation-call' | 'composition-call' | 'pressure-call' | 'spaced-review' | 'real-world-report';
    result: 'success' | 'partial' | 'failure';
    detail?: string;
    now?: string;
  }): MasteryState {
    const now = input.now ?? new Date().toISOString();
    const module = this.#database.getLegoModule(input.moduleId);
    if (!module) throw new Error('Module does not exist.');
    if (module.status !== 'confirmed') {
      throw new Error('Practice results only apply to confirmed modules.');
    }
    this.#database.recordPracticeEvent({
      id: randomUUID(),
      moduleId: input.moduleId,
      attemptId: input.attemptId ?? null,
      kind: input.kind,
      result: input.result,
      detail: input.detail ?? '',
      now,
    });
    const mastery = this.#database.getMasteryState(input.moduleId);
    if (!mastery) throw new Error('Mastery state is missing for a confirmed module.');
    const stage = input.result === 'success'
      ? promoteStage(mastery.stage)
      : input.result === 'failure'
        ? regressStage(mastery.stage)
        : mastery.stage;
    return this.#database.updateMasteryState(input.moduleId, {
      stage,
      dueAt: nextDueAt(stage, now),
      lastPracticedAt: now,
    }, now);
  }

  // ─── Scheduling ──────────────────────────────────────────────────────────

  dueQueue(asOf: string): Array<{ module: LegoModule; mastery: MasteryState }> {
    return this.#database.listDueModules(asOf);
  }

  scheduleInitialReview(moduleId: string, now?: string): MasteryState {
    const at = now ?? new Date().toISOString();
    const mastery = this.#database.getMasteryState(moduleId);
    if (!mastery) throw new Error('Mastery state is missing; confirm the module first.');
    return this.#database.updateMasteryState(moduleId, {
      dueAt: nextDueAt(mastery.stage, at),
    }, at);
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  #requireAttempt(attemptId: string): Attempt {
    const attempt = this.#database.getAttempt(attemptId);
    if (!attempt) throw new Error('Attempt does not exist.');
    return attempt;
  }

  #gateView(attempt: Attempt): GateView {
    const currentIndex = attempt.hintLevel === 'none'
      ? -1
      : HINT_ORDER.indexOf(attempt.hintLevel);
    const nextHint = HINT_ORDER[currentIndex + 1] ?? null;
    return {
      attemptId: attempt.id,
      questionId: attempt.questionId,
      state: attempt.state,
      assistanceAllowed: attempt.state === 'ASSISTANCE_ALLOWED',
      nextHintLevel: attempt.state === 'ASSISTANCE_ALLOWED' ? nextHint : null,
    };
  }
}
