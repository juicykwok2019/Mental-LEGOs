import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
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
import {
  FormalMaterializer,
  normalizeLegoMaterial,
  validateCandidatePayload,
} from '../data/formal-materializer';
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
  speechStats?: string;
  compositionPair?: string[] | null;
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
  // Present only when the question was deliberately designed around a
  // user-linked composable pair. Hidden from the user until after the first
  // attempt — composition must be recalled unprompted, then revealed.
  composition_pair: z.array(z.string().trim().min(1)).length(2).optional(),
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

// Shared between the in-session judgement (answerVariation) and the eval-only
// judgeVariation entry, so Suite 3 always measures the exact production prompt.
export function buildVariationJudgementPrompt(input: {
  semanticKernel: string;
  languageShell?: string;
  variationQuestion: string;
  responseText: string;
}): string {
  return [
    'Judge whether the user transferred their confirmed module to the changed question.',
    `Module kernel: ${input.semanticKernel}`,
    ...(input.languageShell ? [`Module original shell (the user's stored wording): ${input.languageShell}`] : []),
    `Changed question: ${input.variationQuestion}`,
    `User answer: ${input.responseText}`,
    'success = the kernel was recalled and adapted; partial = fragments appeared without the',
    'core; failure = the module did not surface. Judge recall, not eloquence.',
    'IMPORTANT: if the answer merely repeats the original shell nearly verbatim, that is',
    'partial — the question changed but the wording was not adapted to it.',
    'Reply with ONLY this JSON: {"result":"success|partial|failure","comment":"one Chinese sentence"}',
  ].join('\n');
}

// 第二遍与无限复练共用的对比点评 prompt（每一遍都有诊断，两处不得漂移）。
function buildProgressNotePrompt(
  question: string,
  previousResponse: string,
  newResponse: string,
): string {
  return [
    'The user re-attempted the same question to polish their spoken answer.',
    `Question: ${question}`,
    `Previous attempt: ${previousResponse || '(none)'}`,
    `New attempt: ${newResponse}`,
    'In Chinese, give at most three short findings: what improved and what still',
    'sticks, each quoting the user\'s own words as evidence.',
    'Do NOT provide a better answer, an outline, or model wording — the user',
    'decides for themselves when the answer is good enough.',
  ].join('\n');
}

// 画像观察的候选载荷：一句话 + 内嵌逐字引用（详见 extract 的观察规则）。
const observationPayloadSchema = z.object({
  statement: z.string().trim().min(4).max(500),
});

// 观察语句的相似判定（确定性）：归一化后互相包含，或字符 2-gram 包含度
// ≥0.45（中文措辞漂移下 3-gram 过碎）。相似=同一条观察 → 补证据而非新建；
// 跨轮重复出现即为晋升"有据观察"的依据。近义反转（"最前"vs"最后"）这类
// 语义边界交给 agent 的"勿重复已知观察"指令与人工复核兜底。
export function similarObservationStatements(a: string, b: string): boolean {
  const normalize = (value: string): string => value
    .replace(/[\p{P}\p{S}\p{Z}\s]/gu, '')
    .toLowerCase();
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length === 0 || nb.length === 0) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const grams = (value: string): Set<string> => {
    const set = new Set<string>();
    for (let index = 0; index + 2 <= value.length; index += 1) set.add(value.slice(index, index + 2));
    return set;
  };
  const [small, large] = na.length <= nb.length ? [na, nb] : [nb, na];
  const smallGrams = grams(small);
  if (smallGrams.size === 0) return false;
  const largeGrams = grams(large);
  let hits = 0;
  for (const gram of smallGrams) {
    if (largeGrams.has(gram)) hits += 1;
  }
  return hits / smallGrams.size >= 0.45;
}

const candidatePayloadSchema = z.object({
  title: z.string(),
  category: z.string().default('viewpoint'),
  domain: z.string().optional(),
  semantic_kernel: z.string(),
  logic_skeleton: z.array(z.string()),
  language_shells: z.array(z.string()),
});

function candidatesFromPending(
  pending: Array<{ id: string; payload: unknown }>,
): TrainingCandidate[] {
  return pending.flatMap((candidate) => {
    try {
      const normalized = normalizeLegoMaterial(candidate.payload);
      validateCandidatePayload('language_module', normalized);
      const payload = candidatePayloadSchema.parse(normalized);
      return [{
        id: candidate.id,
        title: payload.title,
        category: payload.category,
        domain: payload.domain ?? null,
        semanticKernel: payload.semantic_kernel,
        logicSkeleton: payload.logic_skeleton,
        languageShells: payload.language_shells,
      }];
    } catch {
      // Drop one malformed candidate instead of voiding the whole extraction;
      // the shape is provider output, not user data.
      return [];
    }
  });
}

export function extractFinalText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const parsed = resultMessageSchema.safeParse(messages[index]);
    if (parsed.success && parsed.data.result) return parsed.data.result;
  }
  throw new Error('The agent did not return a final response.');
}

// Provider 输出是敌意输入：kimi 等模型偶发未转义引号、字符串内裸换行、
// 尾逗号（2026-08-18 冒烟轮实测三处失败同此根因）。先按常见毛病修复
// 再解析，修不好才抛错。
export function repairJsonCandidate(raw: string): string {
  let out = '';
  let inString = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (!inString) {
      if (character === '"') inString = true;
      out += character;
      continue;
    }
    if (character === '\\') {
      out += character;
      if (index + 1 < raw.length) {
        out += raw[index + 1];
        index += 1;
      }
      continue;
    }
    if (character === '"') {
      // 只有后面跟着 JSON 定界符的引号才是字符串结束；否则视为内容引号。
      let lookahead = index + 1;
      while (lookahead < raw.length && /\s/u.test(raw[lookahead]!)) lookahead += 1;
      const next = raw[lookahead];
      if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
        inString = false;
        out += character;
      } else {
        out += '\\"';
      }
      continue;
    }
    if (character === '\n') { out += '\\n'; continue; }
    if (character === '\r') continue;
    out += character;
  }
  return out.replace(/,\s*([}\]])/gu, '$1');
}

export function parseJsonReply<T>(text: string, schema: z.ZodType<T>): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The agent reply contained no JSON object.');
  const candidate = text.slice(start, end + 1);
  try {
    return schema.parse(JSON.parse(candidate));
  } catch (reason) {
    try {
      return schema.parse(JSON.parse(repairJsonCandidate(candidate)));
    } catch {
      throw reason instanceof Error ? reason : new Error(String(reason));
    }
  }
}

const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  viewpoint: '观点判断',
  mechanism: '机制解释',
  decision: '方案决策',
  'case-recall': '经验调用',
  challenge: '质疑挑战',
  'pressure-probe': '追问压力',
};

export function speechStatsLine(
  responseText: string,
  durationMs: number,
  pauseCount: number | null,
  longestPauseMs: number | null,
): string {
  const minutes = durationMs / 60_000;
  const characters = responseText.replace(/\s/gu, '').length;
  const pace = Math.round(characters / minutes);
  return [
    `试讲用时 ${Math.floor(durationMs / 60_000)} 分 ${Math.round((durationMs % 60_000) / 1000)} 秒`,
    `约 ${characters} 字 · 语速 ~${pace} 字/分（汉语演讲舒适区约 180-220 字/分）`,
    // null means pauses were not measured (text submission or history replay)
    // — say nothing rather than falsely claiming a fluent delivery.
    pauseCount === null
      ? ''
      : pauseCount > 0
        ? `明显停顿 ${pauseCount} 次，最长 ${((longestPauseMs ?? 0) / 1000).toFixed(1)} 秒`
        : '没有超过 1.2 秒的明显停顿',
  ].filter(Boolean).join(' · ');
}

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
  readonly #mediaRoot: string | null;
  readonly #onAgentUsage: ((usage: { inputTokens: number; outputTokens: number }) => void) | null;
  #session: ActiveSession | null = null;
  #busy = false;

  constructor(options: {
    agent: TrainingAgentRunner;
    provider: TrainingProviderResolver;
    runtime: TrainingRuntimeResolver;
    product: ProductDatabase;
    sessionsRoot: string;
    mediaRoot?: string;
    onAgentUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  }) {
    this.#agent = options.agent;
    this.#provider = options.provider;
    this.#runtime = options.runtime;
    this.#product = options.product;
    this.#engine = new TrainingEngine(options.product);
    this.#sessionsRoot = path.resolve(options.sessionsRoot);
    this.#mediaRoot = options.mediaRoot ? path.resolve(options.mediaRoot) : null;
    this.#onAgentUsage = options.onAgentUsage ?? null;
  }

  // Register the on-device recording as a source and return its id so the
  // attempt row can reference which audio it was spoken into.
  async #linkRecording(
    recordingId: string | null | undefined,
    scenarioId: string | null,
  ): Promise<string | null> {
    if (!recordingId || !this.#mediaRoot) return null;
    if (this.#product.sourceExists(recordingId)) return recordingId;
    const mediaPath = path.join(this.#mediaRoot, `recording-${recordingId}.wav`);
    let contentHash: string;
    try {
      contentHash = createHash('sha256').update(await readFile(mediaPath)).digest('hex');
    } catch {
      return null; // recording file already gone — nothing to link
    }
    this.#product.registerSource({
      id: recordingId,
      scenarioId,
      scope: scenarioId ? 'scenario' : 'global',
      kind: 'recording',
      label: '语音回答录音',
      intent: '',
      contentHash,
      mediaPath,
      retention: 'keep',
      authorizedAt: new Date().toISOString(),
    });
    return recordingId;
  }

  // ─── Profile ─────────────────────────────────────────────────────────────

  profileState(): ProfileState {
    // 时效复审的惰性触发点：过期的已确认事实在这里降回待复核。
    this.#product.sweepStaleAssertions();
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
      pendingObservationCount: this.#product.listProfileAssertions('candidate')
        .filter((assertion) => assertion.tier !== 'pending-hypothesis'
          || assertion.evidenceSegmentIds.length >= 2)
        .length,
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
      (() => {
        const pairs: string[] = [];
        for (const module of modules) {
          for (const link of this.#product.listModuleLinks(module.id)) {
            if (link.relation === 'composes-with' && link.direction === 'out') {
              pairs.push(`${module.title} + ${link.otherTitle}`);
            }
          }
        }
        return pairs.length > 0
          ? `Composable module pairs the user linked: ${pairs.slice(0, 5).join(' | ')}`
          : '';
      })(),
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
        'If composable module pairs are listed, you MAY design the question so a strong',
        'answer naturally requires combining one linked pair (composition practice) —',
        'without naming the modules in the question. When you do, add',
        '"composition_pair":["module title A","module title B"] to the JSON.',
        'If the question reaches beyond what the profile clearly supports, set exploratory=true.',
        'Do NOT include any outline, answer, hints, or evaluation criteria.',
        'Reply with ONLY this JSON: {"question_type":"...","exploratory":false,"question":"..."}',
      ].filter(Boolean).join('\n');
      const generated = await this.#runJsonAgent(session, prompt, 4, generatedQuestionSchema);
      const targetModuleIds = (generated.composition_pair ?? [])
        .flatMap((title) => {
          const match = this.#product.listLegoModules({ status: 'confirmed' })
            .find((module) => module.title === title);
          return match ? [match.id] : [];
        });
      const question = this.#engine.registerQuestion({
        prompt: generated.question,
        scope: 'global',
        origin: 'scheduler',
        questionType: normalizeQuestionType(generated.question_type),
        exploratory: generated.exploratory,
        targetModuleIds,
      });
      this.#beginGate(session, question);
      session.compositionPair = generated.composition_pair ?? null;
      return this.#turnState();
    });
  }

  #beginGate(session: ActiveSession, question: Question): void {
    // Practice history must survive re-entry: attempts are persisted, so a
    // question the user trained before replays its past answers up front.
    const history = this.#product.listQuestionAttempts(question.id)
      .filter((attempt) => attempt.responseText.trim().length > 0);
    if (history.length > 0) {
      session.transcript.push({
        role: 'system',
        kind: 'status',
        text: `这道题你之前练过（共 ${history.length} 次有效作答）——历史回顾：`,
      });
      for (const attempt of history.slice(-5)) {
        const day = attempt.createdAt.slice(0, 10);
        const roundLabel = attempt.round === 'first' ? '第一遍'
          : attempt.round === 'second' ? '复练' : '变体';
        session.transcript.push({
          role: 'user',
          kind: 'response',
          text: `〔${day} · ${roundLabel}〕${attempt.responseText}`,
          recordingId: attempt.recordingSourceId,
        });
        if (session.mode === 'speech' && attempt.durationMs && attempt.durationMs > 0) {
          session.transcript.push({
            role: 'system',
            kind: 'status',
            text: speechStatsLine(attempt.responseText, attempt.durationMs, null, null),
          });
        }
      }
      if (history.length > 5) {
        session.transcript.push({
          role: 'system',
          kind: 'status',
          text: `（更早的 ${history.length - 5} 次作答已省略）`,
        });
      }
      session.transcript.push({
        role: 'system',
        kind: 'status',
        text: '以上为历史记录。现在开始新的一轮——',
      });
    }
    const gate = this.#engine.beginFirstAttempt(question.id);
    session.questionId = question.id;
    session.questionPrompt = question.prompt;
    session.firstAttemptId = gate.attemptId;
    session.secondResponse = null;
    session.candidates = [];
    session.compositionPair = null;
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
    pauseCount?: number | null;
    longestPauseMs?: number | null;
  }): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('first-attempt');
      if (!session.firstAttemptId) throw new Error('No first attempt is open.');
      const recordingSourceId = await this.#linkRecording(input.recordingId, session.scenarioId);
      this.#engine.closeFirstAttempt(session.firstAttemptId, {
        outcome: input.outcome,
        responseText: input.responseText,
        recordingSourceId,
        ...(input.openingDelayMs === null ? {} : { openingDelayMs: input.openingDelayMs }),
        ...(input.durationMs === null ? {} : { durationMs: input.durationMs }),
      });
      if (input.outcome === 'answered') {
        session.transcript.push({
          role: 'user', kind: 'response', text: input.responseText, recordingId: recordingSourceId,
        });
        // Speech rehearsal gets measurable delivery stats from the recording:
        // duration, pace, and real (timestamp-derived) pauses.
        if (session.mode === 'speech' && input.durationMs && input.durationMs > 0) {
          const stats = speechStatsLine(
            input.responseText, input.durationMs, input.pauseCount ?? null, input.longestPauseMs ?? null,
          );
          session.speechStats = stats;
          session.transcript.push({ role: 'system', kind: 'status', text: stats });
        }
        session.phase = 'first-closed';
        if (session.compositionPair && session.compositionPair.length === 2) {
          session.transcript.push({
            role: 'system',
            kind: 'status',
            text: `揭示：这其实是一道组合题——设计目标是让你连用【${session.compositionPair[0]}】和【${session.compositionPair[1]}】两块积木。回头看刚才的回答，两块都调用出来了吗？诊断会重点看这一点。`,
          });
        }
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
        ...(session.mode === 'speech'
          ? [
            'This was a SPEECH rehearsal — also diagnose delivery structure: does it have a',
            'clear opening hook, distinct points, and a deliberate close? Comment on pacing',
            'and pauses using these measured stats:',
            session.speechStats ?? '(no delivery stats were captured)',
          ]
          : []),
        ...(session.compositionPair && session.compositionPair.length === 2
          ? [
            'This question was designed as COMPOSITION practice for two of the user\'s own',
            `modules: 【${session.compositionPair[0]}】 and 【${session.compositionPair[1]}】.`,
            'Assess whether each module\'s core judgment actually appeared in the answer',
            '(quote the matching words), and whether the two connected naturally.',
          ]
          : []),
        'Number the findings 1. 2. 3. — one finding per number.',
        'Every finding MUST contain a verbatim quote copied character-for-character from',
        'the user\'s answer, wrapped in 「」. Paraphrased or invented quotes are forbidden;',
        'a finding you cannot anchor with a verbatim quote must not be written.',
        'Each quote must be a meaningful phrase (at least 4 characters), not a lone filler',
        'word. A finding about something MISSING must still quote the user\'s words at the',
        'exact spot where the gap occurs (e.g. what they said instead).',
        'Voice: a professional coach speaking to the user face-to-face, in plain spoken',
        'Chinese. Do NOT use English words except inside quotes of the user\'s own words,',
        'or proper nouns / names that have no common Chinese form. Do NOT use reviewer',
        'jargon (结构断层、收敛、闭环、颗粒度 and the like). Every finding must be',
        'understandable to someone outside the user\'s industry and make clear what to do',
        'differently next time. Plain does not mean sloppy — keep it precise and professional.',
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
        'Plain spoken Chinese, as a coach talking face-to-face: no English words except',
        'quoting the user or necessary proper nouns; no reviewer jargon; precise but',
        'understandable to a layman.',
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

  async second(responseText: string, recordingId: string | null = null): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('assistance');
      if (!session.questionId || !session.firstAttemptId) throw new Error('No open question.');
      const previousResponse = this.#product.getAttempt(session.firstAttemptId)?.responseText ?? '';
      const recordingSourceId = await this.#linkRecording(recordingId, session.scenarioId);
      this.#engine.recordSecondAttempt({
        questionId: session.questionId,
        firstAttemptId: session.firstAttemptId,
        responseText,
        recordingSourceId,
      });
      session.secondResponse = responseText;
      session.phase = 'second-done';
      session.transcript.push({
        role: 'user', kind: 'response', text: responseText, recordingId: recordingSourceId,
      });
      // 每一遍都有诊断（2026-09-09 用户决策）：第二遍与复练同一套对比点评，
      // 练到用户满意为止，提炼永远由用户主动发起。
      if (session.mode !== 'speech') {
        const output = await this.#runAgent(
          session,
          buildProgressNotePrompt(session.questionPrompt ?? '', previousResponse, responseText),
          4,
        );
        session.transcript.push({
          role: 'coach',
          kind: 'diagnosis',
          text: extractFinalText(output.messages).trim(),
        });
      }
      session.transcript.push({
        role: 'system',
        kind: 'status',
        text: '可以继续"再练一遍"打磨，满意了就提炼语言乐高；场景模式下也可以继续追问。',
      });
      return this.#turnState();
    });
  }

  // Unlimited rehearsal rounds in every mode, until the user is satisfied and
  // moves to extraction — half-polished wording must not get committed into
  // the library. Speech rounds get measured delivery stats (no token cost);
  // other modes get an evidence-quoting progress note against the previous
  // round, never a model answer.
  async rehearse(input: {
    responseText: string;
    recordingId: string | null;
    durationMs: number | null;
    pauseCount?: number | null;
    longestPauseMs?: number | null;
  }): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#session;
      if (!session) throw new Error('No training session is active.');
      if (!['first-closed', 'assistance', 'second-done'].includes(session.phase)) {
        throw new Error('先完成第一遍回答，再进行复练。');
      }
      if (!session.questionId || !session.firstAttemptId) throw new Error('No open question.');
      if (session.phase === 'first-closed') {
        this.#engine.releaseAssistance(session.firstAttemptId);
      }
      const previousResponse = session.secondResponse
        ?? this.#product.getAttempt(session.firstAttemptId)?.responseText
        ?? '';
      const recordingSourceId = await this.#linkRecording(input.recordingId, session.scenarioId);
      this.#engine.recordSecondAttempt({
        questionId: session.questionId,
        firstAttemptId: session.firstAttemptId,
        responseText: input.responseText,
        recordingSourceId,
        ...(input.durationMs === null || input.durationMs === undefined
          ? {}
          : { durationMs: input.durationMs }),
      });
      session.secondResponse = input.responseText;
      session.phase = 'second-done';
      session.transcript.push({
        role: 'user', kind: 'response', text: input.responseText, recordingId: recordingSourceId,
      });
      if (session.mode === 'speech') {
        if (input.durationMs && input.durationMs > 0) {
          const stats = speechStatsLine(
            input.responseText, input.durationMs, input.pauseCount ?? null, input.longestPauseMs ?? null,
          );
          session.speechStats = stats;
          session.transcript.push({ role: 'system', kind: 'status', text: stats });
        } else {
          session.transcript.push({
            role: 'system',
            kind: 'status',
            text: '这一遍是文字提交，没有实测数据——用 🎙 录音试讲才能得到时长、语速和停顿反馈。',
          });
        }
      } else {
        const output = await this.#runAgent(
          session,
          buildProgressNotePrompt(session.questionPrompt ?? '', previousResponse, input.responseText),
          4,
        );
        session.transcript.push({
          role: 'coach',
          kind: 'diagnosis',
          text: extractFinalText(output.messages).trim(),
        });
      }
      session.transcript.push({
        role: 'system',
        kind: 'status',
        text: '可以继续"再练一遍"打磨，满意了就提炼语言乐高。',
      });
      return Promise.resolve(this.#turnState());
    });
  }

  // Speech mode: on-demand delivery critique of the latest rehearsal — manual
  // so the fast stats-only loop stays free, feedback costs tokens only when
  // asked for.
  async critique(): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('second-done');
      if (session.mode !== 'speech') throw new Error('单遍点评只在演讲训练中提供。');
      const prompt = [
        'The user rehearsed a speech segment and asked for a delivery critique.',
        `Task: ${session.questionPrompt}`,
        `Latest rehearsal (verbatim transcript): ${session.secondResponse ?? ''}`,
        `Measured delivery stats: ${session.speechStats ?? '(text submission, no measured stats)'}`,
        'In Chinese, give at most four short findings on structure (opening hook,',
        'point separation, close), clarity, and pacing — each quoting the user\'s',
        'own words as evidence.',
        'Do NOT provide model wording, a rewritten script, or an outline.',
      ].join('\n');
      const output = await this.#runAgent(session, prompt, 4);
      session.transcript.push({
        role: 'coach',
        kind: 'diagnosis',
        text: extractFinalText(output.messages).trim(),
      });
      return this.#turnState();
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
      // 三种历史各有语义：活跃（待复核/已确认）=勿重复；rejected（"不是我"）
      // =用户否认过的永久禁区；archived（"不再是我"=过时）=退出全部清单，
      // 习惯若真回来允许重新观察、走全新假设→复核循环。
      const allAssertions = this.#product.listProfileAssertions();
      const knownObservations = allAssertions
        .filter((assertion) => assertion.status === 'candidate' || assertion.status === 'confirmed')
        .slice(0, 10)
        .map((assertion) => assertion.statement);
      const deniedObservations = allAssertions
        .filter((assertion) => assertion.status === 'rejected')
        .slice(0, 10)
        .map((assertion) => assertion.statement);
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
        'Use EXACTLY these snake_case keys; semantic_kernel, logic_skeleton and',
        'language_shells are required and logic_skeleton/language_shells are string arrays.',
        'language_shells MUST reuse the user\'s own second-attempt wording wherever possible.',
        'Each language shell MUST be one complete, independently speakable sentence of',
        'roughly 15-120 characters — never a fragment shorter than a full clause.',
        'Granularity bar: one communication task, reusable across questions, speakable in 5-30 seconds.',
        'ALSO stage profile observations with the same tool: kind "profile_observation",',
        'scope "personal", payload {"statement":"..."}, provenance {"source_refs":[],',
        '"method":"practice-observation","generated_by":"mental-legos-agent"},',
        `idempotency_key "observe-${session.id.slice(0, 8)}-<n>". Rules:`,
        '- At most two. Each is ONE plain-Chinese sentence about HOW the user speaks',
        '  (habit / strength / recurring gap) and MUST contain a verbatim 「」quote from',
        '  this round. No quote, no entry.',
        '- Never: personality or emotion inference; private facts (salary, employers,',
        '  health, names); two entries that contradict; reworded variants of known',
        '  entries. Context-dependent behavior goes in one conditional sentence.',
        ...(knownObservations.length > 0
          ? [
            '- Known entries below: if this round clearly shows one AGAIN, restage it with',
            '  the same statement plus a fresh quote (that renews it); otherwise skip it.',
            ...knownObservations.map((statement) => `  [known] ${statement.slice(0, 80)}`),
          ]
          : []),
        ...(deniedObservations.length > 0
          ? [
            '- The user denied these — never stage them or near-equivalents again:',
            ...deniedObservations.map((statement) => `  [denied] ${statement.slice(0, 80)}`),
          ]
          : []),
        'After submitting, reply in Chinese with a one-line summary per candidate.',
      ].join('\n');
      // 预算 8→10：提炼现在要提交积木+观察两类候选，留足工具调用轮次。
      await this.#runAgent(session, prompt, 10);

      const repository = new GovernanceRepository(session.governanceDatabasePath);
      try {
        const pending = repository.listPendingCandidates(session.workspaceSessionId);
        session.candidates = candidatesFromPending(
          pending.filter((candidate) => candidate.kind === 'language_module'),
        );
        // 画像观察不走训练确认流：以"待验假设"直接落库，去个人底座复核
        // （产品决策 2026-09-09：确认才使用，二次独立证据晋升有据观察）。
        const observed = this.#recordObservations(
          pending.filter((candidate) => candidate.kind === 'profile_observation'),
          session.firstAttemptId,
        );
        if (observed.noted > 0 || observed.surfaced > 0 || observed.promoted > 0 || observed.renewed > 0) {
          const parts: string[] = [];
          if (observed.noted > 0) parts.push(`记下 ${observed.noted} 条新观察线索（满两轮独立证据才会请你复核）`);
          if (observed.surfaced > 0) parts.push(`${observed.surfaced} 条线索已满两轮证据，进入待复核`);
          if (observed.promoted > 0) parts.push(`${observed.promoted} 条晋升为有据观察`);
          if (observed.renewed > 0) parts.push(`${observed.renewed} 条已有观察再次出现（已续期）`);
          session.transcript.push({
            role: 'system',
            kind: 'status',
            text: `画像观察：${parts.join('，')}——在「个人底座」等你复核。只有你确认过的才会用于出题。`,
          });
        }
      } finally {
        repository.close();
      }
      if (session.candidates.length > 0) {
        session.phase = 'candidates-ready';
        session.transcript.push({
          role: 'coach',
          kind: 'candidates',
          text: `提炼出 ${session.candidates.length} 个候选模块。外壳用的是你自己的话，逐个确认、修改或拒绝。`,
        });
      } else {
        // Zero candidates must never dead-end the round: fall back to
        // second-done so rehearse / retry-extraction / exit all stay open.
        session.phase = 'second-done';
        session.transcript.push({
          role: 'coach',
          kind: 'candidates',
          text: '这一轮没有提炼出符合粒度标准的候选模块——回答里还没有出现"一句核心判断 + 展开 + 你的原话"这样完整的表达单元。',
        }, {
          role: 'system',
          kind: 'status',
          text: '可以：再练一遍（把想法说得更完整，更容易提炼出积木）→ 再次点"提炼语言乐高"重试；或点左上角"← 返回"结束本轮。',
        });
      }
      return this.#turnState();
    });
  }

  // 观察载荷同样是敌意输入：单条不合格丢一条，绝不影响提炼主流程。
  // 重试提炼时同一暂存行复现：同 id 建断言会撞唯一键被吞掉，不会重复计数。
  #recordObservations(
    rows: Array<{ id: string; payload: unknown }>,
    evidenceAttemptId: string | null,
  ): { noted: number; surfaced: number; promoted: number; renewed: number } {
    const evidence = evidenceAttemptId ? [evidenceAttemptId] : [];
    let noted = 0;
    let surfaced = 0;
    let promoted = 0;
    let renewed = 0;
    // 去重只对活跃条目生效：归档/否认的行绝不吸收新证据（否则新观察会
    // 静默蒸发进一条永远不显示的记录里）。
    const existing = this.#product.listProfileAssertions()
      .filter((assertion) => assertion.status === 'candidate' || assertion.status === 'confirmed');
    const createdNow = new Set<string>();
    for (const row of rows.slice(0, 2)) {
      try {
        const statement = observationPayloadSchema.parse(row.payload).statement.trim();
        const match = existing.find((assertion) => (
          assertion.id !== row.id
          && similarObservationStatements(assertion.statement, statement)
        ));
        if (match) {
          // 同一次提炼里连发两条相似观察不算独立证据，不触发晋升。
          if (createdNow.has(match.id)) continue;
          const before = match;
          const updated = this.#product.reinforceProfileAssertion(match.id, evidence);
          if (before.tier === 'pending-hypothesis') {
            if (updated.tier === 'evidenced-observation') {
              promoted += 1; // 满 4 轮独立证据，自动晋升有据观察
            } else if (updated.evidenceSegmentIds.length === 2) {
              surfaced += 1; // 满 2 轮，首次进入待复核视野
            }
            // 2→3 轮之间的积累静默进行，不打扰用户。
          } else {
            // 复现即证据：已确认/有据观察刷新时效（90 天复审自动续期）。
            renewed += 1;
          }
        } else {
          const assertion = this.#product.createProfileAssertion({
            id: row.id,
            tier: 'pending-hypothesis',
            statement,
            evidenceSegmentIds: evidence,
          });
          existing.push(assertion);
          createdNow.add(assertion.id);
          noted += 1;
        }
      } catch {
        // 载荷坏了或 id 已存在（提炼重试）：丢这一条，继续。
      }
    }
    return { noted, surfaced, promoted, renewed };
  }

  async confirm(
    candidateIds: string[],
    edits: Record<string, {
      title?: string | undefined;
      semanticKernel?: string | undefined;
      logicSkeleton?: string[] | undefined;
      languageShells?: string[] | undefined;
    }> = {},
  ): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('candidates-ready');
      const known = new Set(session.candidates.map((candidate) => candidate.id));
      for (const id of candidateIds) {
        if (!known.has(id)) throw new Error('Unknown candidate id.');
      }
      // The governance kernel merges these onto the stored payload at commit,
      // so the user's final wording is exactly what materializes.
      const userEdits: Record<string, Record<string, unknown>> = {};
      for (const [candidateId, edit] of Object.entries(edits)) {
        if (!known.has(candidateId)) continue;
        const patch: Record<string, unknown> = {};
        if (edit.title !== undefined) patch.title = edit.title;
        if (edit.semanticKernel !== undefined) patch.semantic_kernel = edit.semanticKernel;
        if (edit.logicSkeleton !== undefined) patch.logic_skeleton = edit.logicSkeleton;
        if (edit.languageShells !== undefined) patch.language_shells = edit.languageShells;
        if (Object.keys(patch).length > 0) userEdits[candidateId] = patch;
      }
      const repository = new GovernanceRepository(session.governanceDatabasePath);
      let materializedIds: string[];
      try {
        const { previewId } = repository.prepareCommit(candidateIds);
        const token = repository.issueConfirmationToken({ action: 'commit', previewId });
        repository.commitConfirmed({ token, previewId, userEdits });
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
        text: materializedIds.length > 0
          ? `已确认并写入 ${materializedIds.length} 个模块，安排了首次复现。`
          : '本轮未收纳模块——不是每一轮都需要入库，练习记录与画像观察都已保留。',
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
      const generated = await this.#runJsonAgent(session, prompt, 4, generatedQuestionSchema);
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

  async answerVariation(
    responseText: string,
    recordingId: string | null = null,
  ): Promise<TrainingTurnState> {
    return this.#exclusive(async () => {
      const session = this.#requireSession('variation');
      const questionId = session.variationQuestionId;
      const moduleId = session.confirmedModuleIds[session.confirmedModuleIds.length - 1];
      if (!questionId || !moduleId) throw new Error('No variation question is open.');
      const variationQuestion = this.#product.getQuestion(questionId);
      const recordingSourceId = await this.#linkRecording(recordingId, session.scenarioId);
      const attempt = this.#product.createAttempt({
        id: randomUUID(),
        questionId,
        round: 'variation',
        state: 'ASSISTANCE_ALLOWED',
        outcome: 'answered',
        responseText,
        recordingSourceId,
        hintLevel: 'none',
      });
      session.transcript.push({
        role: 'user', kind: 'response', text: responseText, recordingId: recordingSourceId,
      });
      const module = this.#product.getLegoModule(moduleId);
      const version = module?.currentVersion
        ? this.#product.getLegoVersion(moduleId, module.currentVersion)
        : null;
      const prompt = buildVariationJudgementPrompt({
        semanticKernel: version?.payload.semanticKernel ?? '',
        ...(version?.payload.languageShells[0]
          ? { languageShell: version.payload.languageShells[0] }
          : {}),
        variationQuestion: variationQuestion?.prompt ?? '',
        responseText,
      });
      const judged = await this.#runJsonAgent(session, prompt, 4, variationJudgementSchema);
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

  // 评测专用入口（docs/evaluation-plan.md Suite 3）：用受控的（模块内核,
  // 变体问题, 回答）三元组调用与 answerVariation 完全相同的判定 prompt 与
  // 解析。不写任何产品数据（不建 attempt、不动掌握度），会话对象即用即还。
  async judgeVariation(input: {
    semanticKernel: string;
    languageShell?: string;
    variationQuestion: string;
    responseText: string;
  }): Promise<{ result: 'success' | 'partial' | 'failure'; comment: string }> {
    return this.#exclusive(async () => {
      const previous = this.#session;
      const session = await this.#createSession('open', null);
      try {
        return await this.#runJsonAgent(
          session, buildVariationJudgementPrompt(input), 4, variationJudgementSchema,
        );
      } finally {
        this.#session = previous;
      }
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
      const generated = await this.#runJsonAgent(session, prompt, 4, generatedQuestionSchema);
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
      const prepared = await this.#runJsonAgent(session, prompt, 8, preparationSchema);
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
        session.candidates = candidatesFromPending(pending);
      } finally {
        repository.close();
      }
      session.phase = session.candidates.length > 0 ? 'candidates-ready' : 'round-complete';
      return this.#turnState();
    });
  }

  updateScenarioMaterialIntent(input: {
    scenarioId: string; sourceId: string; intent: string;
  }): ScenarioSummary {
    const scenario = this.#product.getScenario(input.scenarioId);
    if (!scenario) throw new Error('Scenario does not exist.');
    const owned = this.#product.listScenarioSources(input.scenarioId)
      .some((source) => source.id === input.sourceId);
    if (!owned) throw new Error('这份材料不属于当前场景。');
    this.#product.updateSourceIntent(input.sourceId, input.intent);
    return this.#scenarioSummary(scenario);
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

  // ─── Phase 3: speech composition ─────────────────────────────────────────

  #speechModuleContext(scenarioId: string): string {
    const modules = this.#product.listLegoModules({ status: 'confirmed' })
      .filter((module) => module.scope === 'global' || module.scenarioId === scenarioId)
      .slice(0, 20);
    if (modules.length === 0) return '(the user has no confirmed modules yet)';
    const lines = modules.map((module) => {
      const version = module.currentVersion
        ? this.#product.getLegoVersion(module.id, module.currentVersion)
        : null;
      return [
        `- 【${module.title}】`,
        version ? `内核：${truncate(version.payload.semanticKernel, 200)}` : '',
        version && version.payload.languageShells[0]
          ? `原话：${truncate(version.payload.languageShells[0], 200)}`
          : '',
      ].filter(Boolean).join(' ');
    });
    const relationLabels: Record<string, string> = {
      'composes-with': '可组合',
      'similar-to': '相似',
      'conflicts-with': '互斥',
      'precedes': '先于',
    };
    const relations: string[] = [];
    for (const module of modules) {
      for (const link of this.#product.listModuleLinks(module.id)) {
        if (link.direction !== 'out') continue;
        relations.push(`【${module.title}】${relationLabels[link.relation] ?? link.relation}【${link.otherTitle}】`);
      }
    }
    if (relations.length > 0) {
      lines.push(`Module relations declared by the user: ${relations.slice(0, 10).join('；')}`);
    }
    return lines.join('\n');
  }

  async composeSpeechOutline(input: {
    scenarioId: string; durationMinutes: number; audience: string;
  }): Promise<ScenarioSummary> {
    return this.#exclusive(async () => {
      const scenario = this.#product.getScenario(input.scenarioId);
      if (!scenario) throw new Error('Scenario does not exist.');
      if (scenario.type !== 'speech') throw new Error('只有演讲类型的场景可以组装讲稿骨架。');
      const session = await this.#createSession('speech', input.scenarioId);
      const prompt = [
        'Compose a speech skeleton (NOT a full script) from the user\'s own language modules.',
        `Speech: ${scenario.title} | objective: ${scenario.objective}`,
        `Duration budget: ${input.durationMinutes} minutes.`,
        input.audience ? `Audience: ${input.audience}` : `Audience: ${scenario.counterpart || '(unspecified)'}`,
        'The user\'s confirmed modules (bricks). Core claims MUST come from these:',
        this.#speechModuleContext(input.scenarioId),
        'Structure: 开场钩子 → 2-4 个要点（每个要点标注引用的模块【标题】和它的原话开头）→ 收尾落点。',
        'Respect declared module relations: 可组合 pairs belong in the same or adjacent',
        'points; 先于 ordering must hold; 互斥 bricks must not both anchor this speech.',
        'Give each section a time budget summing to the duration.',
        'Where a needed claim has no module, mark it 【缺积木：主题】 instead of inventing content.',
        'Reply in Chinese as a plain outline. No JSON, no full paragraphs of new prose.',
      ].join('\n');
      const output = await this.#runAgent(session, prompt, 6);
      const outline = extractFinalText(output.messages).trim();
      if (!outline) throw new Error('骨架生成为空，请重试。');
      this.#product.setScenarioSpeechOutline(input.scenarioId, outline);
      return this.#scenarioSummary(scenario);
    });
  }

  async transformSpeechOutline(input: {
    scenarioId: string; transform: 'compress' | 'expand' | 'audience'; audience: string;
  }): Promise<ScenarioSummary> {
    return this.#exclusive(async () => {
      const scenario = this.#product.getScenario(input.scenarioId);
      if (!scenario) throw new Error('Scenario does not exist.');
      const extras = this.#product.getScenarioExtras(input.scenarioId);
      if (!extras?.speechOutline) throw new Error('先生成演讲骨架，再做压缩/扩展/换听众。');
      if (input.transform === 'audience' && !input.audience) {
        throw new Error('换听众需要先填写新的听众描述。');
      }
      const session = await this.#createSession('speech', input.scenarioId);
      const instruction = input.transform === 'compress'
        ? 'COMPRESS this outline to roughly half its time budget: keep the strongest points, merge or drop the rest, tighten every section budget.'
        : input.transform === 'expand'
          ? 'EXPAND this outline: add depth to each point (sub-beats, where evidence or a case from the referenced module fits), increasing the time budget by roughly half.'
          : `RE-FRAME this outline for a different audience: ${input.audience}. Adjust emphasis, examples and register for them; keep the same modules as the backbone.`;
      const prompt = [
        'Transform the user\'s speech skeleton. Keep the 模块【标题】 references intact —',
        'the modules are the user\'s own confirmed language and must stay the backbone.',
        instruction,
        'Current outline:',
        extras.speechOutline,
        'Reply in Chinese with the full transformed outline only.',
      ].join('\n');
      const output = await this.#runAgent(session, prompt, 6);
      const outline = extractFinalText(output.messages).trim();
      if (!outline) throw new Error('变换结果为空，请重试。');
      this.#product.setScenarioSpeechOutline(input.scenarioId, outline);
      return this.#scenarioSummary(scenario);
    });
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
      speechOutline: extras?.speechOutline ? extras.speechOutline : null,
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

  // JSON 步骤的统一入口：解析失败不废整步，在同一会话里就地纠正一轮
  // （敌意输入防线的执行层，配合 parseJsonReply 的修复解析）。
  async #runJsonAgent<T>(
    session: ActiveSession,
    prompt: string,
    maxTurns: number,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const output = await this.#runAgent(session, prompt, maxTurns);
    try {
      return parseJsonReply(extractFinalText(output.messages), schema);
    } catch {
      const retry = await this.#runAgent(
        session,
        '你上一条回复不是合法 JSON（常见原因：字符串里有未转义的引号、JSON 之外有多余文字）。'
        + '重新回复一次：只输出符合前述格式要求的合法 JSON 对象，不要任何其他文字。',
        2,
      );
      return parseJsonReply(extractFinalText(retry.messages), schema);
    }
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
