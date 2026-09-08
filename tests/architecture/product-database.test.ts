import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LegoVersionPayload } from '../../src/data/contracts';
import { FieldCodec, StaticDataKeyProvider } from '../../src/data/crypto';
import { exportDatabase, restoreDatabase } from '../../src/data/export';
import { MIGRATIONS } from '../../src/data/migrations';
import { ProductDatabase } from '../../src/data/product-database';

const NOW = '2026-08-17T10:00:00.000Z';
const LATER = '2026-08-17T11:00:00.000Z';

const payload: LegoVersionPayload = {
  semanticKernel: 'AI 项目的长期壁垒主要来自业务闭环，而不只是模型能力',
  logicSkeleton: ['模型能力趋同', '落地难点在流程与数据', '持续闭环形成积累'],
  languageShells: ['如果放到商业落地里看，真正的壁垒是业务闭环能不能持续跑起来。'],
  anchorPhrase: '壁垒在闭环',
  slots: [{ name: 'industry', description: '所讨论的行业' }],
  purpose: '给出核心判断',
  boundaries: '不适用于纯研究项目',
};

describe('formal product database', () => {
  let directory: string;
  let database: ProductDatabase;
  let keys: StaticDataKeyProvider;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'mental-legos-data-'));
    keys = StaticDataKeyProvider.random();
    database = new ProductDatabase(path.join(directory, 'product.db'), keys);
  });

  afterEach(async () => {
    try {
      database.close();
    } catch {
      // already closed by the test body
    }
    await rm(directory, { recursive: true, force: true });
  });

  function seedScenarioTraining(): {
    scenarioId: string; questionId: string; attemptId: string; segmentId: string; moduleId: string;
  } {
    const scenario = database.createScenario({
      id: randomUUID(),
      type: 'interview',
      title: '合成产品面试场景',
      objective: '验证训练闭环的数据链路',
      counterpart: '虚构面试官',
      scheduledFor: null,
      status: 'active',
      now: NOW,
    });
    const source = database.registerSource({
      id: randomUUID(),
      scenarioId: scenario.id,
      scope: 'scenario',
      kind: 'pasted-text',
      label: '合成职位描述',
      intent: '',
      contentHash: 'a'.repeat(64),
      mediaPath: null,
      retention: 'keep',
      authorizedAt: NOW,
      now: NOW,
    });
    const segmentId = randomUUID();
    database.addSourceSegments([{
      id: segmentId,
      sourceId: source.id,
      content: '负责跨团队推进 AI 产品从原型到规模化落地',
      startMs: null,
      endMs: null,
      page: 1,
      speaker: null,
      confidence: null,
    }]);
    const question = database.createQuestion({
      id: randomUUID(),
      scope: 'scenario',
      scenarioId: scenario.id,
      prompt: '请谈谈你如何评估一个 AI 项目的长期壁垒。',
      origin: 'scenario-analysis',
      parentQuestionId: null,
      targetModuleIds: [],
      pressure: 'none',
      now: NOW,
    });
    const attempt = database.createAttempt({
      id: randomUUID(),
      questionId: question.id,
      round: 'first',
      state: 'FIRST_ATTEMPT_CLOSED',
      outcome: 'answered',
      responseText: '我认为壁垒不只是模型，更多是业务闭环……',
      recordingSourceId: null,
      openingDelayMs: 4200,
      durationMs: 95_000,
      hintLevel: 'none',
      now: NOW,
    });
    const { module } = database.createLegoCandidate({
      id: randomUUID(),
      scope: 'scenario',
      scenarioId: scenario.id,
      category: 'viewpoint',
      title: '核心判断模块',
      triggers: ['壁垒', '护城河', '竞争优势'],
      payload,
      authorship: 'co-extracted',
      evidenceSegmentIds: [segmentId],
      attemptIds: [attempt.id],
      now: NOW,
    });
    return {
      scenarioId: scenario.id,
      questionId: question.id,
      attemptId: attempt.id,
      segmentId,
      moduleId: module.id,
    };
  }

  it('applies migrations exactly once and reports the schema version', () => {
    expect(database.migratedVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    const reopened = new ProductDatabase(path.join(directory, 'product.db'), keys);
    expect(reopened.migratedVersion).toBe(database.migratedVersion);
    reopened.close();
  });

  it('round-trips the full training chain with decrypted reads', () => {
    const ids = seedScenarioTraining();
    const attempt = database.getAttempt(ids.attemptId);
    expect(attempt?.responseText).toContain('业务闭环');
    expect(database.getQuestion(ids.questionId)?.prompt).toContain('长期壁垒');
    expect(database.getSourceSegment(ids.segmentId)?.content).toContain('规模化落地');
    const version = database.getLegoVersion(ids.moduleId, 1);
    expect(version?.payload.semanticKernel).toContain('业务闭环');
    expect(version?.evidenceSegmentIds).toEqual([ids.segmentId]);
  });

  it('keeps sensitive text encrypted at rest in the database and WAL files', async () => {
    seedScenarioTraining();
    database.close();
    const chunks = [await readFile(path.join(directory, 'product.db'))];
    try {
      chunks.push(await readFile(path.join(directory, 'product.db-wal')));
    } catch {
      // WAL already checkpointed into the main file
    }
    const utf8 = Buffer.concat(chunks).toString('utf8');
    expect(utf8).not.toContain('业务闭环');
    expect(utf8).not.toContain('规模化落地');
    expect(utf8).toContain('核心判断模块');
    database = new ProductDatabase(path.join(directory, 'product.db'), keys);
  });

  it('refuses formal confirmation shortcuts and records consent on confirmation', () => {
    const ids = seedScenarioTraining();
    expect(database.getLegoModule(ids.moduleId)?.status).toBe('candidate');
    expect(() => database.confirmLegoVersion(ids.moduleId, 99)).toThrow('version');
    const confirmed = database.confirmLegoVersion(ids.moduleId, 1, LATER);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.currentVersion).toBe(1);
    const consents = database.listConsentEvents(`lego:${ids.moduleId}@1`);
    expect(consents).toHaveLength(1);
    expect(consents[0]?.decision).toBe('granted');
    expect(database.getMasteryState(ids.moduleId)?.stage).toBe('confirmed');
  });

  it('lists scenario sources and deletes one with its segments', () => {
    const ids = seedScenarioTraining();
    const sources = database.listScenarioSources(ids.scenarioId);
    expect(sources).toHaveLength(1);
    const [source] = sources;
    if (!source) throw new Error('seed produced no source');
    expect(source.characters).toBeGreaterThan(0);

    database.registerSource({
      id: randomUUID(),
      scenarioId: ids.scenarioId,
      scope: 'scenario',
      kind: 'pasted-text',
      label: '带意图材料',
      intent: '重点针对算法要求出题',
      contentHash: 'a'.repeat(64),
      mediaPath: null,
      retention: 'keep',
      authorizedAt: NOW,
      now: NOW,
    });
    const withIntent = database.listScenarioSources(ids.scenarioId)
      .find((entry) => entry.label === '带意图材料');
    expect(withIntent?.intent).toBe('重点针对算法要求出题');
    if (withIntent) database.deleteSource(withIntent.id, LATER);

    database.deleteSource(source.id, LATER);
    expect(database.listScenarioSources(ids.scenarioId)).toHaveLength(0);
    expect(database.listScenarioSegments(ids.scenarioId)).toHaveLength(0);
    expect(database.listConsentEvents(`source:${source.id}`)).toHaveLength(1);
    expect(() => database.deleteSource(source.id)).toThrow('Source');
  });

  it('stores and returns the speech outline encrypted at rest', () => {
    const ids = seedScenarioTraining();
    database.setScenarioSpeechOutline(ids.scenarioId, '开场钩子：从壁垒问题切入……', LATER);
    expect(database.getScenarioExtras(ids.scenarioId)?.speechOutline)
      .toBe('开场钩子：从壁垒问题切入……');
    const raw = database.dumpTable('scenarios')[0];
    expect(String(raw?.speech_outline_enc)).not.toContain('壁垒');
  });

  it('links modules bidirectionally and unlinks by id', () => {
    const ids = seedScenarioTraining();
    const other = database.createLegoCandidate({
      id: randomUUID(),
      scope: 'global',
      scenarioId: null,
      category: 'evidence',
      title: '证据支撑模块',
      triggers: [],
      payload,
      authorship: 'user-native',
      evidenceSegmentIds: [],
      now: NOW,
    });
    const link = database.linkModules({
      id: randomUUID(),
      fromModuleId: ids.moduleId,
      toModuleId: other.module.id,
      relation: 'composes-with',
    });
    const fromSide = database.listModuleLinks(ids.moduleId);
    expect(fromSide).toHaveLength(1);
    expect(fromSide[0]?.otherTitle).toBe('证据支撑模块');
    expect(fromSide[0]?.direction).toBe('out');
    const toSide = database.listModuleLinks(other.module.id);
    expect(toSide[0]?.direction).toBe('in');
    expect(() => database.linkModules({
      id: randomUUID(), fromModuleId: ids.moduleId, toModuleId: ids.moduleId, relation: 'similar-to',
    })).toThrow('自己');
    database.unlinkModules(link.id);
    expect(database.listModuleLinks(ids.moduleId)).toHaveLength(0);
  });

  it('hard-deletes a module with versions and mastery cascading', () => {
    const ids = seedScenarioTraining();
    database.confirmLegoVersion(ids.moduleId, 1, NOW);
    database.deleteLegoModule(ids.moduleId, LATER);
    expect(database.getLegoModule(ids.moduleId)).toBeNull();
    expect(database.getLegoVersion(ids.moduleId, 1)).toBeNull();
    expect(database.getMasteryState(ids.moduleId)).toBeNull();
    expect(database.listConsentEvents(`lego:${ids.moduleId}`)
      .some((event) => event.action === 'deletion')).toBe(true);
    expect(database.search('壁垒').some((hit) => hit.entityId === ids.moduleId)).toBe(false);
  });

  it('merges a similar module: shells absorbed, other archived, link removed', () => {
    const ids = seedScenarioTraining();
    database.confirmLegoVersion(ids.moduleId, 1, NOW);
    const other = database.createLegoCandidate({
      id: randomUUID(),
      scope: 'global',
      scenarioId: null,
      category: 'viewpoint',
      title: '近义模块',
      triggers: ['闭环'],
      payload: { ...payload, languageShells: ['换个说法：壁垒的本质是闭环能不能持续。'] },
      authorship: 'user-native',
      evidenceSegmentIds: [],
      now: NOW,
    });
    database.confirmLegoVersion(other.module.id, 1, NOW);
    database.linkModules({
      id: randomUUID(),
      fromModuleId: ids.moduleId,
      toModuleId: other.module.id,
      relation: 'similar-to',
    });

    const merged = database.mergeSimilarModules(ids.moduleId, other.module.id, LATER);
    const version = database.getLegoVersion(ids.moduleId, merged.currentVersion ?? 0);
    expect(version?.payload.languageShells).toContain('换个说法：壁垒的本质是闭环能不能持续。');
    expect(database.getLegoModule(other.module.id)?.status).toBe('archived');
    expect(database.getLegoModule(ids.moduleId)?.triggers).toContain('闭环');
    expect(database.listModuleLinks(ids.moduleId)).toHaveLength(0);
  });

  it('links a recording source to an attempt and cleans up on deletion', () => {
    const ids = seedScenarioTraining();
    const recordingId = randomUUID();
    database.registerSource({
      id: recordingId,
      scenarioId: ids.scenarioId,
      scope: 'scenario',
      kind: 'recording',
      label: '语音回答录音',
      intent: '',
      contentHash: 'b'.repeat(64),
      mediaPath: 'X:/media/recording.wav',
      retention: 'keep',
      authorizedAt: NOW,
      now: NOW,
    });
    database.updateAttempt(ids.attemptId, { recordingSourceId: recordingId }, LATER);
    expect(database.getAttempt(ids.attemptId)?.recordingSourceId).toBe(recordingId);
    expect(database.recordingContext(recordingId)).toBeTruthy();

    database.deleteRecordingSource(recordingId);
    expect(database.getAttempt(ids.attemptId)?.recordingSourceId).toBeNull();
    expect(database.sourceExists(recordingId)).toBe(false);
    expect(database.recordingContext(recordingId)).toBeNull();
  });

  it('renames a module and keeps search in sync', () => {
    const ids = seedScenarioTraining();
    database.renameLegoModule(ids.moduleId, '化解销量质疑', LATER);
    expect(database.getLegoModule(ids.moduleId)?.title).toBe('化解销量质疑');
    expect(database.search('化解销量').some((hit) => hit.entityId === ids.moduleId)).toBe(true);
    expect(database.search('核心判断模块').some((hit) => hit.entityId === ids.moduleId)).toBe(false);
  });

  it('restores an archived module back to confirmed', () => {
    const ids = seedScenarioTraining();
    database.confirmLegoVersion(ids.moduleId, 1, NOW);
    database.archiveLegoModule(ids.moduleId, LATER);
    expect(database.getLegoModule(ids.moduleId)?.status).toBe('archived');
    database.restoreLegoModule(ids.moduleId, LATER);
    expect(database.getLegoModule(ids.moduleId)?.status).toBe('confirmed');
    expect(() => database.restoreLegoModule(ids.moduleId)).toThrow('archived');
  });

  it('deletes a single module version and repoints the current pointer', () => {
    const ids = seedScenarioTraining();
    database.confirmLegoVersion(ids.moduleId, 1, NOW);
    database.addLegoVersion(ids.moduleId, payload, 'co-extracted', { now: LATER });
    database.confirmLegoVersion(ids.moduleId, 2, LATER);

    const afterDelete = database.deleteLegoVersion(ids.moduleId, 2, LATER);
    expect(afterDelete.currentVersion).toBe(1);
    expect(database.getLegoVersion(ids.moduleId, 2)).toBeNull();
    expect(database.listLegoVersions(ids.moduleId)).toHaveLength(1);
    expect(database.listConsentEvents(`lego:${ids.moduleId}@2`)
      .some((event) => event.action === 'deletion')).toBe(true);
    expect(() => database.deleteLegoVersion(ids.moduleId, 1)).toThrow('归档');
  });

  it('blocks new profile assertions from starting as confirmed facts', () => {
    expect(() => database.createProfileAssertion({
      id: randomUUID(),
      tier: 'confirmed-fact',
      statement: '用户是资深架构师',
      evidenceSegmentIds: [],
      now: NOW,
    })).toThrow('confirm it explicitly');
    const assertion = database.createProfileAssertion({
      id: randomUUID(),
      tier: 'pending-hypothesis',
      statement: '用户可能擅长跨团队沟通',
      evidenceSegmentIds: [],
      now: NOW,
    });
    const resolved = database.resolveProfileAssertion(assertion.id, 'confirmed', LATER);
    expect(resolved.tier).toBe('confirmed-fact');
    expect(() => database.resolveProfileAssertion(assertion.id, 'rejected')).toThrow('candidate');
  });

  it('lets the user retire any assertion, and ages stale confirmed facts back to review', () => {
    const assertion = database.createProfileAssertion({
      id: randomUUID(),
      tier: 'evidenced-observation',
      statement: '结论习惯放在最后才说',
      evidenceSegmentIds: [],
      now: NOW,
    });
    database.resolveProfileAssertion(assertion.id, 'confirmed', LATER);

    // 90 天内：不动。
    const soon = new Date(new Date(LATER).getTime() + 30 * 86_400_000).toISOString();
    expect(database.sweepStaleAssertions(soon)).toBe(0);

    // 90 天无新证据：降回"有据观察 · 待复核"，停用于出题。
    const stale = new Date(new Date(LATER).getTime() + 91 * 86_400_000).toISOString();
    expect(database.sweepStaleAssertions(stale)).toBe(1);
    const demoted = database.listProfileAssertions('candidate')
      .find((entry) => entry.id === assertion.id);
    expect(demoted?.tier).toBe('evidenced-observation');
    expect(database.listProfileAssertions('confirmed')
      .some((entry) => entry.id === assertion.id)).toBe(false);

    // 「不再是我」：任何状态可归档，且留下删除同意记录。
    database.archiveProfileAssertion(assertion.id, stale);
    expect(database.listProfileAssertions('archived')
      .some((entry) => entry.id === assertion.id)).toBe(true);
    expect(database.listConsentEvents(`profile:${assertion.id}`)
      .some((event) => event.action === 'deletion')).toBe(true);
  });

  it('promotes a hypothesis only after four rounds of evidence, and no further', () => {
    const assertion = database.createProfileAssertion({
      id: randomUUID(),
      tier: 'pending-hypothesis',
      statement: '压力追问下习惯以「呃」开场',
      evidenceSegmentIds: [randomUUID()],
      now: NOW,
    });
    // 第 2、3 轮证据：仍是待验假设（满 2 轮进入待复核，但层级不变）。
    const two = database.reinforceProfileAssertion(assertion.id, [randomUUID()], LATER);
    expect(two.tier).toBe('pending-hypothesis');
    expect(two.evidenceSegmentIds).toHaveLength(2);
    const three = database.reinforceProfileAssertion(assertion.id, [randomUUID()], LATER);
    expect(three.tier).toBe('pending-hypothesis');
    // 第 4 轮：自动晋升有据观察；再强化只补证据不再晋升。
    const four = database.reinforceProfileAssertion(assertion.id, [randomUUID()], LATER);
    expect(four.tier).toBe('evidenced-observation');
    expect(four.status).toBe('candidate');
    const again = database.reinforceProfileAssertion(assertion.id, [randomUUID()], LATER);
    expect(again.tier).toBe('evidenced-observation');
    expect(again.statement).toBe('压力追问下习惯以「呃」开场');
  });

  it('supports mastery progression, regression, and due scheduling', () => {
    const ids = seedScenarioTraining();
    database.confirmLegoVersion(ids.moduleId, 1, NOW);
    database.updateMasteryState(ids.moduleId, {
      stage: 'independent-recall',
      dueAt: '2026-08-20T09:00:00.000Z',
      lastPracticedAt: NOW,
    }, NOW);
    database.updateMasteryState(ids.moduleId, { stage: 'prompted-recall' }, LATER);
    expect(database.getMasteryState(ids.moduleId)?.stage).toBe('prompted-recall');
    expect(database.listDueModules('2026-08-19T00:00:00.000Z')).toHaveLength(0);
    expect(database.listDueModules('2026-08-21T00:00:00.000Z')).toHaveLength(1);
  });

  it('finds Chinese text through the index and through deep decrypted search', () => {
    const ids = seedScenarioTraining();
    const shallow = database.search('壁垒');
    expect(shallow.some((hit) => hit.entityId === ids.moduleId)).toBe(true);
    const deep = database.searchDeep('业务闭环', { scenarioId: ids.scenarioId });
    expect(deep.some((hit) => hit.entityType === 'lego-version' && hit.entityId === ids.moduleId))
      .toBe(true);
    const twoChar = database.search('护城');
    expect(twoChar.some((hit) => hit.entityId === ids.moduleId)).toBe(true);
  });

  it('previews scenario deletion accurately and cascades within the scenario scope only', () => {
    const ids = seedScenarioTraining();
    const globalModule = database.createLegoCandidate({
      id: randomUUID(),
      scope: 'global',
      scenarioId: null,
      category: 'evidence',
      title: '全局证据模块',
      triggers: ['数据'],
      payload,
      authorship: 'user-native',
      evidenceSegmentIds: [ids.segmentId],
      now: NOW,
    });
    const preview = database.previewScenarioDeletion(ids.scenarioId);
    expect(preview).toMatchObject({
      sources: 1,
      segments: 1,
      questions: 1,
      attempts: 1,
      scopedModules: 1,
      globalModuleReferences: 1,
    });
    const executed = database.deleteScenario(ids.scenarioId, LATER);
    expect(executed).toEqual(preview);
    expect(database.getScenario(ids.scenarioId)).toBeNull();
    expect(database.getLegoModule(ids.moduleId)).toBeNull();
    expect(database.getLegoModule(globalModule.module.id)?.status).toBe('candidate');
    expect(database.listConsentEvents(`scenario:${ids.scenarioId}`)).toHaveLength(1);
    expect(database.search('壁垒').some((hit) => hit.entityId === ids.moduleId)).toBe(false);
  });

  it('rejects malicious column names in restored backup rows', () => {
    expect(() => database.restoreRow('scenarios', {
      'id) VALUES (1); DROP TABLE scenarios;--': 'x',
    })).toThrow('Invalid column name');
    expect(() => database.restoreRow('scenarios; DROP TABLE sources', { id: 'x' }))
      .toThrow('Invalid table name');
  });

  it('exports with a password and restores into a fresh database with a different key', () => {
    const ids = seedScenarioTraining();
    database.confirmLegoVersion(ids.moduleId, 1, LATER);
    const envelope = exportDatabase(database, 'correct horse battery', LATER);
    expect(envelope.manifest.tableCounts.lego_modules).toBe(1);
    expect(JSON.stringify(envelope.sealed)).not.toContain('业务闭环');

    const otherDirectory = path.join(directory, 'restored');
    const restored = new ProductDatabase(
      path.join(directory, 'restored.db'),
      StaticDataKeyProvider.random(),
    );
    expect(() => restoreDatabase(restored, envelope, 'wrong password!!')).toThrow();
    restoreDatabase(restored, envelope, 'correct horse battery');
    expect(restored.getLegoVersion(ids.moduleId, 1)?.payload.semanticKernel)
      .toContain('业务闭环');
    expect(restored.getAttempt(ids.attemptId)?.responseText).toContain('业务闭环');
    expect(restored.search('壁垒').some((hit) => hit.entityId === ids.moduleId)).toBe(true);
    expect(() => restoreDatabase(restored, envelope, 'correct horse battery'))
      .toThrow('empty database');
    restored.close();
    void otherDirectory;
  });

  it('never stores field plaintext for an empty-string edge case', () => {
    const codec = new FieldCodec(keys);
    const encrypted = codec.encrypt('');
    expect(FieldCodec.isEncrypted(encrypted)).toBe(true);
    expect(codec.decrypt(encrypted)).toBe('');
  });
});
