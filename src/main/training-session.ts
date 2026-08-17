import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

// Import the repository directly: the governance index re-exports the MCP
// kernel, which pulls the Agent SDK (ESM, import.meta) into the CJS main
// bundle and crashes packaged startup with createRequire({}.url).
import { GovernanceRepository } from '../agent/governance/repository';
import type { AgentRuntimePaths } from '../agent/runtime';
import { FormalMaterializer, validateCandidatePayload } from '../data/formal-materializer';
import type { ProductDatabase } from '../data/product-database';
import { TrainingEngine, type HintLevel } from '../training/engine';
import type {
  TrainingCandidate,
  TrainingDueItem,
  TrainingTurnState,
} from '../shared/contracts';
import type { ProviderProtocol } from '../shared/providers';

// Chat-form training session orchestration (WP-P1-04 wiring). The host owns the
// gate and all state transitions; the agent only produces content (questions,
// diagnoses, hints, candidate modules) through governed runs. Nothing the agent
// says can reopen or bypass the gate, and formal writes still travel through
// the governance staging database plus the idempotent materializer.

export interface TrainingAgentRunner {
  run(request: {
    prompt: string;
    workspace: { sessionsRoot: string; sessionId: string; create: boolean };
    paths: AgentRuntimePaths;
    provider: { baseUrl: string; apiKey: string; protocol: ProviderProtocol; model?: string };
    limits: { maxTurns: number };
    bashRuntime: { manifestPath: string; runtimeDirectory: string; cacheDirectory: string };
    governanceDatabasePath: string;
    resume?: string;
  }): Promise<{ agentSessionId: string; messages: unknown[] }>;
}

export interface TrainingProviderResolver {
  resolveActive(): Promise<{
    profile: { baseUrl: string; protocol: ProviderProtocol; model: string };
    apiKey: string;
  }>;
}

export interface TrainingRuntimeResolver {
  paths(): AgentRuntimePaths;
  manifestPath(): string;
  resolveBashRuntimeDirectory(): Promise<string>;
}

interface ActiveSession {
  id: string;
  sessionsRoot: string;
  workspaceSessionId: string;
  governanceDatabasePath: string;
  agentSessionId: string | null;
  workspaceCreated: boolean;
  questionId: string | null;
  questionPrompt: string | null;
  firstAttemptId: string | null;
  phase: TrainingTurnState['phase'];
  transcript: TrainingTurnState['transcript'];
  candidates: TrainingCandidate[];
  committedCount: number;
}

const resultMessageSchema = z.object({
  type: z.literal('result'),
  result: z.string().optional(),
});

const candidatePayloadSchema = z.object({
  title: z.string(),
  semantic_kernel: z.string(),
  logic_skeleton: z.array(z.string()),
  language_shells: z.array(z.string()),
});

export function extractFinalText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const parsed = resultMessageSchema.safeParse(messages[index]);
    if (parsed.success && parsed.data.result) return parsed.data.result;
  }
  throw new Error('The agent did not return a final response.');
}

export class TrainingSessionService {
  readonly #agent: TrainingAgentRunner;
  readonly #provider: TrainingProviderResolver;
  readonly #runtime: TrainingRuntimeResolver;
  readonly #product: ProductDatabase;
  readonly #engine: TrainingEngine;
  readonly #sessionsRoot: string;
  #session: ActiveSession | null = null;
  #busy = false;

  constructor(options: {
    agent: TrainingAgentRunner;
    provider: TrainingProviderResolver;
    runtime: TrainingRuntimeResolver;
    product: ProductDatabase;
    sessionsRoot: string;
  }) {
    this.#agent = options.agent;
    this.#provider = options.provider;
    this.#runtime = options.runtime;
    this.#product = options.product;
    this.#engine = new TrainingEngine(options.product);
    this.#sessionsRoot = path.resolve(options.sessionsRoot);
  }

  async start(topic: string): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const id = randomUUID();
      const sessionsRoot = path.join(this.#sessionsRoot, id);
      await mkdir(sessionsRoot, { recursive: true });
      const session: ActiveSession = {
        id,
        sessionsRoot,
        workspaceSessionId: `training-${id.slice(0, 18)}`,
        governanceDatabasePath: path.join(sessionsRoot, 'governance.sqlite'),
        agentSessionId: null,
        workspaceCreated: false,
        questionId: null,
        questionPrompt: null,
        firstAttemptId: null,
        phase: 'idle',
        transcript: [],
        candidates: [],
        committedCount: 0,
      };
      this.#session = session;

      const prompt = [
        'You are running one daily open-practice turn.',
        'Generate exactly ONE open professional question the user must answer aloud.',
        topic ? `The user chose this topic area: ${topic}.` : 'Choose a broadly professional topic.',
        'The question must be answerable in 2-4 minutes of speech.',
        'Do NOT provide any outline, answer, hints, or evaluation criteria.',
        'Reply with only the question text, nothing else.',
      ].join(' ');
      const output = await this.#runAgent(session, prompt, 4);
      const questionPrompt = extractFinalText(output.messages).trim();
      if (!questionPrompt) throw new Error('The agent returned an empty question.');

      const question = this.#engine.registerQuestion({
        prompt: questionPrompt,
        scope: 'global',
        origin: 'scheduler',
      });
      const gate = this.#engine.beginFirstAttempt(question.id);
      session.questionId = question.id;
      session.questionPrompt = questionPrompt;
      session.firstAttemptId = gate.attemptId;
      session.phase = 'first-attempt';
      session.transcript.push(
        { role: 'coach', kind: 'question', text: questionPrompt },
        {
          role: 'system',
          kind: 'status',
          text: '第一遍门禁开启：先独立回答（也可以明确"答不出来"），此阶段没有任何提示。',
        },
      );
      return this.#turnState();
    });
  }

  async closeFirst(input: {
    outcome: 'answered' | 'cannot-answer' | 'skipped';
    responseText: string;
  }): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('first-attempt');
      if (!session.firstAttemptId) throw new Error('No first attempt is open.');
      this.#engine.closeFirstAttempt(session.firstAttemptId, {
        outcome: input.outcome,
        responseText: input.responseText,
      });
      session.phase = 'first-closed';
      if (input.outcome === 'answered') {
        session.transcript.push({ role: 'user', kind: 'response', text: input.responseText });
      } else {
        session.transcript.push({
          role: 'user',
          kind: 'response',
          text: input.outcome === 'cannot-answer' ? '（我暂时答不出来）' : '（跳过这题）',
        });
      }
      session.transcript.push({
        role: 'system',
        kind: 'status',
        text: '第一遍已封存。现在可以请求诊断。',
      });
      return Promise.resolve(this.#turnState());
    });
  }

  async diagnose(): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('first-closed');
      if (!session.firstAttemptId) throw new Error('No closed first attempt.');
      this.#engine.releaseAssistance(session.firstAttemptId);
      const attempt = this.#product.getAttempt(session.firstAttemptId);
      const prompt = [
        'The user completed the protected first attempt. Diagnose it now.',
        `Question: ${session.questionPrompt}`,
        `First attempt (verbatim): ${attempt?.responseText || '(the user said they cannot answer yet)'}`,
        'Diagnose evidence-based sticking points across: question scoping, explicit viewpoint,',
        'reusable structure, concrete evidence, and natural spoken language.',
        'Every finding MUST quote the user\'s own words as evidence.',
        'Do NOT provide a better answer, an outline, or model wording. Diagnosis only.',
        'Reply in Chinese with at most five short findings.',
      ].join(' ');
      const output = await this.#runAgent(session, prompt, 6);
      const diagnosis = extractFinalText(output.messages).trim();
      const diagnostics = this.#splitFindings(diagnosis);
      for (const finding of diagnostics) {
        this.#product.addDiagnostic({
          id: randomUUID(),
          attemptId: session.firstAttemptId,
          dimension: 'structure',
          finding,
          evidenceQuote: '',
        });
      }
      session.phase = 'assistance';
      session.transcript.push({ role: 'coach', kind: 'diagnosis', text: diagnosis });
      return this.#turnState();
    });
  }

  async hint(level: HintLevel): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('assistance');
      if (!session.firstAttemptId) throw new Error('No attempt in assistance.');
      this.#engine.issueHint(session.firstAttemptId, level);
      const ladder: Record<HintLevel, string> = {
        L1: 'L1 goal hint: state only what communication task this kind of question demands. No content, no structure.',
        L2: 'L2 structure hint: give a reusable skeleton (3-5 abstract steps) without filling in any content.',
        L3: 'L3 cue hint: point at which of the user\'s own experiences or knowledge could be used, without organizing the wording for them.',
        L4: 'L4 demonstration: give one complete worked example answer.',
      };
      const prompt = [
        `Provide exactly one hint at level ${level} for the current question.`,
        `Question: ${session.questionPrompt}`,
        ladder[level],
        'Give ONLY this level. Never include higher-level help.',
        'Reply in Chinese, at most 120 words.',
      ].join(' ');
      const output = await this.#runAgent(session, prompt, 4);
      session.transcript.push({
        role: 'coach',
        kind: 'hint',
        text: `【${level}】${extractFinalText(output.messages).trim()}`,
      });
      return this.#turnState();
    });
  }

  async second(responseText: string): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('assistance');
      if (!session.questionId || !session.firstAttemptId) throw new Error('No open question.');
      this.#engine.recordSecondAttempt({
        questionId: session.questionId,
        firstAttemptId: session.firstAttemptId,
        responseText,
      });
      session.phase = 'second-done';
      session.transcript.push(
        { role: 'user', kind: 'response', text: responseText },
        { role: 'system', kind: 'status', text: '第二遍完成。现在可以提炼语言乐高候选。' },
      );
      return Promise.resolve(this.#turnState());
    });
  }

  async extract(): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('second-done');
      const first = session.firstAttemptId
        ? this.#product.getAttempt(session.firstAttemptId)
        : null;
      const prompt = [
        'Compare the two attempts and extract at most two candidate language LEGO modules.',
        `Question: ${session.questionPrompt}`,
        `First attempt: ${first?.responseText ?? ''}`,
        'Second attempt: (see the latest user response in this session context).',
        'For each candidate call mcp__artifact__submit_candidate with:',
        `session_id "${session.workspaceSessionId}", kind "language_module", scope "personal",`,
        'payload {"title":"...","category":"one of opening|scoping|viewpoint|reasoning|evidence|case|interaction|transition|closing","triggers":["..."],"semantic_kernel":"...","logic_skeleton":["..."],"language_shells":["..."]},',
        'provenance {"source_refs":[],"method":"daily-practice-extraction","generated_by":"mental-legos-agent"},',
        `and idempotency_key "extract-${session.id.slice(0, 8)}-<n>".`,
        'language_shells MUST reuse the user\'s own wording wherever possible.',
        'Only propose candidates meeting the granularity bar: one communication task,',
        'reusable across questions, speakable in 5-30 seconds.',
        'After submitting, reply in Chinese with a one-line summary per candidate.',
      ].join(' ');
      await this.#runAgent(session, prompt, 8);

      const repository = new GovernanceRepository(session.governanceDatabasePath);
      try {
        const pending = repository.listPendingCandidates(session.workspaceSessionId);
        session.candidates = pending.map((candidate) => {
          const payload = candidatePayloadSchema.parse(candidate.payload);
          validateCandidatePayload('language_module', candidate.payload);
          return {
            id: candidate.id,
            title: payload.title,
            semanticKernel: payload.semantic_kernel,
            logicSkeleton: payload.logic_skeleton,
            languageShells: payload.language_shells,
          };
        });
      } finally {
        repository.close();
      }
      session.phase = 'candidates-ready';
      session.transcript.push({
        role: 'coach',
        kind: 'candidates',
        text: session.candidates.length > 0
          ? `提炼出 ${session.candidates.length} 个候选模块，请逐个确认或拒绝。`
          : '这一轮没有提炼出符合粒度标准的候选模块。',
      });
      return this.#turnState();
    });
  }

  async confirm(candidateIds: string[]): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('candidates-ready');
      const known = new Set(session.candidates.map((candidate) => candidate.id));
      for (const id of candidateIds) {
        if (!known.has(id)) throw new Error('Unknown candidate id.');
      }
      const repository = new GovernanceRepository(session.governanceDatabasePath);
      let materializedCount: number;
      try {
        const { previewId } = repository.prepareCommit(candidateIds);
        const token = repository.issueConfirmationToken({ action: 'commit', previewId });
        repository.commitConfirmed({ token, previewId, userEdits: {} });
        const materializer = new FormalMaterializer(this.#product);
        const assets = repository.listFormalAssets()
          .filter((asset) => candidateIds.includes(asset.candidateId));
        const result = materializer.sync(assets);
        if (result.failed.length > 0) {
          throw new Error(`模块正式化失败：${result.failed[0]?.reason}`);
        }
        materializedCount = result.materialized.length;
        for (const item of result.materialized) {
          if (item.entity === 'lego-module') {
            this.#engine.scheduleInitialReview(item.assetId);
          }
        }
      } finally {
        repository.close();
      }
      session.committedCount += materializedCount;
      session.phase = 'committed';
      session.transcript.push({
        role: 'system',
        kind: 'committed',
        text: `已确认并写入 ${materializedCount} 个语言乐高模块，并安排了首次复现。`,
      });
      return this.#turnState();
    });
  }

  dueQueue(asOf = new Date().toISOString()): TrainingDueItem[] {
    return this.#engine.dueQueue(asOf).map(({ module, mastery }) => ({
      moduleId: module.id,
      title: module.title,
      stage: mastery.stage,
      dueAt: mastery.dueAt,
    }));
  }

  state(): TrainingTurnState {
    return this.#turnState();
  }

  async #runAgent(
    session: ActiveSession,
    prompt: string,
    maxTurns: number,
  ): Promise<{ agentSessionId: string; messages: unknown[] }> {
    const [{ profile, apiKey }, runtimeDirectory] = await Promise.all([
      this.#provider.resolveActive(),
      this.#runtime.resolveBashRuntimeDirectory(),
    ]);
    const output = await this.#agent.run({
      prompt,
      workspace: {
        sessionsRoot: session.sessionsRoot,
        sessionId: session.workspaceSessionId,
        create: !session.workspaceCreated,
      },
      paths: this.#runtime.paths(),
      provider: {
        baseUrl: profile.baseUrl,
        apiKey,
        protocol: profile.protocol,
        model: profile.model,
      },
      limits: { maxTurns },
      bashRuntime: {
        manifestPath: this.#runtime.manifestPath(),
        runtimeDirectory,
        cacheDirectory: path.join(session.sessionsRoot, '.wasmer-cache'),
      },
      governanceDatabasePath: session.governanceDatabasePath,
      ...(session.agentSessionId ? { resume: session.agentSessionId } : {}),
    });
    session.workspaceCreated = true;
    session.agentSessionId = output.agentSessionId;
    return output;
  }

  #requireSession(expectedPhase: TrainingTurnState['phase']): ActiveSession {
    if (!this.#session) throw new Error('No training session is active.');
    if (this.#session.phase !== expectedPhase) {
      throw new Error(`This step requires phase ${expectedPhase}, current phase is ${this.#session.phase}.`);
    }
    return this.#session;
  }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new Error('Another training step is still running.');
    this.#busy = true;
    try {
      return await work();
    } finally {
      this.#busy = false;
    }
  }

  #splitFindings(diagnosis: string): string[] {
    return diagnosis
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 5);
  }

  #turnState(): TrainingTurnState {
    const session = this.#session;
    if (!session) {
      return {
        sessionId: null,
        phase: 'idle',
        question: null,
        gate: null,
        transcript: [],
        candidates: [],
        committedCount: 0,
      };
    }
    const attempt = session.firstAttemptId
      ? this.#product.getAttempt(session.firstAttemptId)
      : null;
    const hintOrder: Array<'L1' | 'L2' | 'L3' | 'L4'> = ['L1', 'L2', 'L3', 'L4'];
    const nextHint = attempt && attempt.state === 'ASSISTANCE_ALLOWED'
      ? hintOrder[attempt.hintLevel === 'none' ? 0 : hintOrder.indexOf(attempt.hintLevel) + 1] ?? null
      : null;
    return {
      sessionId: session.id,
      phase: session.phase,
      question: session.questionId && session.questionPrompt
        ? { id: session.questionId, prompt: session.questionPrompt }
        : null,
      gate: attempt
        ? {
          attemptId: attempt.id,
          state: attempt.state,
          assistanceAllowed: attempt.state === 'ASSISTANCE_ALLOWED',
          nextHintLevel: nextHint,
        }
        : null,
      transcript: [...session.transcript],
      candidates: [...session.candidates],
      committedCount: session.committedCount,
    };
  }
}
