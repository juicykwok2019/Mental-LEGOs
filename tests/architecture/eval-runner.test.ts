// MENTAL_LEGOS_EVAL=1 评测 runner（docs/evaluation-plan.md · 执行与判分基建）。
//
// 复用 live-e2e 的真实 Agent 基建，把 Suite 1/2 语料灌进产品的公开
// 训练流程（start → closeFirst → diagnose → hint/second → extract），
// 用 tests/eval/scoring.ts 的规则判分，输出 JSONL 明细 + summary 汇总
// （指标 / 与上轮差 / 失败样本 / 成本）。Judge 项不在此文件。
//
// 环境变量：
//   MENTAL_LEGOS_EVAL=1                  开启（否则整套跳过）
//   MENTAL_LEGOS_LIVE_PROVIDER_BASE_URL / _KEY / _MODEL
//   MENTAL_LEGOS_AGENT_LIVE_BASH_RUNTIME
//   MENTAL_LEGOS_EVAL_SAMPLE             抽样比例，默认 0.2（冒烟轮）；1 为全量
//   MENTAL_LEGOS_EVAL_OUT                输出根目录，默认 .private/eval-runs
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { GovernanceRepository, createGovernanceKernel } from '../../src/agent/governance';
import { runAgent, type AgentRuntimePaths } from '../../src/agent/runtime';
import { createSessionWorkspace, openSessionWorkspace } from '../../src/agent/workspace';
import { StaticDataKeyProvider } from '../../src/data/crypto';
import { ProductDatabase } from '../../src/data/product-database';
import {
  TrainingSessionService,
  type TrainingAgentRunner,
} from '../../src/main/training-session';
import { EvalReporter, sampleCases } from '../eval/report';
import {
  scoreCrossScenarioLeak,
  scoreInjectionResistance,
  scoreIntentShift,
  scoreScenarioQuestionSet,
} from '../eval/scenario-scoring';
import {
  extractSkeletonReferences,
  scoreReferenceRetention,
  scoreTimeBudget,
  validateSkeletonReferences,
} from '../eval/skeleton-scoring';
import {
  scoreDemonstrationLeakage,
  scoreDiagnosisGrounding,
  scoreNovelEnglish,
  scoreHintLadder,
  scoreQuestionLeakage,
  scoreShellFidelity,
  scoreShellLength,
  SHELL_FIDELITY_THRESHOLD,
  type HintLevelLabel,
  type HintSample,
} from '../eval/scoring';

const repositoryRoot = path.resolve('.');
const baseUrl = process.env.MENTAL_LEGOS_LIVE_PROVIDER_BASE_URL;
const apiKey = process.env.MENTAL_LEGOS_LIVE_PROVIDER_KEY;
const model = process.env.MENTAL_LEGOS_LIVE_PROVIDER_MODEL;
const bashRuntimeDirectory = process.env.MENTAL_LEGOS_AGENT_LIVE_BASH_RUNTIME;
const evalEnabled = process.env.MENTAL_LEGOS_EVAL === '1'
  && baseUrl && apiKey && model && bashRuntimeDirectory;

const evalProbe = evalEnabled ? it : it.skip;
const SUITE_TIMEOUT_MS = 21_600_000;

const sampleFraction = Number.parseFloat(process.env.MENTAL_LEGOS_EVAL_SAMPLE ?? '0.2');
const outRoot = process.env.MENTAL_LEGOS_EVAL_OUT
  ?? path.join(repositoryRoot, '.private', 'eval-runs');
const runId = new Date().toISOString().replace(/[:.]/gu, '-');

interface Persona {
  id: string;
  label: string;
  direction: string;
  confirmedModules: string[];
  gaps: string[];
}
interface Suite1Case {
  id: string; personaId: string; questionType: string;
  kind: 'typed' | 'ladder'; question: string; answer: string;
}
interface Suite2Case {
  id: string; personaId: string; question: string;
  firstAttempt: string; secondAttempt: string; noisySecondAttempt: string;
}
interface Suite4Pack {
  id: string; personaId: string;
  type: 'interview' | 'meeting' | 'negotiation' | 'client' | 'other';
  title: string; objective: string; counterpart: string;
  leakCanary: string;
  materials: Array<{ label: string; content: string; intent: string; intentKeywords: string[] }>;
  injection: { marker: string; materialLabel: string } | null;
}

const fixturesDirectory = path.join(repositoryRoot, 'tests', 'fixtures', 'eval');

async function loadJson<T>(fileName: string): Promise<T> {
  return JSON.parse(await readFile(path.join(fixturesDirectory, fileName), 'utf8')) as T;
}

function runtimePaths(): AgentRuntimePaths {
  return {
    binaryPath: path.join(
      repositoryRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe',
    ),
    runtimeManifestPath: path.join(repositoryRoot, 'resources', 'agent-runtime-manifest.json'),
    capabilityBundlePath: path.join(repositoryRoot, 'resources', 'capability-bundle'),
    sandboxLauncherPath: path.join(
      repositoryRoot, 'resources', 'windows-sandbox', 'MentalLegos.SandboxLauncher.exe',
    ),
    credentialVaultPath: path.join(
      repositoryRoot, 'resources', 'windows-sandbox', 'MentalLegos.CredentialVault.exe',
    ),
    bashProxyPath: path.join(
      repositoryRoot, 'resources', 'windows-sandbox', 'MentalLegos.BashProxy.exe',
    ),
    providerProxyPath: path.join(
      repositoryRoot, 'resources', 'windows-sandbox', 'MentalLegos.ProviderProxy.exe',
    ),
  };
}

const inProcessRunner: TrainingAgentRunner = {
  async run(request) {
    const workspace = request.workspace.create
      ? await createSessionWorkspace({
        sessionsRoot: request.workspace.sessionsRoot,
        sessionId: request.workspace.sessionId,
        capabilityBundlePath: request.paths.capabilityBundlePath,
      })
      : await openSessionWorkspace({
        sessionsRoot: request.workspace.sessionsRoot,
        sessionId: request.workspace.sessionId,
        capabilityBundlePath: request.paths.capabilityBundlePath,
      });
    const repository = new GovernanceRepository(request.governanceDatabasePath);
    try {
      const result = await runAgent({
        prompt: request.prompt,
        workspace,
        paths: request.paths,
        provider: request.provider,
        limits: request.limits,
        bashRuntime: request.bashRuntime,
        mcpServers: createGovernanceKernel(repository),
        ...(request.resume === undefined ? {} : { resume: request.resume }),
      });
      return { agentSessionId: result.sessionId, messages: result.messages };
    } finally {
      repository.close();
    }
  },
};

// 惰性创建：普通 CI 跑到这个文件（整套 skip）时不得留下空的评测目录。
let reporterInstance: EvalReporter | null = null;
function reporter(): EvalReporter {
  reporterInstance ??= new EvalReporter(outRoot, runId, sampleFraction);
  return reporterInstance;
}
const cleanups: Array<() => Promise<void>> = [];

interface CaseHarness {
  service: TrainingSessionService;
  product: ProductDatabase;
  dispose(): Promise<void>;
}

async function createHarness(persona: Persona): Promise<CaseHarness> {
  if (!baseUrl || !apiKey || !model || !bashRuntimeDirectory) {
    throw new Error('eval runner requires live provider environment');
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'mental-legos-eval-'));
  const product = new ProductDatabase(
    path.join(directory, 'product.db'),
    StaticDataKeyProvider.random(),
  );
  const service = new TrainingSessionService({
    agent: inProcessRunner,
    provider: {
      resolveActive: async () => ({
        profile: { baseUrl, protocol: 'anthropic-messages', model },
        apiKey,
      }),
    },
    runtime: {
      paths: runtimePaths,
      manifestPath: () => path.join(
        repositoryRoot, 'resources', 'bash-runtime', 'windows-x64-wasmer-bash.json',
      ),
      resolveBashRuntimeDirectory: async () => bashRuntimeDirectory,
    },
    product,
    sessionsRoot: path.join(directory, 'sessions'),
    onAgentUsage: (usage) => reporter().addUsage(usage),
  });
  service.saveProfile({
    direction: persona.direction,
    currentWork: `已确认表达模块：${persona.confirmedModules.join('；')}`,
    targetScenarios: persona.gaps.join('；'),
    material: '',
  });
  const dispose = async () => {
    product.close();
    await rm(directory, { recursive: true, force: true });
  };
  cleanups.push(dispose);
  return { service, product, dispose };
}

function hintSamplesFromTranscript(
  transcript: Array<{ kind: string; text: string }>,
): HintSample[] {
  return transcript
    .filter((entry) => entry.kind === 'hint')
    .flatMap((entry) => {
      const match = /^【(L[1-4])】([\s\S]*)$/u.exec(entry.text);
      if (!match) return [];
      return [{ level: match[1] as HintLevelLabel, text: match[2] ?? '' }];
    });
}

describe('MENTAL_LEGOS_EVAL runner (Suite 1/2 rule metrics)', () => {
  afterAll(async () => {
    for (const dispose of cleanups.splice(0)) {
      await dispose().catch(() => { /* 评测清理失败不掩盖评测结果 */ });
    }
    if (evalEnabled && reporterInstance) reporterInstance.finalize(runId);
  });

  evalProbe('suite 1: question discipline + diagnosis grounding', async () => {
    const personas = (await loadJson<{ personas: Persona[] }>('personas.json')).personas;
    const personaById = new Map(personas.map((persona) => [persona.id, persona]));
    const corpus = (await loadJson<{ cases: Suite1Case[] }>('suite1-discipline.json')).cases;
    const typed = sampleCases(corpus.filter((entry) => entry.kind === 'typed'), sampleFraction);

    for (const entry of typed) {
      const persona = personaById.get(entry.personaId);
      if (!persona) continue;
      try {
        const harness = await createHarness(persona);
        const started = await harness.service.start({
          topic: entry.question, scenarioId: null, questionId: null,
        });
        const questionPrompt = started.question?.prompt ?? '';
        const questionLeak = scoreQuestionLeakage(questionPrompt);
        reporter().record('s1-question', {
          id: entry.id,
          ok: !questionLeak.leaked,
          question: questionPrompt,
          reasons: questionLeak.reasons,
          questionTypeNormalized: started.question?.questionType !== null,
        });

        await harness.service.closeFirst({
          outcome: 'answered',
          responseText: entry.answer,
          recordingId: null,
          openingDelayMs: 3000,
          durationMs: 25_000,
        });
        const diagnosed = await harness.service.diagnose();
        const diagnosisText = diagnosed.transcript
          .filter((item) => item.kind === 'diagnosis')
          .map((item) => item.text)
          .join('\n');
        const grounding = scoreDiagnosisGrounding(diagnosisText, entry.answer);
        // 诊断本就该分条列出，只查示范措辞，不套大纲/长度规则。
        const diagnosisLeak = scoreDemonstrationLeakage(diagnosisText);
        reporter().record('s1-diagnosis', {
          id: entry.id,
          ok: grounding.groundedRate === 1 && !diagnosisLeak.leaked,
          groundedRate: grounding.groundedRate,
          leakReasons: diagnosisLeak.reasons,
          findings: grounding.findings,
        });
        // 白话度：教练不得夹用户没说过的英文词（专有名词豁免见判分器）。
        const plain = scoreNovelEnglish(diagnosisText, [questionPrompt, entry.answer]);
        reporter().record('s1-plain-language', {
          id: entry.id,
          ok: plain.ok,
          novelWords: plain.novelWords,
        });
      } catch (reason) {
        reporter().record('s1-diagnosis', {
          id: entry.id,
          ok: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }
    expect(reporter().rate('s1-question').total).toBeGreaterThan(0);
  }, SUITE_TIMEOUT_MS);

  evalProbe('suite 1: hint ladder discipline', async () => {
    const personas = (await loadJson<{ personas: Persona[] }>('personas.json')).personas;
    const personaById = new Map(personas.map((persona) => [persona.id, persona]));
    const corpus = (await loadJson<{ cases: Suite1Case[] }>('suite1-discipline.json')).cases;
    const ladder = sampleCases(corpus.filter((entry) => entry.kind === 'ladder'), sampleFraction);

    for (const entry of ladder) {
      const persona = personaById.get(entry.personaId);
      if (!persona) continue;
      try {
        const harness = await createHarness(persona);
        await harness.service.start({ topic: entry.question, scenarioId: null, questionId: null });
        await harness.service.closeFirst({
          outcome: 'answered',
          responseText: entry.answer,
          recordingId: null,
          openingDelayMs: 6000,
          durationMs: 20_000,
        });
        await harness.service.diagnose();
        let state = await harness.service.hint('L1');
        state = await harness.service.hint('L2');
        state = await harness.service.hint('L3');
        state = await harness.service.hint('L4');
        const hints = hintSamplesFromTranscript(state.transcript);
        const ladderScore = scoreHintLadder(hints);
        reporter().record('s1-hint-ladder', {
          id: entry.id,
          ok: hints.length === 4 && ladderScore.violations.length === 0,
          violations: ladderScore.violations,
          hints,
        });
        const hintPlain = scoreNovelEnglish(
          hints.map((hint) => hint.text).join('\n'),
          [entry.question, entry.answer],
        );
        reporter().record('s1-plain-language', {
          id: `${entry.id}-hints`,
          ok: hintPlain.ok,
          novelWords: hintPlain.novelWords,
        });
      } catch (reason) {
        reporter().record('s1-hint-ladder', {
          id: entry.id,
          ok: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }
    expect(reporter().rate('s1-hint-ladder').total).toBeGreaterThan(0);
  }, SUITE_TIMEOUT_MS);

  evalProbe('suite 2: extraction fidelity through the full loop', async () => {
    const personas = (await loadJson<{ personas: Persona[] }>('personas.json')).personas;
    const personaById = new Map(personas.map((persona) => [persona.id, persona]));
    const corpus = (await loadJson<{ cases: Suite2Case[] }>('suite2-extraction.json')).cases;
    const sampled = sampleCases(corpus, sampleFraction);

    for (const [index, entry] of sampled.entries()) {
      const persona = personaById.get(entry.personaId);
      if (!persona) continue;
      // 奇数样本用 ASR 噪声版第二遍，衡量噪声下的提炼保真。
      const noisy = index % 2 === 1;
      const submitted = noisy ? entry.noisySecondAttempt : entry.secondAttempt;
      try {
        const harness = await createHarness(persona);
        await harness.service.start({ topic: entry.question, scenarioId: null, questionId: null });
        await harness.service.closeFirst({
          outcome: 'answered',
          responseText: entry.firstAttempt,
          recordingId: null,
          openingDelayMs: 3000,
          durationMs: 20_000,
        });
        await harness.service.diagnose();
        await harness.service.second(submitted);
        const extracted = await harness.service.extract();
        const shells = extracted.candidates.flatMap((candidate) => candidate.languageShells);
        const fidelities = shells.map((shell) => scoreShellFidelity(shell, submitted));
        const lengths = shells.map((shell) => scoreShellLength(shell));
        reporter().record('s2-shell-fidelity', {
          id: entry.id,
          ok: shells.length > 0
            && fidelities.every((score) => score >= SHELL_FIDELITY_THRESHOLD),
          noisy,
          candidateCount: extracted.candidates.length,
          shells,
          fidelities,
          // 供 Judge 内核判审（判断性+蕴含）离线使用。
          kernels: extracted.candidates.map((candidate) => candidate.semanticKernel),
          submittedAnswer: submitted,
        });
        reporter().record('s2-shell-length', {
          id: entry.id,
          ok: shells.length > 0 && lengths.every((entry_) => entry_.ok),
          lengths,
        });
      } catch (reason) {
        reporter().record('s2-shell-fidelity', {
          id: entry.id,
          ok: false,
          noisy,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }
    expect(reporter().rate('s2-shell-fidelity').total).toBeGreaterThan(0);
  }, SUITE_TIMEOUT_MS);

  evalProbe('suite 4: scenario targeting and injection resistance', async () => {
    const personas = (await loadJson<{ personas: Persona[] }>('personas.json')).personas;
    const personaById = new Map(personas.map((persona) => [persona.id, persona]));
    const packs = (await loadJson<{ packs: Suite4Pack[] }>('suite4-scenarios.json')).packs;
    const sampled = sampleCases(packs, sampleFraction);
    // 注入对抗是零容忍指标，抽样轮也必须至少覆盖一个注入包。
    if (!sampled.some((pack) => pack.injection !== null)) {
      const injected = packs.find((pack) => pack.injection !== null);
      if (injected) sampled.push(injected);
    }

    for (const [index, pack] of sampled.entries()) {
      const persona = personaById.get(pack.personaId);
      if (!persona) continue;
      // 跨场景泄漏的 B 场景取全集中的下一个包（保证与 A 不同源）。
      const packIndex = packs.findIndex((candidate) => candidate.id === pack.id);
      const foreign = packs[(packIndex + 1) % packs.length]!;
      try {
        const harness = await createHarness(persona);
        const prepare = async (
          title: string,
          source: Suite4Pack,
          withIntent: boolean,
        ) => {
          const created = harness.service.createScenario({
            type: source.type,
            title,
            objective: source.objective,
            counterpart: source.counterpart,
            worries: '',
          });
          for (const material of source.materials) {
            harness.service.addScenarioMaterial({
              scenarioId: created.id,
              label: material.label,
              content: material.content,
              ...(withIntent && material.intent ? { intent: material.intent } : {}),
            });
          }
          return harness.service.prepareScenario(created.id);
        };

        const withoutIntent = await prepare(`${pack.title}（A0）`, pack, false);
        const withIntent = await prepare(`${pack.title}（A1）`, pack, true);
        const foreignSummary = await prepare(`${foreign.title}（B）`, foreign, false);

        const promptsWith = withIntent.preparedQuestions.map((question) => question.prompt);
        const promptsWithout = withoutIntent.preparedQuestions.map((question) => question.prompt);

        const setReport = scoreScenarioQuestionSet(withIntent.preparedQuestions.map((question) => ({
          prompt: question.prompt,
          questionType: question.questionType,
        })));
        reporter().record('s4-question-set', {
          id: pack.id,
          ok: setReport.ok,
          count: setReport.count,
          distinctTypes: setReport.distinctTypes,
          leakedPrompts: setReport.leakedPrompts,
          // 供 Judge 接地率离线判审：题目全文 + 对应材料原文。
          prompts: promptsWith,
          materials: pack.materials.map((material) => material.content).join('\n\n'),
        });

        const intentKeywords = pack.materials.flatMap((material) => material.intentKeywords);
        const shift = scoreIntentShift(promptsWith, promptsWithout, intentKeywords);
        reporter().record('s4-intent-shift', {
          id: pack.id,
          ok: shift.shifted,
          hitRateWithIntent: shift.hitRateWithIntent,
          hitRateWithout: shift.hitRateWithout,
        });

        if (pack.injection) {
          const outputs = [
            ...promptsWith,
            ...promptsWithout,
            withIntent.analysis ?? '',
            withoutIntent.analysis ?? '',
          ];
          const injection = scoreInjectionResistance(outputs, pack.injection.marker);
          reporter().record('s4-injection', {
            id: pack.id,
            ok: !injection.executed,
            hits: injection.hits,
          });
        }

        const crossLeak = scoreCrossScenarioLeak(
          foreignSummary.preparedQuestions.map((question) => question.prompt),
          pack.leakCanary,
        );
        reporter().record('s4-cross-leak', {
          id: `${foreign.id}<-${pack.id}`,
          ok: !crossLeak.leaked,
          hits: crossLeak.hits,
        });
      } catch (reason) {
        reporter().record('s4-question-set', {
          id: pack.id,
          ok: false,
          sampleIndex: index,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }
    expect(reporter().rate('s4-question-set').total).toBeGreaterThan(0);
  }, SUITE_TIMEOUT_MS);

  evalProbe('suite 7: speech skeleton assembly rules', async () => {
    interface Suite7Module { title: string; kernel: string; shell: string; triggers: string[] }
    interface Suite7Library {
      personaId: string; sparse: boolean;
      speech: { title: string; objective: string; counterpart: string };
      modules: Suite7Module[];
    }
    interface Suite7Fixture { durationsMinutes: number[]; libraries: Suite7Library[] }

    const personas = (await loadJson<{ personas: Persona[] }>('personas.json')).personas;
    const personaById = new Map(personas.map((persona) => [persona.id, persona]));
    const fixture = await loadJson<Suite7Fixture>('suite7-skeleton.json');
    const grid = fixture.libraries.flatMap(
      (library) => fixture.durationsMinutes.map((duration) => ({ library, duration })),
    );
    const sampled = sampleCases(grid, sampleFraction);

    for (const { library, duration } of sampled) {
      const persona = personaById.get(library.personaId);
      if (!persona) continue;
      const caseId = `${library.personaId}-${duration}m`;
      try {
        const harness = await createHarness(persona);
        for (const moduleSpec of library.modules) {
          const { module } = harness.product.createLegoCandidate({
            id: randomUUID(),
            scope: 'global',
            scenarioId: null,
            category: 'viewpoint',
            title: moduleSpec.title,
            triggers: moduleSpec.triggers,
            payload: {
              semanticKernel: moduleSpec.kernel,
              logicSkeleton: [moduleSpec.kernel],
              languageShells: [moduleSpec.shell],
              anchorPhrase: '',
              slots: [],
              purpose: '',
              boundaries: '',
            },
            authorship: 'user-native',
            domain: 'professional',
          });
          harness.product.confirmLegoVersion(module.id, 1);
        }

        const scenario = harness.service.createScenario({
          type: 'speech',
          title: library.speech.title,
          objective: library.speech.objective,
          counterpart: library.speech.counterpart,
          worries: '',
        });
        const composed = await harness.service.composeSpeechOutline({
          scenarioId: scenario.id,
          durationMinutes: duration,
          audience: '',
        });
        const outline = composed.speechOutline ?? '';
        const titles = library.modules.map((moduleSpec) => moduleSpec.title);

        // 骨架里复述的演讲标题不是模块引用，排除后再做集合校验。
        const references = validateSkeletonReferences(outline, titles, [library.speech.title]);
        reporter().record('s7-references', {
          id: caseId,
          ok: references.ok,
          references: references.references,
          unknown: references.unknown,
          outline,
        });

        const budget = scoreTimeBudget(outline, duration);
        reporter().record('s7-time-budget', {
          id: caseId,
          ok: budget.withinTolerance,
          totalMinutes: budget.totalMinutes,
          sections: budget.sections,
        });

        if (library.sparse) {
          const honesty = extractSkeletonReferences(outline);
          reporter().record('s7-honesty', {
            id: caseId,
            ok: honesty.missingBricks.length >= 1,
            missingBricks: honesty.missingBricks,
          });
        }

        // 变换保持率只在中档时长上测一次，避免成本翻倍。
        if (!library.sparse && duration === 10) {
          const compressed = await harness.service.transformSpeechOutline({
            scenarioId: scenario.id,
            transform: 'compress',
            audience: '',
          });
          const retention = scoreReferenceRetention(outline, compressed.speechOutline ?? '');
          reporter().record('s7-transform-retention', {
            id: `${library.personaId}-compress`,
            ok: retention.retentionRate >= 0.5,
            retentionRate: retention.retentionRate,
            lost: retention.lost,
          });
        }
      } catch (reason) {
        reporter().record('s7-references', {
          id: caseId,
          ok: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }
    expect(reporter().rate('s7-references').total).toBeGreaterThan(0);
  }, SUITE_TIMEOUT_MS);

  evalProbe('suite 5: end-to-end reliability and cost (+ suite 8 collection)', async () => {
    const personas = (await loadJson<{ personas: Persona[] }>('personas.json')).personas;
    const persona = personas.find((candidate) => candidate.id === 'founder');
    if (!persona) throw new Error('founder persona missing from corpus');
    const loops = Number.parseInt(
      process.env.MENTAL_LEGOS_EVAL_S5_LOOPS ?? (sampleFraction >= 1 ? '20' : '5'),
      10,
    );
    const script = {
      topic: '被客户追问交付确定性时怎么讲',
      first: '呃，我们交付挺快的，一般两周吧，具体要看项目情况，反正比同行快。',
      second: '这个垂类赢的关键不是功能多，是交付确定性。我们是唯一把实施周期压到两周并写进合同赔付条款的——功能可以抄，赔付敢不敢写进合同，抄不了。',
      variation: '我的回应是：客户真正怕的不是周期长，是不确定。所以我们把两周实施写进合同并配赔付条款，把风险从口头承诺变成合同责任。',
    };

    const stepDurations = new Map<string, number[]>();
    for (let loop = 0; loop < loops; loop += 1) {
      const steps: Array<{ name: string; ms: number }> = [];
      let lastStep = 'init';
      try {
        const harness = await createHarness(persona);
        const timed = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
          lastStep = name;
          const startedAt = Date.now();
          const result = await work();
          const ms = Date.now() - startedAt;
          steps.push({ name, ms });
          const list = stepDurations.get(name) ?? [];
          list.push(ms);
          stepDurations.set(name, list);
          return result;
        };

        await timed('start', () => harness.service.start({
          topic: script.topic, scenarioId: null, questionId: null,
        }));
        await timed('closeFirst', () => harness.service.closeFirst({
          outcome: 'answered',
          responseText: script.first,
          recordingId: null,
          openingDelayMs: 3000,
          durationMs: 20_000,
        }));
        await timed('diagnose', () => harness.service.diagnose());
        await timed('hint', () => harness.service.hint('L1'));
        await timed('second', () => harness.service.second(script.second));
        const extracted = await timed('extract', () => harness.service.extract());
        if (extracted.candidates.length === 0) throw new Error('no candidates extracted');
        const confirmed = await timed('confirm', () => harness.service.confirm([
          extracted.candidates[0]!.id,
        ]));
        if (confirmed.phase === 'variation') {
          await timed('variation', () => harness.service.answerVariation(script.variation));
        }
        reporter().record('s5-loop', { id: `loop-${loop}`, ok: true, steps });

        // Suite 8 采集：本闭环产生的全部画像断言 + 会话转写，供后续
        // Judge/人工做蕴含复核（虚构率判定不在规则层）。
        const assertions = harness.product.listProfileAssertions();
        reporter().record('s8-assertions', {
          id: `loop-${loop}`,
          ok: true,
          count: assertions.length,
          assertions: assertions.map((assertion) => ({
            tier: assertion.tier,
            status: assertion.status,
            statement: assertion.statement,
          })),
          transcript: confirmed.transcript.map((entry) => `${entry.role}/${entry.kind}: ${entry.text}`),
        });
      } catch (reason) {
        reporter().record('s5-loop', {
          id: `loop-${loop}`,
          ok: false,
          failedStep: lastStep,
          steps,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }

    // 单步 p95 延迟（计划指标：≤ 3 分钟）。
    const p95: Record<string, number> = {};
    for (const [name, list] of stepDurations) {
      const sorted = [...list].sort((left, right) => left - right);
      p95[name] = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
    }
    reporter().record('s5-step-p95', {
      id: 'aggregate',
      ok: Object.values(p95).every((ms) => ms <= 180_000),
      p95,
    });
    expect(reporter().rate('s5-loop').total).toBeGreaterThan(0);
  }, SUITE_TIMEOUT_MS);

  evalProbe('suite 3: variation judgement vs human gold labels', async () => {
    interface Suite3Module { id: string; title: string; kernel: string; shell: string }
    interface Suite3Case {
      id: string; moduleId: string; difficulty: string;
      variationQuestion: string; userAnswer: string;
      proposedLabel: string; goldLabel: 'success' | 'partial' | 'failure' | null;
    }
    interface Suite3Kit { modules: Suite3Module[]; cases: Suite3Case[] }

    const personas = (await loadJson<{ personas: Persona[] }>('personas.json')).personas;
    const persona = personas.find((candidate) => candidate.id === 'founder');
    if (!persona) throw new Error('founder persona missing from corpus');
    const kit = await loadJson<Suite3Kit>('suite3-variation-gold.json');
    const moduleById = new Map(kit.modules.map((module) => [module.id, module]));
    const labeled = kit.cases.filter((entry) => entry.goldLabel !== null);
    if (labeled.length === 0) {
      // 金标签未标注时本套件无事可测（金标签是唯一的评分权威）。
      reporter().record('s3-agreement', { id: 'unlabeled', ok: false, error: 'gold labels missing' });
      return;
    }
    const sampled = sampleCases(labeled, sampleFraction);
    // 判定 prompt 不读画像，一个 harness 即可服务全部样本。
    const harness = await createHarness(persona);

    for (const entry of sampled) {
      const module = moduleById.get(entry.moduleId);
      if (!module) continue;
      try {
        const judged = await harness.service.judgeVariation({
          semanticKernel: module.kernel,
          languageShell: module.shell,
          variationQuestion: entry.variationQuestion,
          responseText: entry.userAnswer,
        });
        reporter().record('s3-agreement', {
          id: entry.id,
          ok: judged.result === entry.goldLabel,
          judged: judged.result,
          gold: entry.goldLabel,
          difficulty: entry.difficulty,
          comment: judged.comment,
        });
        if (entry.goldLabel === 'failure') {
          // 最危险方向：failure 被判 success = 虚假晋级（指标 ≤5%）。
          reporter().record('s3-dangerous', {
            id: entry.id,
            ok: judged.result !== 'success',
            judged: judged.result,
          });
        }
      } catch (reason) {
        reporter().record('s3-agreement', {
          id: entry.id,
          ok: false,
          gold: entry.goldLabel,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }

    // 自一致率：抽样集的前三条各重跑 3 次，要求三次同判。
    for (const entry of sampled.slice(0, 3)) {
      const module = moduleById.get(entry.moduleId);
      if (!module) continue;
      try {
        const results: string[] = [];
        for (let round = 0; round < 3; round += 1) {
          const judged = await harness.service.judgeVariation({
            semanticKernel: module.kernel,
            languageShell: module.shell,
            variationQuestion: entry.variationQuestion,
            responseText: entry.userAnswer,
          });
          results.push(judged.result);
        }
        reporter().record('s3-self-consistency', {
          id: entry.id,
          ok: new Set(results).size === 1,
          results,
        });
      } catch (reason) {
        reporter().record('s3-self-consistency', {
          id: entry.id,
          ok: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }
    expect(reporter().rate('s3-agreement').total).toBeGreaterThan(0);
  }, SUITE_TIMEOUT_MS);
});
