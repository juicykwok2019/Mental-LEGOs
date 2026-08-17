import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GovernanceRepository } from '../../src/agent/governance';
import type { AgentRuntimePaths } from '../../src/agent/runtime';
import { StaticDataKeyProvider } from '../../src/data/crypto';
import { ProductDatabase } from '../../src/data/product-database';
import {
  extractFinalText,
  normalizeQuestionType,
  parseJsonReply,
  TrainingSessionService,
  type TrainingAgentRunner,
} from '../../src/main/training-session';
import { z } from 'zod';

const runtimePaths: AgentRuntimePaths = {
  binaryPath: 'x:/fake/claude.exe',
  runtimeManifestPath: 'x:/fake/manifest.json',
  capabilityBundlePath: 'x:/fake/bundle',
  sandboxLauncherPath: 'x:/fake/launcher.exe',
  credentialVaultPath: 'x:/fake/vault.exe',
  bashProxyPath: 'x:/fake/bash-proxy.exe',
  providerProxyPath: 'x:/fake/provider-proxy.exe',
};

function resultMessage(text: string): unknown {
  return { type: 'result', subtype: 'success', result: text };
}

function candidatePayload(title: string): Record<string, unknown> {
  return {
    title,
    category: 'interaction',
    domain: 'generic',
    triggers: ['干系人反对', '方案分歧'],
    semantic_kernel: '先理解反对背后的关切，再谈方案本身',
    logic_skeleton: ['确认关切', '复述立场', '提出验证方式'],
    language_shells: ['我会先弄清楚他反对的到底是什么，再回到方案。'],
  };
}

class FakeAgent implements TrainingAgentRunner {
  prompts: string[] = [];
  submitCandidatesOnExtract = 1;
  #agentSessionId = randomUUID();

  async run(request: Parameters<TrainingAgentRunner['run']>[0]) {
    this.prompts.push(request.prompt);
    const prompt = request.prompt;
    let reply = 'unhandled prompt';
    if (prompt.includes('Generate exactly ONE open professional question')) {
      reply = JSON.stringify({
        question_type: 'viewpoint',
        exploratory: prompt.includes('探索') ? true : false,
        question: '当一个跨团队项目的关键干系人反对你的方案时，你会如何处理？',
      });
    } else if (prompt.includes('Test transfer immediately')) {
      reply = JSON.stringify({
        question_type: 'challenge',
        exploratory: false,
        question: '有人说你这种“先理解关切”的做法太软弱，你怎么回应？',
      });
    } else if (prompt.includes('Judge whether the user transferred')) {
      reply = JSON.stringify({ result: 'success', comment: '内核被自然调用。' });
    } else if (prompt.includes('KNOWLEDGE gap')) {
      reply = '这个话题主要有两派观点……留给你一个问题：你更看重哪一侧？';
    } else if (prompt.includes('Diagnose it now')) {
      reply = '1. 观点不明确：你说“可能要看情况”。\n2. 缺少结构。';
    } else if (prompt.includes('one hint at level L1')) {
      reply = '这类问题的沟通任务是展示你如何处理分歧。';
    } else if (prompt.includes('extract at most two candidate')) {
      const repository = new GovernanceRepository(request.governanceDatabasePath);
      try {
        for (let index = 0; index < this.submitCandidatesOnExtract; index += 1) {
          repository.submitCandidate({
            sessionId: request.workspace.sessionId,
            kind: 'language_module',
            payload: candidatePayload(index === 0 ? '分歧处理开场' : '第二模块'),
            provenance: {
              source_refs: [],
              method: 'practice-extraction',
              generated_by: 'mental-legos-agent',
            },
            scope: prompt.includes('scope "scenario"') ? 'scenario' : 'personal',
            idempotencyKey: `test-extract-${randomUUID()}`,
          });
        }
      } finally {
        repository.close();
      }
      reply = '候选已提交。';
    } else if (prompt.includes('Prepare the user for this real communication scenario')
      || prompt.includes('speech-rehearsal plan')) {
      reply = JSON.stringify({
        analysis: '对方最可能考察落地能力与横向推动力。',
        questions: [
          { question_type: 'case-recall', question: '讲一个你推动跨部门项目落地的具体案例？' },
          { question_type: 'challenge', question: '你的方案如果被技术团队否了怎么办？' },
          { question_type: 'decision', question: '资源只够做一半，你砍哪一半？' },
        ],
      });
    } else if (prompt.includes('pressing follow-up question')) {
      reply = JSON.stringify({
        question_type: 'pressure-probe',
        exploratory: false,
        question: '你说会先对齐目标——有什么证据说明这真的有效？',
      });
    } else if (prompt.includes('Post-event review')) {
      const repository = new GovernanceRepository(request.governanceDatabasePath);
      try {
        repository.submitCandidate({
          sessionId: request.workspace.sessionId,
          kind: 'language_module',
          payload: candidatePayload('复盘沉淀模块'),
          provenance: {
            source_refs: [],
            method: 'post-event-review',
            generated_by: 'mental-legos-agent',
          },
          scope: 'scenario',
          idempotencyKey: `test-review-${randomUUID()}`,
        });
      } finally {
        repository.close();
      }
      reply = '复盘：开场模块命中；证据部分未调用。';
    }
    return { agentSessionId: this.#agentSessionId, messages: [resultMessage(reply)] };
  }
}

describe('question type normalization', () => {
  it('accepts canonical values and maps common improvisations', () => {
    expect(normalizeQuestionType('viewpoint')).toBe('viewpoint');
    expect(normalizeQuestionType('Case Recall')).toBe('case-recall');
    expect(normalizeQuestionType('Follow_Up')).toBe('pressure-probe');
    expect(normalizeQuestionType('behavioral')).toBe('case-recall');
    expect(normalizeQuestionType('经验调用')).toBe('case-recall');
    expect(normalizeQuestionType('质疑')).toBe('challenge');
  });

  it('degrades unknown labels to null instead of failing the run', () => {
    expect(normalizeQuestionType('completely-made-up')).toBeNull();
  });
});

describe('training session v2 orchestration', () => {
  let directory: string;
  let product: ProductDatabase;
  let agent: FakeAgent;
  let service: TrainingSessionService;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'mental-legos-session-'));
    product = new ProductDatabase(
      path.join(directory, 'product.db'),
      StaticDataKeyProvider.random(),
    );
    agent = new FakeAgent();
    service = new TrainingSessionService({
      agent,
      provider: {
        resolveActive: async () => ({
          profile: {
            baseUrl: 'https://api.moonshot.cn/anthropic',
            protocol: 'anthropic-messages',
            model: 'kimi-k3',
          },
          apiKey: 'synthetic-test-key',
        }),
      },
      runtime: {
        paths: () => runtimePaths,
        manifestPath: () => 'x:/fake/bash-manifest.json',
        resolveBashRuntimeDirectory: async () => 'x:/fake/bash-runtime',
      },
      product,
      sessionsRoot: path.join(directory, 'sessions'),
    });
    service.saveProfile({
      direction: 'AI 产品负责人，关注大模型在传统企业落地',
      currentWork: '推进一个跨部门的智能客服项目',
      targetScenarios: '高管汇报、客户方案沟通',
      material: '',
    });
  });

  afterEach(async () => {
    product.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('requires a profile seed before open practice', async () => {
    const bareProduct = new ProductDatabase(
      path.join(directory, 'bare.db'),
      StaticDataKeyProvider.random(),
    );
    try {
      const bare = new TrainingSessionService({
        agent,
        provider: {
          resolveActive: async () => ({
            profile: {
              baseUrl: 'https://api.moonshot.cn/anthropic',
              protocol: 'anthropic-messages',
              model: 'kimi-k3',
            },
            apiKey: 'k',
          }),
        },
        runtime: {
          paths: () => runtimePaths,
          manifestPath: () => 'x:/fake/bash-manifest.json',
          resolveBashRuntimeDirectory: async () => 'x:/fake/bash-runtime',
        },
        product: bareProduct,
        sessionsRoot: path.join(directory, 'bare-sessions'),
      });
      await expect(bare.start({ topic: '', scenarioId: null, questionId: null }))
        .rejects.toThrow('画像');
    } finally {
      bareProduct.close();
    }
  });

  it('grounds questions in the profile and runs the loop through variation transfer', async () => {
    const started = await service.start({ topic: '', scenarioId: null, questionId: null });
    expect(started.phase).toBe('first-attempt');
    expect(started.question?.questionType).toBe('viewpoint');
    const questionPrompt = agent.prompts[0]!;
    expect(questionPrompt).toContain('AI 产品负责人');
    expect(questionPrompt).toContain('not a general knowledge quiz');

    await service.closeFirst({
      outcome: 'answered',
      responseText: '呃，可能要看情况吧。',
      recordingId: null,
      openingDelayMs: 3000,
      durationMs: 40_000,
    });
    await service.diagnose();
    await service.hint('L1');
    await service.second('我会先确认他反对的到底是什么，再复述立场，最后提出验证方式。');
    const extracted = await service.extract();
    expect(extracted.candidates).toHaveLength(1);

    const candidateId = extracted.candidates[0]!.id;
    const confirmed = await service.confirm([candidateId], {
      [candidateId]: {
        title: '用户改后的标题',
        languageShells: ['这是我自己改过的原话。'],
      },
    });
    expect(confirmed.phase).toBe('variation');
    expect(confirmed.transcript.some((entry) => entry.text.includes('变体调用'))).toBe(true);
    const committedModule = product.listLegoModules({ status: 'confirmed' })[0]!;
    expect(committedModule.title).toBe('用户改后的标题');
    const committedVersion = product.getLegoVersion(committedModule.id, committedModule.currentVersion ?? 1);
    expect(committedVersion?.payload.languageShells).toEqual(['这是我自己改过的原话。']);

    const judged = await service.answerVariation('软不软要看结果：我先理解关切，是为了让方案能落地。');
    expect(judged.phase).toBe('round-complete');
    expect(judged.transcript.some((entry) => entry.kind === 'variation-result')).toBe(true);

    const moduleId = product.listLegoModules({ status: 'confirmed' })[0]!.id;
    const mastery = product.getMasteryState(moduleId);
    expect(mastery?.stage).toBe('visible-recall');
    const domainModule = product.getLegoModule(moduleId);
    expect(domainModule?.domain).toBe('generic');
  });

  it('forks cannot-answer into knowledge and expression gaps', async () => {
    await service.start({ topic: '', scenarioId: null, questionId: null });
    const gapQuery = await service.closeFirst({
      outcome: 'cannot-answer', responseText: '', recordingId: null,
      openingDelayMs: null, durationMs: null,
    });
    expect(gapQuery.phase).toBe('gap-query');

    const knowledge = await service.resolveGap('knowledge');
    expect(knowledge.phase).toBe('round-complete');
    expect(knowledge.transcript.some((entry) => entry.kind === 'gap-note'
      && entry.text.includes('两派观点'))).toBe(true);
    expect(product.countKnowledgeGaps()).toBe(1);
    expect(product.listKnowledge({ status: 'candidate' })
      .some((item) => item.kind === 'assumption')).toBe(true);

    await service.start({ topic: '', scenarioId: null, questionId: null });
    await service.closeFirst({
      outcome: 'cannot-answer', responseText: '', recordingId: null,
      openingDelayMs: null, durationMs: null,
    });
    const expression = await service.resolveGap('expression');
    expect(expression.phase).toBe('first-closed');
    const diagnosed = await service.diagnose();
    expect(diagnosed.phase).toBe('assistance');
  });

  it('runs the scenario entry: prepare, gated question, follow-up, and review', async () => {
    const scenario = service.createScenario({
      type: 'interview',
      title: '合成公司产品面试',
      objective: '拿到 offer',
      counterpart: '虚构面试官',
      worries: '担心被问跨部门推动的证据',
    });
    service.addScenarioMaterial({
      scenarioId: scenario.id,
      label: '合成 JD',
      content: '负责推动 AI 能力在企业客户中的规模化落地，需要跨部门协作。'.repeat(10),
    });

    const prepared = await service.prepareScenario(scenario.id);
    expect(prepared.analysis).toContain('落地能力');
    expect(prepared.preparedQuestions).toHaveLength(3);
    const preparePrompt = agent.prompts.find((entry) => entry.includes('real communication scenario'))!;
    expect(preparePrompt).toContain('担心被问跨部门推动的证据');
    expect(preparePrompt).toContain('规模化落地');

    const first = prepared.preparedQuestions[0]!;
    const turn = await service.start({ topic: '', scenarioId: scenario.id, questionId: first.id });
    expect(turn.mode).toBe('scenario');
    expect(turn.phase).toBe('first-attempt');
    await service.closeFirst({
      outcome: 'answered', responseText: '我推动过智能客服项目……', recordingId: null,
      openingDelayMs: null, durationMs: null,
    });
    await service.diagnose();
    await service.second('具体来说，我先对齐了双方目标，然后……');

    const followedUp = await service.followUp();
    expect(followedUp.phase).toBe('first-attempt');
    expect(followedUp.question?.prompt).toContain('证据');

    // Re-entering a trained question must replay its practice history.
    const reentered = await service.start({ topic: '', scenarioId: scenario.id, questionId: first.id });
    expect(reentered.transcript.some((entry) => entry.text.includes('历史回顾'))).toBe(true);
    expect(reentered.transcript.some((entry) => entry.text.includes('我推动过智能客服项目'))).toBe(true);
    await service.closeFirst({
      outcome: 'answered', responseText: '再次作答：我推动过智能客服项目，这次说得更稳。', recordingId: null,
      openingDelayMs: null, durationMs: null,
    });
    await service.diagnose();
    await service.second('这次我先给结论再给证据。');
    const backToFollowUp = await service.followUp();
    expect(backToFollowUp.phase).toBe('first-attempt');

    await service.closeFirst({
      outcome: 'answered', responseText: '证据是项目上线率提升。', recordingId: null,
      openingDelayMs: null, durationMs: null,
    });
    await service.diagnose();
    await service.second('上线率从 40% 提到 75%，这是可查的。');
    const extracted = await service.extract();
    expect(extracted.candidates.length).toBeGreaterThanOrEqual(1);
    const confirmed = await service.confirm([extracted.candidates[0]!.id]);
    const scopedModules = product.listLegoModules({ scenarioId: scenario.id });
    expect(scopedModules.length).toBeGreaterThanOrEqual(1);
    expect(scopedModules[0]?.scope).toBe('scenario');
    expect(scopedModules[0]?.domain).toBeNull();
    void confirmed;

    const review = await service.reviewScenario({
      scenarioId: scenario.id,
      transcript: '面试官：讲讲跨部门案例？ 我：我先对齐了目标……',
      outcomeNote: '整体顺利，但证据部分被追问',
    });
    expect(review.phase).toBe('candidates-ready');
    expect(review.transcript.some((entry) => entry.kind === 'analysis')).toBe(true);
    expect(review.candidates[0]?.title).toBe('复盘沉淀模块');
  });

  it('promotes scenario modules only through the explicit consent path', async () => {
    const scenario = service.createScenario({
      type: 'meeting', title: '会议', objective: '', counterpart: '', worries: '',
    });
    const { module } = product.createLegoCandidate({
      id: randomUUID(),
      scope: 'scenario',
      scenarioId: scenario.id,
      category: 'viewpoint',
      title: '场景模块',
      triggers: [],
      payload: {
        semanticKernel: '内核', logicSkeleton: ['一步'], languageShells: ['一句'],
        anchorPhrase: '', slots: [], purpose: '', boundaries: '',
      },
      authorship: 'co-extracted',
    });
    product.confirmLegoVersion(module.id, 1);
    const promoted = product.promoteModuleToGlobal(module.id, 'professional');
    expect(promoted.scope).toBe('global');
    expect(promoted.domain).toBe('professional');
    expect(product.listConsentEvents(`lego:${module.id}`)
      .some((event) => event.action === 'scope-promotion')).toBe(true);
    expect(() => product.promoteModuleToGlobal(module.id, 'generic'))
      .toThrow('Only scenario modules');
  });

  it('parses agent JSON replies defensively', () => {
    const schema = z.object({ a: z.number() });
    expect(parseJsonReply('noise {"a": 1} trailing', schema)).toEqual({ a: 1 });
    expect(() => parseJsonReply('no json here', schema)).toThrow('no JSON');
    expect(extractFinalText([resultMessage('x')])).toBe('x');
  });
});
