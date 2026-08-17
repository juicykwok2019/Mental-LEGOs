import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GovernanceRepository } from '../../src/agent/governance';
import { StaticDataKeyProvider } from '../../src/data/crypto';
import {
  FormalMaterializer,
  normalizeLegoMaterial,
  validateCandidatePayload,
} from '../../src/data/formal-materializer';
import { ProductDatabase } from '../../src/data/product-database';

const NOW = '2026-08-17T12:00:00.000Z';

const legoPayload = {
  title: '争取思考时间',
  category: 'opening' as const,
  triggers: ['突发提问', '压力问题'],
  semantic_kernel: '先确认问题边界可以换取组织语言的时间',
  logic_skeleton: ['重述问题', '确认范围', '给出路线'],
  language_shells: ['这是一个好问题，我先确认一下您问的是哪个层面……'],
};

describe('provider payload normalization', () => {
  it('repairs camelCase keys, scalar arrays, and off-enum categories', () => {
    const normalized = normalizeLegoMaterial({
      title: '争取思考时间',
      category: 'Reasoning',
      semanticKernel: '先确认边界换取时间',
      logic_skeleton: '重述问题',
      languageShells: '我先确认一下范围……',
    }) as Record<string, unknown>;
    expect(normalized.semantic_kernel).toBe('先确认边界换取时间');
    expect(normalized.logic_skeleton).toEqual(['重述问题']);
    expect(normalized.language_shells).toEqual(['我先确认一下范围……']);
    expect(normalized.category).toBe('reasoning');
    expect(() => validateCandidatePayload('language_module', normalized)).not.toThrow();
  });

  it('derives a kernel and title when the provider omits them', () => {
    const normalized = normalizeLegoMaterial({
      category: 'made-up-category',
      language_shells: ['真正的壁垒是业务闭环能不能跑起来。'],
    }) as Record<string, unknown>;
    expect(normalized.semantic_kernel).toBe('真正的壁垒是业务闭环能不能跑起来。');
    expect(normalized.title).toBeTruthy();
    expect(normalized.category).toBe('viewpoint');
    expect(() => validateCandidatePayload('language_module', normalized)).not.toThrow();
  });
});

describe('governance-to-formal materialization bridge', () => {
  let directory: string;
  let product: ProductDatabase;
  let staging: GovernanceRepository;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'mental-legos-bridge-'));
    product = new ProductDatabase(
      path.join(directory, 'product.db'),
      StaticDataKeyProvider.random(),
    );
    staging = new GovernanceRepository();
  });

  afterEach(async () => {
    staging.close();
    product.close();
    await rm(directory, { recursive: true, force: true });
  });

  function commitCandidate(kind: 'language_module' | 'profile_observation' | 'research_result', payload: Record<string, unknown>): string[] {
    const sessionId = `session-${randomUUID()}`;
    const submitted = staging.submitCandidate({
      sessionId,
      kind,
      payload,
      provenance: {
        source_refs: [],
        method: 'synthetic-test',
        generated_by: 'mental-legos-agent',
      },
      scope: 'personal',
      idempotencyKey: `idem-${randomUUID()}`,
    });
    const { previewId } = staging.prepareCommit([submitted.candidateId]);
    const token = staging.issueConfirmationToken({ action: 'commit', previewId });
    const { assetIds } = staging.commitConfirmed({ token, previewId, userEdits: {} });
    return assetIds;
  }

  it('materializes a confirmed language module into the formal library', () => {
    validateCandidatePayload('language_module', legoPayload);
    const [assetId] = commitCandidate('language_module', legoPayload);
    if (!assetId) throw new Error('commit produced no asset');

    const materializer = new FormalMaterializer(product);
    const result = materializer.sync(staging.listFormalAssets(), NOW);
    expect(result.failed).toEqual([]);
    expect(result.materialized).toEqual([{ assetId, entity: 'lego-module' }]);

    const module = product.getLegoModule(assetId);
    expect(module?.status).toBe('confirmed');
    expect(module?.scope).toBe('global');
    const version = product.getLegoVersion(assetId, 1);
    expect(version?.payload.semanticKernel).toContain('问题边界');
    expect(product.listConsentEvents(`lego:${assetId}@1`)).toHaveLength(1);
    expect(product.getMasteryState(assetId)?.stage).toBe('confirmed');
  });

  it('is idempotent across repeated syncs and repairs partial materialization', () => {
    commitCandidate('language_module', legoPayload);
    const materializer = new FormalMaterializer(product);
    const first = materializer.sync(staging.listFormalAssets(), NOW);
    expect(first.materialized).toHaveLength(1);
    const second = materializer.sync(staging.listFormalAssets(), NOW);
    expect(second.materialized).toHaveLength(0);
    expect(second.skippedExisting).toHaveLength(1);
    expect(product.listLegoModules({ scope: 'global' })).toHaveLength(1);
  });

  it('materializes profile observations and knowledge with confirmation semantics', () => {
    const [profileAssetId] = commitCandidate('profile_observation', {
      statement: '用户在压力下倾向于先收敛问题再回答',
    });
    const [knowledgeAssetId] = commitCandidate('research_result', {
      title: '提取练习的迁移效应',
      content: '在改变问法的条件下重复提取，比重读更有利于迁移。',
      knowledge_kind: 'fact',
    });
    const result = new FormalMaterializer(product).sync(staging.listFormalAssets(), NOW);
    expect(result.failed).toEqual([]);
    expect(result.materialized).toHaveLength(2);
    const knowledge = product.getKnowledgeItem(String(knowledgeAssetId));
    expect(knowledge?.status).toBe('confirmed');
    expect(knowledge?.kind).toBe('fact');
    void profileAssetId;
  });

  it('rejects malformed payloads at validation time and refuses session scope', () => {
    expect(() => validateCandidatePayload('language_module', { title: '缺少内核' }))
      .toThrow();
    const sessionScoped = [{
      id: randomUUID(),
      kind: 'language_module' as const,
      payload: legoPayload as Record<string, unknown>,
      provenance: {},
      scope: 'session' as const,
    }];
    const result = new FormalMaterializer(product).sync(sessionScoped, NOW);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toContain('Session-scoped');
  });

  it('requires a bound scenario for scenario-scoped assets', () => {
    const scenarioAsset = [{
      id: randomUUID(),
      kind: 'language_module' as const,
      payload: legoPayload as Record<string, unknown>,
      provenance: {},
      scope: 'scenario' as const,
    }];
    const unbound = new FormalMaterializer(product).sync(scenarioAsset, NOW);
    expect(unbound.failed[0]?.reason).toContain('bound scenario');

    const scenario = product.createScenario({
      id: randomUUID(),
      type: 'interview',
      title: '合成场景',
      objective: '',
      counterpart: '',
      scheduledFor: null,
      status: 'active',
      now: NOW,
    });
    const bound = new FormalMaterializer(product, { scenarioId: scenario.id })
      .sync(scenarioAsset, NOW);
    expect(bound.failed).toEqual([]);
    expect(product.getLegoModule(scenarioAsset[0]!.id)?.scenarioId).toBe(scenario.id);
  });
});
