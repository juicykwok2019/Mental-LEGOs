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
  TrainingSessionService,
  type TrainingAgentRunner,
} from '../../src/main/training-session';

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

class FakeAgent implements TrainingAgentRunner {
  prompts: string[] = [];
  #agentSessionId = randomUUID();

  async run(request: Parameters<TrainingAgentRunner['run']>[0]) {
    this.prompts.push(request.prompt);
    let reply = 'unhandled prompt';
    if (request.prompt.includes('Generate exactly ONE open professional question')) {
      reply = '当一个跨团队项目的关键干系人反对你的方案时，你会如何处理？';
    } else if (request.prompt.includes('Diagnose it now')) {
      reply = '1. 观点不明确：你说"可能要看情况"，没有给出判断。\n2. 缺少结构：回答没有可复用的展开顺序。';
    } else if (request.prompt.includes('one hint at level L1')) {
      reply = '这类问题的沟通任务是：展示你如何处理分歧，而不是证明你是对的。';
    } else if (request.prompt.includes('extract at most two candidate')) {
      const repository = new GovernanceRepository(request.governanceDatabasePath);
      try {
        repository.submitCandidate({
          sessionId: request.workspace.sessionId,
          kind: 'language_module',
          payload: {
            title: '分歧处理开场',
            category: 'interaction',
            triggers: ['干系人反对', '方案分歧'],
            semantic_kernel: '先理解反对背后的关切，再谈方案本身',
            logic_skeleton: ['确认关切', '复述立场', '提出验证方式'],
            language_shells: ['我会先弄清楚他反对的到底是什么，再回到方案。'],
          },
          provenance: {
            source_refs: [],
            method: 'daily-practice-extraction',
            generated_by: 'mental-legos-agent',
          },
          scope: 'personal',
          idempotencyKey: `test-extract-${randomUUID()}`,
        });
      } finally {
        repository.close();
      }
      reply = '候选1：分歧处理开场——先理解反对背后的关切。';
    }
    return {
      agentSessionId: this.#agentSessionId,
      messages: [resultMessage(reply)],
    };
  }
}

describe('chat-form training session orchestration', () => {
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
  });

  afterEach(async () => {
    product.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('runs the full chat loop and blocks every out-of-order step', async () => {
    await expect(service.diagnose()).rejects.toThrow('No training session');

    const started = await service.start('跨团队协作');
    expect(started.phase).toBe('first-attempt');
    expect(started.question?.prompt).toContain('干系人');
    expect(started.gate?.assistanceAllowed).toBe(false);

    await expect(service.diagnose()).rejects.toThrow('requires phase first-closed');
    await expect(service.second('太早了')).rejects.toThrow('requires phase assistance');

    const closed = await service.closeFirst({
      outcome: 'answered',
      responseText: '呃，可能要看情况吧，我一般会先跟他聊聊。',
    });
    expect(closed.phase).toBe('first-closed');

    const diagnosed = await service.diagnose();
    expect(diagnosed.phase).toBe('assistance');
    expect(diagnosed.gate?.assistanceAllowed).toBe(true);
    expect(diagnosed.gate?.nextHintLevel).toBe('L1');
    expect(diagnosed.transcript.some((entry) => entry.kind === 'diagnosis')).toBe(true);
    expect(product.listDiagnostics(started.gate!.attemptId).length).toBeGreaterThan(0);

    const hinted = await service.hint('L1');
    expect(hinted.gate?.nextHintLevel).toBe('L2');
    await expect(service.hint('L3')).rejects.toThrow('one level at a time');

    const seconded = await service.second(
      '我会先确认他反对的到底是什么，然后复述我的立场，最后提出一个双方都能接受的验证方式。',
    );
    expect(seconded.phase).toBe('second-done');

    const extracted = await service.extract();
    expect(extracted.phase).toBe('candidates-ready');
    expect(extracted.candidates).toHaveLength(1);
    const candidate = extracted.candidates[0]!;
    expect(candidate.title).toBe('分歧处理开场');

    const confirmed = await service.confirm([candidate.id]);
    expect(confirmed.phase).toBe('committed');
    expect(confirmed.committedCount).toBe(1);

    const modules = product.listLegoModules({ scope: 'global', status: 'confirmed' });
    expect(modules).toHaveLength(1);
    expect(modules[0]?.title).toBe('分歧处理开场');
    const mastery = product.getMasteryState(modules[0]!.id);
    expect(mastery?.stage).toBe('confirmed');
    expect(mastery?.dueAt).not.toBeNull();
    expect(service.dueQueue('2100-01-01T00:00:00.000Z')).toHaveLength(1);
  });

  it('keeps cannot-answer as a first-class path into diagnosis', async () => {
    await service.start('');
    const closed = await service.closeFirst({ outcome: 'cannot-answer', responseText: '' });
    expect(closed.phase).toBe('first-closed');
    const diagnosed = await service.diagnose();
    expect(diagnosed.phase).toBe('assistance');
  });

  it('rejects confirming unknown candidates', async () => {
    await service.start('');
    await service.closeFirst({ outcome: 'answered', responseText: '回答' });
    await service.diagnose();
    await service.second('第二遍');
    await service.extract();
    await expect(service.confirm([randomUUID()])).rejects.toThrow('Unknown candidate');
  });

  it('extracts the final text from SDK result messages only', () => {
    expect(extractFinalText([
      { type: 'assistant', message: {} },
      resultMessage('final'),
    ])).toBe('final');
    expect(() => extractFinalText([{ type: 'assistant' }])).toThrow('final response');
  });
});
