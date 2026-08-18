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
  scoreDiagnosisGrounding,
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
  return { service, dispose };
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
        const diagnosisLeak = scoreQuestionLeakage(diagnosisText, 2000);
        reporter().record('s1-diagnosis', {
          id: entry.id,
          ok: grounding.groundedRate === 1 && !diagnosisLeak.leaked,
          groundedRate: grounding.groundedRate,
          leakReasons: diagnosisLeak.reasons,
          findings: grounding.findings,
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
});
