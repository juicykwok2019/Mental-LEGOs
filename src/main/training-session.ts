import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

// Import the repository directly: the governance index re-exports the MCP
// kernel, which pulls the Agent SDK (ESM, import.meta) into the CJS main
// bundle and crashes packaged startup with createRequire({}.url).
import { GovernanceRepository } from '../agent/governance/repository';
import type { AgentRuntimePaths } from '../agent/runtime';
import {
  questionTypeSchema,
  type Question,
  type QuestionType,
  type Scenario,
} from '../data/contracts';
import { FormalMaterializer, validateCandidatePayload } from '../data/formal-materializer';
import type { ProductDatabase } from '../data/product-database';
import { TrainingEngine, type HintLevel } from '../training/engine';
import { usageFromAgentMessages } from './usage-ledger';
import {
  AGENT_EXCERPT_CHARACTERS,
} from '../shared/contracts';
import type {
  ProfileSeedInput,
  ProfileState,
  ScenarioCreateInput,
  ScenarioSummary,
  TrainingCandidate,
  TrainingDueItem,
  TrainingTurnState,
} from '../shared/contracts';
import type { ProviderProtocol } from '../shared/providers';

// Session orchestration for the confirmed core loop (one open question → one
// spoken answer → co-extracted modules → transfer through a changed question)
// across three entries: system-initiated open practice, user-initiated
// scenarios, and speech rehearsal. The host owns every state transition; the
// agent only produces content through governed runs.

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

type Mode = 'open' | 'scenario' | 'speech';

interface ActiveSession {
  id: string;
  mode: Mode;
  scenarioId: string | null;
  sessionsRoot: string;
  workspaceSessionId: string;
  governanceDatabasePath: string;
  agentSessionId: string | null;
  workspaceCreated: boolean;
  questionId: string | null;
  questionPrompt: string | null;
  firstAttemptId: string | null;
  secondResponse: string | null;
  variationQuestionId: string | null;
  confirmedModuleIds: string[];
  phase: TrainingTurnState['phase'];
  transcript: TrainingTurnState['transcript'];
  candidates: TrainingCandidate[];
  committedCount: number;
}

const resultMessageSchema = z.object({
  type: z.literal('result'),
  result: z.string().optional(),
});

// Providers routinely improvise type labels despite instructions, so accept
// any string and normalize afterwards — a mislabeled type must never void an
// otherwise good generation (questionType is nullable in the data model).
const generatedQuestionSchema = z.object({
  question_type: z.string().trim().min(1),
  exploratory: z.boolean().default(false),
  question: z.string().trim().min(8),
});

const preparationSchema = z.object({
  analysis: z.string().trim().min(1),
  questions: z.array(z.object({
    question_type: z.string().trim().min(1),
    question: z.string().trim().min(8),
  })).min(3).max(10),
});

const QUESTION_TYPE_SYNONYMS: Record<string, QuestionType> = {
  opinion: 'viewpoint', view: 'viewpoint', judgment: 'viewpoint', stance: 'viewpoint',
  观点: 'viewpoint', 观点判断: 'viewpoint',
  explanation: 'mechanism', how: 'mechanism', principle: 'mechanism', why: 'mechanism',
  technical: 'mechanism', 机制: 'mechanism', 机制解释: 'mechanism',
  choice: 'decision', 'trade-off': 'decision', tradeoff: 'decision', strategy: 'decision',
  决策: 'decision', 方案决策: 'decision',
  experience: 'case-recall', case: 'case-recall', example: 'case-recall',
  behavioral: 'case-recall', story: 'case-recall', project: 'case-recall',
  经验: 'case-recall', 经验调用: 'case-recall',
  pushback: 'challenge', objection: 'challenge', skeptical: 'challenge',
  质疑: 'challenge', 质疑挑战: 'challenge',
  'follow-up': 'pressure-probe', followup: 'pressure-probe', probe: 'pressure-probe',
  stress: 'pressure-probe', pressure: 'pressure-probe',
  追问: 'pressure-probe', 追问压力: 'pressure-probe',
};

export function normalizeQuestionType(value: string): QuestionType | null {
  const key = value.trim().toLowerCase().replace(/[\s_]+/gu, '-');
  const direct = questionTypeSchema.safeParse(key);
  if (direct.success) return direct.data;
  return QUESTION_TYPE_SYNONYMS[key] ?? QUESTION_TYPE_SYNONYMS[value.trim()] ?? null;
}

const variationJudgementSchema = z.object({
  result: z.enum(['success', 'partial', 'failure']),
  comment: z.string().trim().min(1),
});

const candidatePayloadSchema = z.object({
  title: z.string(),
  category: z.string().default('viewpoint'),
  domain: z.string().optional(),
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

export function parseJsonReply<T>(text: string, schema: z.ZodType<T>): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The agent reply contained no JSON object.');
  return schema.parse(JSON.parse(text.slice(start, end + 1)));
}

const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  viewpoint: '观点判断',
  mechanism: '机制解释',
  decision: '方案决策',
  'case-recall': '经验调用',
  challenge: '质疑挑战',
  'pressure-probe': '追问压力',
};

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export class TrainingSessionService {
  readonly #agent: TrainingAgentRunner;
  readonly #provider: TrainingProviderResolver;
  readonly #runtime: TrainingRuntimeResolver;
  readonly #product: ProductDatabase;
  readonly #engine: TrainingEngine;
  readonly #sessionsRoot: string;
  readonly #onAgentUsage: ((usage: { inputTokens: number; outputTokens: number }) => void) | null;
  #session: ActiveSession | null = null;
  #busy = false;

  constructor(options: {
    agent: TrainingAgentRunner;
    provider: TrainingProviderResolver;
    runtime: TrainingRuntimeResolver;
    product: ProductDatabase;
    sessionsRoot: string;
    onAgentUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  }) {
    this.#agent = options.agent;
    this.#provider = options.provider;
    this.#runtime = options.runtime;
    this.#product = options.product;
    this.#engine = new TrainingEngine(options.product);
    this.#sessionsRoot = path.resolve(options.sessionsRoot);
    this.#onAgentUsage = options.onAgentUsage ?? null;
  }

  // ─── Profile ─────────────────────────────────────────────────────────────

  profileState(): ProfileState {
    const seed = this.#product.getProfileSeed();
    return {
      seed: seed
        ? {
          direction: seed.direction,
          currentWork: seed.currentWork,
          targetScenarios: seed.targetScenarios,
          material: seed.material,
        }
        : null,
      confirmedAssertions: this.#product.listProfileAssertions('confirmed')
        .slice(0, 20)
        .map((assertion) => assertion.statement),
      moduleCount: this.#product.listLegoModules({ status: 'confirmed' }).length,
      knowledgeGapCount: this.#product.countKnowledgeGaps(),
    };
  }

  saveProfile(input: ProfileSeedInput): ProfileState {
    this.#product.saveProfileSeed(input);
    return this.profileState();
  }

  #profileContext(): string {
    const seed = this.#product.getProfileSeed();
    if (!seed) throw new Error('先完成三句话的专业画像，再开始训练。');
    const assertions = this.#product.listProfileAssertions('confirmed').slice(0, 10);
    const modules = this.#product.listLegoModules({ status: 'confirmed' }).slice(0, 15);
    const gaps = this.#product.listRecentKnowledgeGaps(5);
    return [
      `Professional direction: ${truncate(seed.direction, 500)}`,
      seed.currentWork ? `Current work: ${truncate(seed.currentWork, 800)}` : '',
      seed.targetScenarios ? `Target scenarios: ${truncate(seed.targetScenarios, 500)}` : '',
      seed.material ? `User-provided material excerpt: ${truncate(seed.material, 2500)}` : '',
      assertions.length > 0
        ? `Confirmed profile observations: ${assertions
          .map((entry) => truncate(entry.statement, 150)).join(' | ')}`
        : '',
      modules.length > 0
        ? `Existing confirmed modules (title → triggers): ${modules
          .map((module) => `${module.title} → ${module.triggers.join('/')}`)
          .join(' | ')}`
        : '',
      gaps.length > 0
        ? `Known knowledge gaps (do NOT re-ask these directly): ${gaps
          .map((entry) => truncate(entry, 100)).join(' | ')}`
        : '',
    ].filter(Boolean).join('\n');
  }

  // ─── Open practice entry ─────────────────────────────────────────────────

  async start(input: {
    topic: string;
    scenarioId: string | null;
    questionId: string | null;
  }): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      if (input.scenarioId && input.questionId) {
        return this.#startScenarioQuestion(input.scenarioId, input.questionId);
      }
      const session = await this.#createSession('open', null);
      const context = this.#profileContext();
      const recentTypes = this.#product.listRecentQuestionTypes(3);
      const prompt = [
        'You are running one daily open-practice turn of a spoken-communication trainer.',
        'User profile (the question MUST be grounded in it — this is not a general knowledge quiz):',
        context,
        input.topic ? `The user asked to focus on: ${input.topic}.` : '',
        'Generate exactly ONE open professional question answerable in 2-4 minutes of speech.',
        `Question types: viewpoint, mechanism, decision, case-recall, challenge, pressure-probe.`,
        recentTypes.length > 0
          ? `Recently used types (pick a DIFFERENT one): ${recentTypes.join(', ')}.`
          : '',
        'If the question reaches beyond what the profile clearly supports, set exploratory=true.',
        'Do NOT include any outline, answer, hints, or evaluation criteria.',
        'Reply with ONLY this JSON: {"question_type":"...","exploratory":false,"question":"..."}',
      ].filter(Boolean).join('\n');
      const output = await this.#runAgent(session, prompt, 4);
      const generated = parseJsonReply(extractFinalText(output.messages), generatedQuestionSchema);
      const question = this.#engine.registerQuestion({
        prompt: generated.question,
        scope: 'global',
        origin: 'scheduler',
        questionType: normalizeQuestionType(generated.question_type),
        exploratory: generated.exploratory,
      });
      this.#beginGate(session, question);
      return this.#turnState();
    });
  }

  #beginGate(session: ActiveSession, question: Question): void {
    const gate = this.#engine.beginFirstAttempt(question.id);
    session.questionId = question.id;
    session.questionPrompt = question.prompt;
    session.firstAttemptId = gate.attemptId;
    session.secondResponse = null;
    session.candidates = [];
    session.phase = 'first-attempt';
    const typeLabel = question.questionType
      ? QUESTION_TYPE_LABELS[question.questionType as QuestionType] ?? question.questionType
      : null;
    session.transcript.push(
      {
        role: 'coach',
        kind: 'question',
        text: `${question.exploratory ? '【探索题】' : ''}${typeLabel ? `【${typeLabel}】` : ''}${question.prompt}`,
      },
      {
        role: 'system',
        kind: 'status',
        text: question.exploratory
          ? '第一遍门禁开启。这是探索题：答不出来只会记录为画像信息，不算表达失败。'
          : '第一遍门禁开启：先独立开口回答（也可以明确"答不出来"），此阶段没有任何提示。',
      },
    );
  }

  // ─── Gate transitions ────────────────────────────────────────────────────

  async closeFirst(input: {
    outcome: 'answered' | 'cannot-answer' | 'skipped';
    responseText: string;
    recordingId: string | null;
    openingDelayMs: number | null;
    durationMs: number | null;
  }): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('first-attempt');
      if (!session.firstAttemptId) throw new Error('No first attempt is open.');
      this.#engine.closeFirstAttempt(session.firstAttemptId, {
        outcome: input.outcome,
        responseText: input.responseText,
        ...(input.openingDelayMs === null ? {} : { openingDelayMs: input.openingDelayMs }),
        ...(input.durationMs === null ? {} : { durationMs: input.durationMs }),
      });
      if (input.outcome === 'answered') {
        session.transcript.push({ role: 'user', kind: 'response', text: input.responseText });
        session.phase = 'first-closed';
        session.transcript.push({
          role: 'system',
          kind: 'status',
          text: '第一遍已封存。现在可以请求诊断。',
        });
      } else if (input.outcome === 'cannot-answer') {
        session.transcript.push({ role: 'user', kind: 'response', text: '（暂时答不出来）' });
        session.phase = 'gap-query';
        session.transcript.push({
          role: 'system',
          kind: 'gap-note',
          text: '答不出来也是合格的第一遍。请判断：是没想过这个问题（知识缺口），还是有想法但组织不出来（表达缺口）？',
        });
      } else {
        session.transcript.push({ role: 'user', kind: 'response', text: '（跳过这题）' });
        session.phase = 'round-complete';
      }
      return Promise.resolve(this.#turnState());
    });
  }

  async resolveGap(gap: 'knowledge' | 'expression'): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('gap-query');
      if (!session.firstAttemptId || !session.questionId) throw new Error('No gapped attempt.');
      this.#product.updateAttempt(session.firstAttemptId, { gap });
      if (gap === 'expression') {
        session.phase = 'first-closed';
        session.transcript.push({
          role: 'system',
          kind: 'status',
          text: '记为表达缺口：你有判断，只是还没长出语言。进入诊断与提示阶梯。',
        });
        return this.#turnState();
      }
      // Knowledge gap: record it into the growing profile as a candidate note,
      // give a short primer (the gate is closed, content is allowed), end round.
      this.#product.createKnowledgeCandidate({
        id: randomUUID(),
        scope: 'global',
        scenarioId: null,
        kind: 'assumption',
        title: truncate(`未形成判断：${session.questionPrompt ?? ''}`, 120),
        content: `用户在此问题上标记了知识缺口：${session.questionPrompt ?? ''}`,
        sourceSegmentIds: [],
      });
      const prompt = [
        'The user marked a KNOWLEDGE gap on this question (they have no formed judgment yet):',
        `Question: ${session.questionPrompt}`,
        'Give a compact primer in Chinese (max 200 words): the 2-3 main schools of thought or',
        'considerations, without pretending the user holds any of them. End with one reflective',
        'question they can chew on. This is input material, not their voice.',
      ].join('\n');
      const output = await this.#runAgent(session, prompt, 4);
      session.transcript.push({
        role: 'coach',
        kind: 'gap-note',
        text: extractFinalText(output.messages).trim(),
      });
      session.phase = 'round-complete';
      session.transcript.push({
        role: 'system',
        kind: 'status',
        text: '知识缺口已记入画像（不算表达失败）。等你形成自己的判断后，这个话题会再回来。',
      });
      return this.#turnState();
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
        `First attempt (verbatim transcript, may contain ASR errors — interpret charitably`,
        `and note "按你的意思理解为…" where needed): ${attempt?.responseText || '(expression gap: no first wording)'}`,
        'Diagnose evidence-based sticking points across: question scoping, explicit viewpoint,',
        'reusable structure, concrete evidence, natural spoken language.',
        'Every finding MUST quote the user\'s own words as evidence.',
        'Do NOT provide a better answer, an outline, or model wording. Diagnosis only.',
        'Reply in Chinese with at most five short findings.',
      ].join('\n');
      const output = await this.#runAgent(session, prompt, 6);
      const diagnosis = extractFinalText(output.messages).trim();
      for (const finding of diagnosis.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 5)) {
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
        L3: 'L3 cue hint: point at which of the user\'s own experiences or knowledge (from their profile) could be used, without organizing the wording.',
        L4: 'L4 demonstration: give one complete worked example answer.',
      };
      const prompt = [
        `Provide exactly one hint at level ${level} for the current question.`,
        `Question: ${session.questionPrompt}`,
        ladder[level],
        'Give ONLY this level. Never include higher-level help. Reply in Chinese, max 120 words.',
      ].join('\n');
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
      session.secondResponse = responseText;
      session.phase = 'second-done';
      session.transcript.push(
        { role: 'user', kind: 'response', text: responseText },
        { role: 'system', kind: 'status', text: '第二遍完成。可以提炼语言乐高，场景模式下也可以继续追问。' },
      );
      return Promise.resolve(this.#turnState());
    });
  }

  // ─── Extraction, confirmation, variation ─────────────────────────────────

  async extract(): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('second-done');
      const first = session.firstAttemptId
        ? this.#product.getAttempt(session.firstAttemptId)
        : null;
      const scope = session.mode === 'open' ? 'personal' : 'scenario';
      const prompt = [
        'Compare the two attempts and extract at most two candidate language LEGO modules.',
        `Question: ${session.questionPrompt}`,
        `First attempt: ${first?.responseText ?? '(none)'}`,
        `Second attempt: ${session.secondResponse ?? ''}`,
        'For each candidate call mcp__artifact__submit_candidate with:',
        `session_id "${session.workspaceSessionId}", kind "language_module", scope "${scope}",`,
        'payload {"title":"...","category":"one of opening|scoping|viewpoint|reasoning|evidence|case|interaction|transition|closing|speech-composite",',
        '"domain":"generic for cross-field communication moves, professional for field-specific judgments",',
        '"triggers":["question cues that should recall this module"],',
        '"semantic_kernel":"...","logic_skeleton":["..."],"language_shells":["..."]},',
        'provenance {"source_refs":[],"method":"practice-extraction","generated_by":"mental-legos-agent"},',
        `and idempotency_key "extract-${session.id.slice(0, 8)}-<n>".`,
        'language_shells MUST reuse the user\'s own second-attempt wording wherever possible.',
        'Granularity bar: one communication task, reusable across questions, speakable in 5-30 seconds.',
        'After submitting, reply in Chinese with a one-line summary per candidate.',
      ].join('\n');
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
            category: payload.category,
            domain: payload.domain ?? null,
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
          ? `提炼出 ${session.candidates.length} 个候选模块。外壳用的是你自己的话，逐个确认、修改或拒绝。`
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
      let materializedIds: string[];
      try {
        const { previewId } = repository.prepareCommit(candidateIds);
        const token = repository.issueConfirmationToken({ action: 'commit', previewId });
        repository.commitConfirmed({ token, previewId, userEdits: {} });
        const materializer = new FormalMaterializer(
          this.#product,
          session.scenarioId ? { scenarioId: session.scenarioId } : {},
        );
        const assets = repository.listFormalAssets()
          .filter((asset) => candidateIds.includes(asset.candidateId));
        const result = materializer.sync(assets);
        if (result.failed.length > 0) {
          throw new Error(`模块正式化失败：${result.failed[0]?.reason}`);
        }
        materializedIds = result.materialized
          .filter((item) => item.entity === 'lego-module')
          .map((item) => item.assetId);
        for (const moduleId of materializedIds) {
          this.#engine.scheduleInitialReview(moduleId);
        }
      } finally {
        repository.close();
      }
      session.committedCount += materializedIds.length;
      session.confirmedModuleIds.push(...materializedIds);
      session.transcript.push({
        role: 'system',
        kind: 'committed',
        text: `已确认并写入 ${materializedIds.length} 个模块，安排了首次复现。`,
      });
      if (materializedIds.length === 0) {
        session.phase = 'round-complete';
        return this.#turnState();
      }
      return this.#startVariation(session, materializedIds[0]!);
    });
  }

  async #startVariation(session: ActiveSession, moduleId: string): Promise<TrainingTurnState> {
    const module = this.#product.getLegoModule(moduleId);
    const version = module?.currentVersion
      ? this.#product.getLegoVersion(moduleId, module.currentVersion)
      : null;
    try {
      const prompt = [
        'The user just confirmed this language module. Test transfer immediately with ONE',
        'changed question that should recall the same module through different cues:',
        `Module: ${module?.title} | kernel: ${version?.payload.semanticKernel}`,
        `Original question: ${session.questionPrompt}`,
        'Change the question type or situational frame (e.g. viewpoint → challenge, or move it',
        'into a client/executive/interview situation). Do not mention the module or the answer.',
        'Reply with ONLY this JSON: {"question_type":"...","exploratory":false,"question":"..."}',
      ].join('\n');
      const output = await this.#runAgent(session, prompt, 4);
      const generated = parseJsonReply(extractFinalText(output.messages), generatedQuestionSchema);
      const question = this.#engine.registerQuestion({
        prompt: generated.question,
        scope: session.mode === 'open' ? 'global' : 'scenario',
        scenarioId: session.scenarioId,
        origin: 'variation',
        questionType: normalizeQuestionType(generated.question_type),
        parentQuestionId: session.questionId,
        targetModuleIds: [moduleId],
      });
      session.variationQuestionId = question.id;
      session.phase = 'variation';
      session.transcript.push(
        { role: 'coach', kind: 'question', text: `【变体调用】${generated.question}` },
        {
          role: 'system',
          kind: 'status',
          text: '换了一种问法。直接开口回答，检验刚确认的模块能否被调用；也可以跳过。',
        },
      );
    } catch {
      session.phase = 'round-complete';
      session.transcript.push({
        role: 'system',
        kind: 'status',
        text: '变体问题生成失败，本轮到此结束；该模块的复现已在日程中。',
      });
    }
    return this.#turnState();
  }

  async answerVariation(responseText: string): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('variation');
      const questionId = session.variationQuestionId;
      const moduleId = session.confirmedModuleIds[session.confirmedModuleIds.length - 1];
      if (!questionId || !moduleId) throw new Error('No variation question is open.');
      const variationQuestion = this.#product.getQuestion(questionId);
      const attempt = this.#product.createAttempt({
        id: randomUUID(),
        questionId,
        round: 'variation',
        state: 'ASSISTANCE_ALLOWED',
        outcome: 'answered',
        responseText,
        recordingSourceId: null,
        hintLevel: 'none',
      });
      session.transcript.push({ role: 'user', kind: 'response', text: responseText });
      const module = this.#product.getLegoModule(moduleId);
      const version = module?.currentVersion
        ? this.#product.getLegoVersion(moduleId, module.currentVersion)
        : null;
      const prompt = [
        'Judge whether the user transferred their confirmed module to the changed question.',
        `Module kernel: ${version?.payload.semanticKernel}`,
        `Changed question: ${variationQuestion?.prompt}`,
        `User answer: ${responseText}`,
        'success = the kernel was recalled and adapted; partial = fragments appeared without the',
        'core; failure = the module did not surface. Judge recall, not eloquence.',
        'Reply with ONLY this JSON: {"result":"success|partial|failure","comment":"one Chinese sentence"}',
      ].join('\n');
      const output = await this.#runAgent(session, prompt, 4);
      const judged = parseJsonReply(extractFinalText(output.messages), variationJudgementSchema);
      const mastery = this.#engine.recordPracticeResult({
        moduleId,
        attemptId: attempt.id,
        kind: 'variation-call',
        result: judged.result,
        detail: judged.comment,
      });
      session.phase = 'round-complete';
      session.transcript.push({
        role: 'coach',
        kind: 'variation-result',
        text: `迁移判定：${judged.result === 'success' ? '成功' : judged.result === 'partial' ? '部分成功' : '未调用'}。${judged.comment}（掌握阶段 → ${mastery.stage}，下次复现 ${mastery.dueAt ?? '未安排'}）`,
      });
      return this.#turnState();
    });
  }

  async skipVariation(): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('variation');
      const moduleId = session.confirmedModuleIds[session.confirmedModuleIds.length - 1];
      if (moduleId) {
        this.#product.recordPracticeEvent({
          id: randomUUID(),
          moduleId,
          attemptId: null,
          kind: 'variation-call',
          result: 'not-applicable',
          detail: 'skipped',
        });
      }
      session.phase = 'round-complete';
      session.transcript.push({
        role: 'system',
        kind: 'status',
        text: '已跳过变体调用（已记录）。该模块的间隔复现仍在日程中。',
      });
      return Promise.resolve(this.#turnState());
    });
  }

  async followUp(): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#session;
      if (!session || (session.phase !== 'second-done' && session.phase !== 'round-complete')) {
        throw new Error('追问只能在一轮问答完成后发起。');
      }
      if (session.mode === 'open') {
        throw new Error('连续追问属于场景与演讲模式。');
      }
      const prompt = [
        'Continue the scenario simulation with ONE pressing follow-up question, as the',
        'counterpart would: probe the weakest part of the user\'s latest answer, ask for',
        'evidence, or challenge a claim. Stay in the scenario context.',
        `Previous question: ${session.questionPrompt}`,
        `User's latest answer: ${session.secondResponse ?? '(first answer only)'}`,
        'Reply with ONLY this JSON: {"question_type":"pressure-probe","exploratory":false,"question":"..."}',
      ].join('\n');
      const output = await this.#runAgent(session, prompt, 4);
      const generated = parseJsonReply(extractFinalText(output.messages), generatedQuestionSchema);
      const question = this.#engine.registerQuestion({
        prompt: generated.question,
        scope: 'scenario',
        scenarioId: session.scenarioId,
        origin: 'scenario-analysis',
        questionType: 'pressure-probe',
        parentQuestionId: session.questionId,
        pressure: 'follow-up',
      });
      this.#beginGate(session, question);
      return this.#turnState();
    });
  }

  // ─── Scenario entry ──────────────────────────────────────────────────────

  listScenarios(): ScenarioSummary[] {
    return this.#product.listScenarios()
      .filter((scenario) => scenario.status !== 'archived')
      .map((scenario) => this.#scenarioSummary(scenario));
  }

  createScenario(input: ScenarioCreateInput): ScenarioSummary {
    const scenario = this.#product.createScenario({
      id: randomUUID(),
      type: input.type,
      title: input.title,
      objective: input.objective,
      counterpart: input.counterpart,
      scheduledFor: null,
      status: 'active',
    });
    if (input.worries) this.#product.setScenarioWorries(scenario.id, input.worries);
    return this.#scenarioSummary(scenario);
  }

  addScenarioMaterial(input: {
    scenarioId: string; label: string; content: string; intent?: string;
  }): ScenarioSummary {
    const scenario = this.#product.getScenario(input.scenarioId);
    if (!scenario) throw new Error('Scenario does not exist.');
    const source = this.#product.registerSource({
      id: randomUUID(),
      scenarioId: scenario.id,
      scope: 'scenario',
      kind: 'pasted-text',
      label: input.label,
      intent: input.intent ?? '',
      contentHash: createHash('sha256').update(input.content, 'utf8').digest('hex'),
      mediaPath: null,
      retention: 'keep',
      authorizedAt: new Date().toISOString(),
    });
    const segments = [];
    for (let offset = 0; offset < input.content.length; offset += 1500) {
      segments.push({
        id: randomUUID(),
        sourceId: source.id,
        content: input.content.slice(offset, offset + 1500),
        startMs: null,
        endMs: null,
        page: Math.floor(offset / 1500) + 1,
        speaker: null,
        confidence: null,
      });
    }
    this.#product.addSourceSegments(segments);
    this.#product.recordConsentEvent({
      id: randomUUID(),
      action: 'material-authorized',
      objectRef: `source:${source.id}`,
      scope: 'scenario',
      decision: 'granted',
    });
    return this.#scenarioSummary(scenario);
  }

  async prepareScenario(scenarioId: string): Promise<ScenarioSummary> {
    return this.#exclusive(async () => {
      const scenario = this.#product.getScenario(scenarioId);
      if (!scenario) throw new Error('Scenario does not exist.');
      const extras = this.#product.getScenarioExtras(scenarioId);
      // Present each material as its own block with the user's stated intent,
      // so 出题 can honour "这是 JD，重点针对算法要求" style guidance per source.
      const materialText = truncate(
        this.#product.listScenarioSources(scenarioId).map((source) => [
          `【材料：${source.label}】`,
          source.intent ? `用户希望这份材料这样用：${source.intent}` : '',
          this.#product.readSourceContent(source.id),
        ].filter(Boolean).join('\n')).join('\n\n'),
        AGENT_EXCERPT_CHARACTERS,
      );
      const session = await this.#createSession(
        scenario.type === 'speech' ? 'speech' : 'scenario',
        scenarioId,
      );
      const speech = scenario.type === 'speech';
      const prompt = [
        speech
          ? 'Prepare a speech-rehearsal plan for this presentation scenario.'
          : 'Prepare the user for this real communication scenario.',
        `Scenario: ${scenario.title} (${scenario.type}) | counterpart: ${scenario.counterpart}`,
        `Objective: ${scenario.objective}`,
        extras?.worries ? `The user worries about being asked: ${extras.worries}` : '',
        materialText ? `Authorized materials:\n${materialText}` : 'No materials were provided.',
        materialText.includes('用户希望这份材料这样用')
          ? 'When a material states a usage intent, weight your questions toward that intent.'
          : '',
        `User profile for grounding:\n${this.#profileContext()}`,
        speech
          ? [
            'Produce: (1) analysis — what this audience will judge and where the risks are;',
            '(2) 3-6 rehearsal tasks as questions: the first MUST be a full trial-run task',
            '("请完整试讲一遍……" with the time budget), followed by segment rehearsals and',
            'likely audience Q&A questions.',
          ].join(' ')
          : [
            'Produce: (1) analysis — what the counterpart will likely evaluate, the highest-risk',
            'topics, and which existing modules or gaps matter; (2) 4-8 targeted questions the',
            'counterpart would realistically ask, ordered by likelihood, mixing types.',
          ].join(' '),
        'Never include model answers.',
        'question_type MUST be exactly one of: viewpoint, mechanism, decision, case-recall, challenge, pressure-probe.',
        'Reply with ONLY this JSON: {"analysis":"Chinese text","questions":[{"question_type":"viewpoint","question":"..."}]}',
      ].filter(Boolean).join('\n');
      const output = await this.#runAgent(session, prompt, 8);
      const prepared = parseJsonReply(extractFinalText(output.messages), preparationSchema);
      this.#product.setScenarioAnalysis(scenarioId, prepared.analysis);
      for (const item of prepared.questions) {
        this.#engine.registerQuestion({
          prompt: item.question,
          scope: 'scenario',
          scenarioId,
          origin: 'scenario-analysis',
          questionType: normalizeQuestionType(item.question_type),
        });
      }
      return this.#scenarioSummary(this.#product.getScenario(scenarioId)!);
    });
  }

  async #startScenarioQuestion(scenarioId: string, questionId: string): Promise<TrainingTurnState> {
    const scenario = this.#product.getScenario(scenarioId);
    if (!scenario) throw new Error('Scenario does not exist.');
    const question = this.#product.getQuestion(questionId);
    if (!question || question.scenarioId !== scenarioId) {
      throw new Error('Question does not belong to this scenario.');
    }
    const session = await this.#createSession(
      scenario.type === 'speech' ? 'speech' : 'scenario',
      scenarioId,
    );
    this.#beginGate(session, question);
    return this.#turnState();
  }

  async reviewScenario(input: {
    scenarioId: string;
    transcript: string;
    outcomeNote: string;
  }): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const scenario = this.#product.getScenario(input.scenarioId);
      if (!scenario) throw new Error('Scenario does not exist.');
      const source = this.#product.registerSource({
        id: randomUUID(),
        scenarioId: scenario.id,
        scope: 'scenario',
        kind: 'transcript',
        label: '事后复盘转写',
        intent: '',
        contentHash: createHash('sha256').update(input.transcript, 'utf8').digest('hex'),
        mediaPath: null,
        retention: 'keep',
        authorizedAt: new Date().toISOString(),
      });
      this.#product.addSourceSegments([{
        id: randomUUID(),
        sourceId: source.id,
        content: truncate(input.transcript, 100_000),
        startMs: null,
        endMs: null,
        page: null,
        speaker: null,
        confidence: null,
      }]);
      const session = await this.#createSession(
        scenario.type === 'speech' ? 'speech' : 'scenario',
        scenario.id,
      );
      session.secondResponse = null;
      const prompt = [
        'Post-event review of a real communication the user authorized for analysis.',
        `Scenario: ${scenario.title} (${scenario.type}) | objective: ${scenario.objective}`,
        input.outcomeNote ? `The user's own outcome note: ${input.outcomeNote}` : '',
        `Authorized transcript:\n${truncate(input.transcript, AGENT_EXCERPT_CHARACTERS)}`,
        'Align question → actual answer → missed knowledge → on-the-spot wording → outcome.',
        'Identify: successful module recalls, misses, and NEW wording worth keeping.',
        'Then submit at most three candidate modules (new or clearly better wording) via',
        `mcp__artifact__submit_candidate with session_id "${session.workspaceSessionId}",`,
        'kind "language_module", scope "scenario", the same payload shape as practice extraction',
        '(title/category/domain/triggers/semantic_kernel/logic_skeleton/language_shells),',
        'provenance {"source_refs":[],"method":"post-event-review","generated_by":"mental-legos-agent"},',
        `idempotency_key "review-${session.id.slice(0, 8)}-<n>".`,
        'Finally reply in Chinese: a compact review (what landed, what was missed, what to drill).',
      ].filter(Boolean).join('\n');
      const output = await this.#runAgent(session, prompt, 10);
      session.transcript.push({
        role: 'coach',
        kind: 'analysis',
        text: extractFinalText(output.messages).trim(),
      });
      const repository = new GovernanceRepository(session.governanceDatabasePath);
      try {
        const pending = repository.listPendingCandidates(session.workspaceSessionId);
        session.candidates = pending.map((candidate) => {
          const payload = candidatePayloadSchema.parse(candidate.payload);
          validateCandidatePayload('language_module', candidate.payload);
          return {
            id: candidate.id,
            title: payload.title,
            category: payload.category,
            domain: payload.domain ?? null,
            semanticKernel: payload.semantic_kernel,
            logicSkeleton: payload.logic_skeleton,
            languageShells: payload.language_shells,
          };
        });
      } finally {
        repository.close();
      }
      session.phase = session.candidates.length > 0 ? 'candidates-ready' : 'round-complete';
      return this.#turnState();
    });
  }

  deleteScenarioMaterial(input: { scenarioId: string; sourceId: string }): ScenarioSummary {
    const scenario = this.#product.getScenario(input.scenarioId);
    if (!scenario) throw new Error('Scenario does not exist.');
    const owned = this.#product.listScenarioSources(input.scenarioId)
      .some((source) => source.id === input.sourceId);
    if (!owned) throw new Error('这份材料不属于当前场景。');
    this.#product.deleteSource(input.sourceId);
    return this.#scenarioSummary(scenario);
  }

  #scenarioSummary(scenario: Scenario): ScenarioSummary {
    const extras = this.#product.getScenarioExtras(scenario.id);
    const questions = this.#product.listScenarioQuestions(scenario.id);
    const materials = this.#product.listScenarioSources(scenario.id).map((source) => ({
      id: source.id,
      label: source.label,
      intent: source.intent,
      characters: source.characters,
      addedAt: source.createdAt,
    }));
    return {
      id: scenario.id,
      type: scenario.type,
      title: scenario.title,
      objective: scenario.objective,
      counterpart: scenario.counterpart,
      status: scenario.status,
      materialCount: materials.length,
      materialCharacters: materials.reduce((total, material) => total + material.characters, 0),
      materials,
      moduleCount: this.#product.listLegoModules({ scenarioId: scenario.id }).length,
      preparedQuestions: questions.map((question) => ({
        id: question.id,
        prompt: question.prompt,
        questionType: question.questionType,
        answered: question.answered,
      })),
      analysis: extras?.analysis ? extras.analysis : null,
    };
  }

  // ─── Scheduling ──────────────────────────────────────────────────────────

  dueQueue(asOf = new Date().toISOString()): TrainingDueItem[] {
    return this.#engine.dueQueue(asOf).map(({ module, mastery }) => ({
      moduleId: module.id,
      title: module.title,
      stage: mastery.stage,
      dueAt: mastery.dueAt,
    }));
  }

  recordRealWorldUse(input: {
    moduleId: string;
    result: 'success' | 'partial' | 'failure';
    note: string;
  }): void {
    this.#engine.recordPracticeResult({
      moduleId: input.moduleId,
      kind: 'real-world-report',
      result: input.result,
      detail: input.note,
    });
  }

  state(): TrainingTurnState {
    return this.#turnState();
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  async #createSession(mode: Mode, scenarioId: string | null): Promise<ActiveSession> {
    const id = randomUUID();
    const sessionsRoot = path.join(this.#sessionsRoot, id);
    await mkdir(sessionsRoot, { recursive: true });
    const session: ActiveSession = {
      id,
      mode,
      scenarioId,
      sessionsRoot,
      workspaceSessionId: `training-${id.slice(0, 18)}`,
      governanceDatabasePath: path.join(sessionsRoot, 'governance.sqlite'),
      agentSessionId: null,
      workspaceCreated: false,
      questionId: null,
      questionPrompt: null,
      firstAttemptId: null,
      secondResponse: null,
      variationQuestionId: null,
      confirmedModuleIds: [],
      phase: 'idle',
      transcript: [],
      candidates: [],
      committedCount: 0,
    };
    this.#session = session;
    return session;
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
    if (this.#onAgentUsage) {
      const usage = usageFromAgentMessages(output.messages);
      if (usage) this.#onAgentUsage(usage);
    }
    return output;
  }

  #requireSession(expectedPhase: TrainingTurnState['phase']): ActiveSession {
    if (!this.#session) throw new Error('No training session is active.');
    if (this.#session.phase !== expectedPhase) {
      throw new Error(
        `This step requires phase ${expectedPhase}, current phase is ${this.#session.phase}.`,
      );
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

  #turnState(): TrainingTurnState {
    const session = this.#session;
    if (!session) {
      return {
        sessionId: null,
        mode: null,
        scenarioId: null,
        phase: 'idle',
        question: null,
        gate: null,
        transcript: [],
        candidates: [],
        committedCount: 0,
        busyHint: null,
      };
    }
    const attempt = session.firstAttemptId
      ? this.#product.getAttempt(session.firstAttemptId)
      : null;
    const question = session.questionId
      ? this.#product.getQuestion(session.questionId)
      : null;
    const hintOrder: Array<'L1' | 'L2' | 'L3' | 'L4'> = ['L1', 'L2', 'L3', 'L4'];
    const nextHint = attempt && attempt.state === 'ASSISTANCE_ALLOWED'
      ? hintOrder[attempt.hintLevel === 'none' ? 0 : hintOrder.indexOf(attempt.hintLevel) + 1] ?? null
      : null;
    return {
      sessionId: session.id,
      mode: session.mode,
      scenarioId: session.scenarioId,
      phase: session.phase,
      question: question
        ? {
          id: question.id,
          prompt: question.prompt,
          questionType: question.questionType,
          exploratory: question.exploratory,
        }
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
      busyHint: null,
    };
  }
}
