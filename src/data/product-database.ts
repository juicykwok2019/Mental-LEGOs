import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import {
  attemptSchema,
  auditEventSchema,
  profileSeedSchema,
  type ProfileSeed,
  consentEventSchema,
  diagnosticSchema,
  knowledgeItemSchema,
  legoModuleSchema,
  legoVersionPayloadSchema,
  legoVersionSchema,
  masteryStateSchema,
  moduleLinkSchema,
  practiceEventSchema,
  profileAssertionSchema,
  questionSchema,
  scenarioDeletionPreviewSchema,
  scenarioSchema,
  sourceSchema,
  sourceSegmentSchema,
  agentSessionSchema,
  type Attempt,
  type AuditEvent,
  type ConsentEvent,
  type Diagnostic,
  type KnowledgeItem,
  type LegoModule,
  type LegoVersion,
  type MasteryState,
  type ModuleLink,
  type PracticeEvent,
  type ProfileAssertion,
  type Question,
  type Scenario,
  type ScenarioDeletionPreview,
  type SourceRecord,
  type SourceSegment,
  type AgentSessionRecord,
  type DataScope,
} from './contracts';
import { FieldCodec, type DataKeyProvider } from './crypto';
import { MIGRATIONS } from './migrations';

type Row = Record<string, unknown>;

const stringArraySchema = z.array(z.string());

function parseStringArray(value: unknown): string[] {
  return stringArraySchema.parse(JSON.parse(String(value)));
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface SearchHit {
  entityType: 'scenario' | 'knowledge' | 'lego-module' | 'question';
  entityId: string;
  text: string;
}

export interface DeepSearchHit {
  entityType: 'knowledge' | 'lego-version' | 'attempt';
  entityId: string;
  excerpt: string;
}

export class ProductDatabase {
  readonly #database: DatabaseSync;
  readonly #codec: FieldCodec;

  constructor(databasePath: string, keyProvider: DataKeyProvider) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.#codec = new FieldCodec(keyProvider);
    this.#migrate();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const applied = new Set(
      (this.#database.prepare('SELECT version FROM schema_migrations').all() as Row[])
        .map((row) => Number(row.version)),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.#database.exec('BEGIN');
      try {
        this.#database.exec(migration.statements);
        this.#database.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        ).run(migration.version, migration.name, nowIso());
        this.#database.exec('COMMIT');
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    }
  }

  close(): void {
    this.#database.close();
  }

  get migratedVersion(): number {
    const row = this.#database.prepare(
      'SELECT MAX(version) AS version FROM schema_migrations',
    ).get() as Row;
    return Number(row.version ?? 0);
  }

  #inTransaction = false;

  // Reentrant: composite operations (e.g. merge) call transactional building
  // blocks — inner calls join the outer transaction instead of nesting BEGIN.
  #transaction<T>(work: () => T): T {
    if (this.#inTransaction) return work();
    this.#database.exec('BEGIN');
    this.#inTransaction = true;
    try {
      const result = work();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }

  #indexSearchText(entityType: SearchHit['entityType'], entityId: string, text: string): void {
    this.#database.prepare('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?')
      .run(entityType, entityId);
    if (text.trim().length > 0) {
      this.#database.prepare(
        'INSERT INTO search_index (entity_type, entity_id, text) VALUES (?, ?, ?)',
      ).run(entityType, entityId, text);
    }
  }

  #dropSearchText(entityType: SearchHit['entityType'], entityId: string): void {
    this.#database.prepare('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?')
      .run(entityType, entityId);
  }

  // ─── Scenarios ────────────────────────────────────────────────────────────

  createScenario(input: Omit<Scenario, 'createdAt' | 'updatedAt'> & { now?: string }): Scenario {
    const now = input.now ?? nowIso();
    const scenario = scenarioSchema.parse({ ...input, createdAt: now, updatedAt: now });
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO scenarios (id, type, title, objective, counterpart, scheduled_for, status,
          created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scenario.id, scenario.type, scenario.title, scenario.objective, scenario.counterpart,
        scenario.scheduledFor, scenario.status, scenario.createdAt, scenario.updatedAt,
      );
      this.#indexSearchText('scenario', scenario.id, `${scenario.title} ${scenario.objective}`);
    });
    return scenario;
  }

  getScenario(id: string): Scenario | null {
    const row = this.#database.prepare('SELECT * FROM scenarios WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? this.#scenarioFromRow(row) : null;
  }

  listScenarios(status?: Scenario['status']): Scenario[] {
    const rows = (status
      ? this.#database.prepare('SELECT * FROM scenarios WHERE status = ? ORDER BY created_at DESC')
        .all(status)
      : this.#database.prepare('SELECT * FROM scenarios ORDER BY created_at DESC').all()) as Row[];
    return rows.map((row) => this.#scenarioFromRow(row));
  }

  #scenarioFromRow(row: Row): Scenario {
    return scenarioSchema.parse({
      id: row.id,
      type: row.type,
      title: row.title,
      objective: row.objective,
      counterpart: row.counterpart,
      scheduledFor: row.scheduled_for,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  setScenarioWorries(scenarioId: string, worries: string, now = nowIso()): void {
    this.#database.prepare(
      'UPDATE scenarios SET worries_enc = ?, updated_at = ? WHERE id = ?',
    ).run(this.#codec.encrypt(worries), now, scenarioId);
  }

  setScenarioAnalysis(scenarioId: string, analysis: string, now = nowIso()): void {
    this.#database.prepare(
      'UPDATE scenarios SET analysis_enc = ?, updated_at = ? WHERE id = ?',
    ).run(this.#codec.encrypt(analysis), now, scenarioId);
  }

  setScenarioSpeechOutline(scenarioId: string, outline: string, now = nowIso()): void {
    this.#database.prepare(
      'UPDATE scenarios SET speech_outline_enc = ?, updated_at = ? WHERE id = ?',
    ).run(this.#codec.encrypt(outline), now, scenarioId);
  }

  getScenarioExtras(scenarioId: string): {
    worries: string; analysis: string; speechOutline: string;
  } | null {
    const row = this.#database.prepare(
      'SELECT worries_enc, analysis_enc, speech_outline_enc FROM scenarios WHERE id = ?',
    ).get(scenarioId) as Row | undefined;
    if (!row) return null;
    const decode = (value: unknown): string => {
      const stored = String(value ?? '');
      return stored.length > 0 ? this.#codec.decrypt(stored) : '';
    };
    return {
      worries: decode(row.worries_enc),
      analysis: decode(row.analysis_enc),
      speechOutline: decode(row.speech_outline_enc),
    };
  }

  listQuestionAttempts(questionId: string): Attempt[] {
    const rows = this.#database.prepare(
      'SELECT id FROM attempts WHERE question_id = ? ORDER BY created_at',
    ).all(questionId) as Row[];
    return rows.flatMap((row) => {
      const attempt = this.getAttempt(String(row.id));
      return attempt ? [attempt] : [];
    });
  }

  listScenarioQuestions(scenarioId: string): Array<Question & { answered: boolean }> {
    const rows = this.#database.prepare(
      "SELECT id FROM questions WHERE scenario_id = ? AND origin != 'variation' ORDER BY created_at",
    ).all(scenarioId) as Row[];
    return rows.flatMap((row) => {
      const question = this.getQuestion(String(row.id));
      if (!question) return [];
      const attempt = this.#database.prepare(
        'SELECT id FROM attempts WHERE question_id = ? LIMIT 1',
      ).get(question.id) as Row | undefined;
      return [{ ...question, answered: Boolean(attempt) }];
    });
  }

  countScenarioSources(scenarioId: string): number {
    const row = this.#database.prepare(
      'SELECT COUNT(*) AS n FROM sources WHERE scenario_id = ?',
    ).get(scenarioId) as Row;
    return Number(row.n ?? 0);
  }

  listScenarioSources(scenarioId: string): Array<{
    id: string; label: string; intent: string; kind: string; createdAt: string; characters: number;
  }> {
    const rows = this.#database.prepare(
      'SELECT id, label, intent_enc, kind, created_at FROM sources WHERE scenario_id = ? ORDER BY created_at',
    ).all(scenarioId) as Row[];
    const segmentStatement = this.#database.prepare(
      'SELECT content_enc FROM source_segments WHERE source_id = ?',
    );
    return rows.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      intent: row.intent_enc ? this.#codec.decrypt(String(row.intent_enc)) : '',
      kind: String(row.kind),
      createdAt: String(row.created_at),
      characters: (segmentStatement.all(String(row.id)) as Row[])
        .reduce((total, segment) => total + this.#codec.decrypt(String(segment.content_enc)).length, 0),
    }));
  }

  updateSourceIntent(sourceId: string, intent: string): void {
    const result = this.#database.prepare(
      'UPDATE sources SET intent_enc = ? WHERE id = ?',
    ).run(this.#codec.encrypt(intent), sourceId);
    if (Number(result.changes) === 0) throw new Error('Source does not exist.');
  }

  readSourceContent(sourceId: string): string {
    const rows = this.#database.prepare(
      'SELECT content_enc FROM source_segments WHERE source_id = ? ORDER BY rowid',
    ).all(sourceId) as Row[];
    return rows.map((row) => this.#codec.decrypt(String(row.content_enc))).join('\n');
  }

  // Per-material deletion (PRD layered deletion): one authorized source can be
  // withdrawn without touching the scenario. Module evidence referencing its
  // segments keeps the module, mirroring scenario deletion semantics.
  deleteSource(sourceId: string, now = nowIso()): void {
    this.#transaction(() => {
      const row = this.#database.prepare(
        'SELECT id, scope FROM sources WHERE id = ?',
      ).get(sourceId) as Row | undefined;
      if (!row) throw new Error('Source does not exist.');
      this.#database.prepare('DELETE FROM source_segments WHERE source_id = ?').run(sourceId);
      this.#database.prepare('DELETE FROM sources WHERE id = ?').run(sourceId);
      this.#recordConsent({
        id: randomUUID(),
        action: 'deletion',
        objectRef: `source:${sourceId}`,
        scope: (row.scope as DataScope | undefined) ?? 'scenario',
        decision: 'granted',
        occurredAt: now,
      });
    });
  }

  listScenarioSegments(scenarioId: string): SourceSegment[] {
    const rows = this.#database.prepare(`
      SELECT ss.id FROM source_segments ss
      JOIN sources s ON s.id = ss.source_id
      WHERE s.scenario_id = ? ORDER BY ss.rowid
    `).all(scenarioId) as Row[];
    return rows.flatMap((row) => {
      const segment = this.getSourceSegment(String(row.id));
      return segment ? [segment] : [];
    });
  }

  listRecentKnowledgeGaps(limit = 5): string[] {
    const rows = this.#database.prepare(`
      SELECT question_id FROM attempts WHERE gap = 'knowledge'
      ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as Row[];
    const prompts: string[] = [];
    for (const row of rows) {
      const question = this.getQuestion(String(row.question_id));
      if (question) prompts.push(question.prompt);
    }
    return prompts;
  }

  countKnowledgeGaps(): number {
    const row = this.#database.prepare(
      "SELECT COUNT(*) AS n FROM attempts WHERE gap = 'knowledge'",
    ).get() as Row;
    return Number(row.n ?? 0);
  }

  tableCount(table: string): number {
    if (!/^[a-z_]+$/u.test(table)) throw new Error('Invalid table name.');
    const row = this.#database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row;
    return Number(row.n ?? 0);
  }

  // ─── Sources and segments ────────────────────────────────────────────────

  registerSource(input: Omit<SourceRecord, 'createdAt'> & { now?: string }): SourceRecord {
    const now = input.now ?? nowIso();
    const source = sourceSchema.parse({ ...input, createdAt: now });
    this.#database.prepare(`
      INSERT INTO sources (id, scenario_id, scope, kind, label, intent_enc, content_hash,
        media_path, retention, authorized_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.id, source.scenarioId, source.scope, source.kind, source.label,
      this.#codec.encrypt(source.intent), source.contentHash,
      source.mediaPath, source.retention, source.authorizedAt, source.createdAt,
    );
    return source;
  }

  addSourceSegments(segments: SourceSegment[]): void {
    this.#transaction(() => {
      const statement = this.#database.prepare(`
        INSERT INTO source_segments (id, source_id, content_enc, start_ms, end_ms, page,
          speaker, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const raw of segments) {
        const segment = sourceSegmentSchema.parse(raw);
        statement.run(
          segment.id, segment.sourceId, this.#codec.encrypt(segment.content), segment.startMs,
          segment.endMs, segment.page, segment.speaker, segment.confidence,
        );
      }
    });
  }

  getSourceSegment(id: string): SourceSegment | null {
    const row = this.#database.prepare('SELECT * FROM source_segments WHERE id = ?').get(id) as
      | Row
      | undefined;
    if (!row) return null;
    return sourceSegmentSchema.parse({
      id: row.id,
      sourceId: row.source_id,
      content: this.#codec.decrypt(String(row.content_enc)),
      startMs: row.start_ms,
      endMs: row.end_ms,
      page: row.page,
      speaker: row.speaker,
      confidence: row.confidence,
    });
  }

  // ─── Knowledge ───────────────────────────────────────────────────────────

  createKnowledgeCandidate(
    input: Omit<KnowledgeItem, 'status' | 'createdAt' | 'updatedAt'> & { now?: string },
  ): KnowledgeItem {
    const now = input.now ?? nowIso();
    const item = knowledgeItemSchema.parse({
      ...input,
      status: 'candidate',
      createdAt: now,
      updatedAt: now,
    });
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO knowledge_items (id, scope, scenario_id, kind, title, content_enc, status,
          source_segment_ids_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.id, item.scope, item.scenarioId, item.kind, item.title,
        this.#codec.encrypt(item.content), item.status,
        JSON.stringify(item.sourceSegmentIds), item.createdAt, item.updatedAt,
      );
      this.#indexSearchText('knowledge', item.id, item.title);
    });
    return item;
  }

  confirmKnowledgeItem(id: string, now = nowIso()): KnowledgeItem {
    return this.#transaction(() => {
      const current = this.getKnowledgeItem(id);
      if (!current) throw new Error('Knowledge item does not exist.');
      if (current.status !== 'candidate') {
        throw new Error('Only candidate knowledge can be confirmed.');
      }
      this.#database.prepare(
        'UPDATE knowledge_items SET status = ?, updated_at = ? WHERE id = ?',
      ).run('confirmed', now, id);
      this.#recordConsent({
        id: randomUUID(),
        action: 'formal-write',
        objectRef: `knowledge:${id}`,
        scope: current.scope,
        decision: 'granted',
        occurredAt: now,
      });
      return { ...current, status: 'confirmed' as const, updatedAt: now };
    });
  }

  deleteKnowledgeItem(id: string, now = nowIso()): void {
    this.#transaction(() => {
      const item = this.getKnowledgeItem(id);
      if (!item) throw new Error('Knowledge item does not exist.');
      this.#dropSearchText('knowledge', id);
      this.#database.prepare('DELETE FROM knowledge_items WHERE id = ?').run(id);
      this.#recordConsent({
        id: randomUUID(),
        action: 'deletion',
        objectRef: `knowledge:${id}`,
        scope: item.scope,
        decision: 'granted',
        occurredAt: now,
      });
    });
  }

  getKnowledgeItem(id: string): KnowledgeItem | null {
    const row = this.#database.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? this.#knowledgeFromRow(row) : null;
  }

  listKnowledge(filter: { scope?: DataScope; scenarioId?: string; status?: KnowledgeItem['status'] } = {}): KnowledgeItem[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter.scope) { clauses.push('scope = ?'); args.push(filter.scope); }
    if (filter.scenarioId) { clauses.push('scenario_id = ?'); args.push(filter.scenarioId); }
    if (filter.status) { clauses.push('status = ?'); args.push(filter.status); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.#database.prepare(
      `SELECT * FROM knowledge_items ${where} ORDER BY created_at DESC`,
    ).all(...(args as string[])) as Row[];
    return rows.map((row) => this.#knowledgeFromRow(row));
  }

  #knowledgeFromRow(row: Row): KnowledgeItem {
    return knowledgeItemSchema.parse({
      id: row.id,
      scope: row.scope,
      scenarioId: row.scenario_id,
      kind: row.kind,
      title: row.title,
      content: this.#codec.decrypt(String(row.content_enc)),
      status: row.status,
      sourceSegmentIds: parseStringArray(row.source_segment_ids_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  // ─── Profile assertions ──────────────────────────────────────────────────

  createProfileAssertion(
    input: Omit<ProfileAssertion, 'status' | 'createdAt' | 'updatedAt'> & { now?: string },
  ): ProfileAssertion {
    const now = input.now ?? nowIso();
    const assertion = profileAssertionSchema.parse({
      ...input,
      status: 'candidate',
      createdAt: now,
      updatedAt: now,
    });
    if (assertion.tier === 'confirmed-fact') {
      throw new Error('A new assertion cannot start as a confirmed fact; confirm it explicitly.');
    }
    this.#database.prepare(`
      INSERT INTO profile_assertions (id, tier, statement_enc, evidence_segment_ids_json,
        status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      assertion.id, assertion.tier, this.#codec.encrypt(assertion.statement),
      JSON.stringify(assertion.evidenceSegmentIds), assertion.status,
      assertion.createdAt, assertion.updatedAt,
    );
    return assertion;
  }

  resolveProfileAssertion(
    id: string,
    decision: 'confirmed' | 'rejected',
    now = nowIso(),
  ): ProfileAssertion {
    return this.#transaction(() => {
      const row = this.#database.prepare('SELECT * FROM profile_assertions WHERE id = ?').get(id) as
        | Row
        | undefined;
      if (!row) throw new Error('Profile assertion does not exist.');
      if (row.status !== 'candidate') throw new Error('Only candidate assertions can be resolved.');
      const tier = decision === 'confirmed' ? 'confirmed-fact' : String(row.tier);
      this.#database.prepare(
        'UPDATE profile_assertions SET status = ?, tier = ?, updated_at = ? WHERE id = ?',
      ).run(decision, tier, now, id);
      this.#recordConsent({
        id: randomUUID(),
        action: 'formal-write',
        objectRef: `profile:${id}`,
        scope: 'global',
        decision: decision === 'confirmed' ? 'granted' : 'denied',
        occurredAt: now,
      });
      return profileAssertionSchema.parse({
        id: row.id,
        tier,
        statement: this.#codec.decrypt(String(row.statement_enc)),
        evidenceSegmentIds: parseStringArray(row.evidence_segment_ids_json),
        status: decision,
        createdAt: row.created_at,
        updatedAt: now,
      });
    });
  }

  // ─── Questions, attempts, diagnostics ────────────────────────────────────

  createQuestion(
    input: Omit<z.input<typeof questionSchema>, 'createdAt'> & { now?: string },
  ): Question {
    const now = input.now ?? nowIso();
    const question = questionSchema.parse({ ...input, createdAt: now });
    this.#database.prepare(`
      INSERT INTO questions (id, scope, scenario_id, prompt_enc, origin, question_type,
        exploratory, parent_question_id, target_module_ids_json, pressure, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      question.id, question.scope, question.scenarioId, this.#codec.encrypt(question.prompt),
      question.origin, question.questionType, question.exploratory ? 1 : 0,
      question.parentQuestionId, JSON.stringify(question.targetModuleIds),
      question.pressure, question.createdAt,
    );
    return question;
  }

  getQuestion(id: string): Question | null {
    const row = this.#database.prepare('SELECT * FROM questions WHERE id = ?').get(id) as
      | Row
      | undefined;
    if (!row) return null;
    return questionSchema.parse({
      id: row.id,
      scope: row.scope,
      scenarioId: row.scenario_id,
      prompt: this.#codec.decrypt(String(row.prompt_enc)),
      origin: row.origin,
      questionType: row.question_type,
      exploratory: Boolean(row.exploratory),
      parentQuestionId: row.parent_question_id,
      targetModuleIds: parseStringArray(row.target_module_ids_json),
      pressure: row.pressure,
      createdAt: row.created_at,
    });
  }

  listRecentQuestionTypes(limit = 6): string[] {
    const rows = this.#database.prepare(`
      SELECT question_type FROM questions
      WHERE question_type IS NOT NULL ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Row[];
    return rows.map((row) => String(row.question_type));
  }

  createAttempt(
    input: Omit<z.input<typeof attemptSchema>, 'createdAt' | 'updatedAt'> & { now?: string },
  ): Attempt {
    const now = input.now ?? nowIso();
    const attempt = attemptSchema.parse({ ...input, createdAt: now, updatedAt: now });
    this.#database.prepare(`
      INSERT INTO attempts (id, question_id, round, state, outcome, response_enc,
        recording_source_id, opening_delay_ms, duration_ms, hint_level, gap,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.id, attempt.questionId, attempt.round, attempt.state, attempt.outcome,
      this.#codec.encrypt(attempt.responseText), attempt.recordingSourceId,
      attempt.openingDelayMs, attempt.durationMs, attempt.hintLevel, attempt.gap,
      attempt.createdAt, attempt.updatedAt,
    );
    return attempt;
  }

  updateAttempt(
    id: string,
    patch: Partial<Pick<Attempt,
      'state' | 'outcome' | 'responseText' | 'openingDelayMs' | 'durationMs' | 'hintLevel' | 'gap'
      | 'recordingSourceId'>>,
    now = nowIso(),
  ): Attempt {
    return this.#transaction(() => {
      const current = this.getAttempt(id);
      if (!current) throw new Error('Attempt does not exist.');
      const next = attemptSchema.parse({ ...current, ...patch, updatedAt: now });
      this.#database.prepare(`
        UPDATE attempts SET state = ?, outcome = ?, response_enc = ?, opening_delay_ms = ?,
          duration_ms = ?, hint_level = ?, gap = ?, recording_source_id = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.state, next.outcome, this.#codec.encrypt(next.responseText), next.openingDelayMs,
        next.durationMs, next.hintLevel, next.gap, next.recordingSourceId, next.updatedAt, id,
      );
      return next;
    });
  }

  sourceExists(id: string): boolean {
    return Boolean(this.#database.prepare('SELECT id FROM sources WHERE id = ?').get(id));
  }

  // What a stored recording was for: the question of the attempt it belongs to.
  recordingContext(sourceId: string): string | null {
    const row = this.#database.prepare(
      'SELECT question_id FROM attempts WHERE recording_source_id = ? LIMIT 1',
    ).get(sourceId) as Row | undefined;
    if (!row) return null;
    const question = this.getQuestion(String(row.question_id));
    return question ? question.prompt : null;
  }

  // Recording files are user-deletable; when one goes, its source row and the
  // attempt references must not dangle.
  deleteRecordingSource(sourceId: string): void {
    this.#transaction(() => {
      this.#database.prepare(
        'UPDATE attempts SET recording_source_id = NULL WHERE recording_source_id = ?',
      ).run(sourceId);
      this.#database.prepare('DELETE FROM source_segments WHERE source_id = ?').run(sourceId);
      this.#database.prepare('DELETE FROM sources WHERE id = ?').run(sourceId);
    });
  }

  getAttempt(id: string): Attempt | null {
    const row = this.#database.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as
      | Row
      | undefined;
    if (!row) return null;
    return attemptSchema.parse({
      id: row.id,
      questionId: row.question_id,
      round: row.round,
      state: row.state,
      outcome: row.outcome,
      responseText: this.#codec.decrypt(String(row.response_enc)),
      recordingSourceId: row.recording_source_id,
      openingDelayMs: row.opening_delay_ms,
      durationMs: row.duration_ms,
      hintLevel: row.hint_level,
      gap: row.gap,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  addDiagnostic(input: Omit<Diagnostic, 'createdAt'> & { now?: string }): Diagnostic {
    const now = input.now ?? nowIso();
    const diagnostic = diagnosticSchema.parse({ ...input, createdAt: now });
    this.#database.prepare(`
      INSERT INTO diagnostics (id, attempt_id, dimension, finding_enc, evidence_quote_enc,
        created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      diagnostic.id, diagnostic.attemptId, diagnostic.dimension,
      this.#codec.encrypt(diagnostic.finding), this.#codec.encrypt(diagnostic.evidenceQuote),
      diagnostic.createdAt,
    );
    return diagnostic;
  }

  listDiagnostics(attemptId: string): Diagnostic[] {
    const rows = this.#database.prepare(
      'SELECT * FROM diagnostics WHERE attempt_id = ? ORDER BY created_at',
    ).all(attemptId) as Row[];
    return rows.map((row) => diagnosticSchema.parse({
      id: row.id,
      attemptId: row.attempt_id,
      dimension: row.dimension,
      finding: this.#codec.decrypt(String(row.finding_enc)),
      evidenceQuote: this.#codec.decrypt(String(row.evidence_quote_enc)),
      createdAt: row.created_at,
    }));
  }

  // ─── Language LEGO modules ───────────────────────────────────────────────

  createLegoCandidate(
    input: Omit<LegoModule, 'status' | 'currentVersion' | 'createdAt' | 'updatedAt' | 'domain'>
      & { payload: LegoVersion['payload']; authorship: LegoVersion['authorship'];
        domain?: LegoModule['domain']; evidenceSegmentIds?: string[]; attemptIds?: string[];
        now?: string },
  ): { module: LegoModule; version: LegoVersion } {
    const now = input.now ?? nowIso();
    if (input.scope !== 'global' && input.domain) {
      throw new Error('Only global modules carry a generic/professional domain.');
    }
    const module = legoModuleSchema.parse({
      id: input.id,
      scope: input.scope,
      scenarioId: input.scenarioId,
      category: input.category,
      title: input.title,
      status: 'candidate',
      domain: input.domain ?? null,
      triggers: input.triggers,
      currentVersion: null,
      createdAt: now,
      updatedAt: now,
    });
    const version = legoVersionSchema.parse({
      moduleId: module.id,
      version: 1,
      payload: input.payload,
      authorship: input.authorship,
      evidenceSegmentIds: input.evidenceSegmentIds ?? [],
      attemptIds: input.attemptIds ?? [],
      createdAt: now,
    });
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO lego_modules (id, scope, scenario_id, category, title, status, domain,
          triggers_json, current_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        module.id, module.scope, module.scenarioId, module.category, module.title, module.status,
        module.domain, JSON.stringify(module.triggers), module.currentVersion,
        module.createdAt, module.updatedAt,
      );
      this.#insertVersion(version);
      this.#indexSearchText('lego-module', module.id, `${module.title} ${module.triggers.join(' ')}`);
    });
    return { module, version };
  }

  addLegoVersion(
    moduleId: string,
    payload: LegoVersion['payload'],
    authorship: LegoVersion['authorship'],
    options: { evidenceSegmentIds?: string[]; attemptIds?: string[]; now?: string } = {},
  ): LegoVersion {
    const now = options.now ?? nowIso();
    return this.#transaction(() => {
      const module = this.getLegoModule(moduleId);
      if (!module) throw new Error('Module does not exist.');
      const latest = this.#database.prepare(
        'SELECT MAX(version) AS version FROM lego_versions WHERE module_id = ?',
      ).get(moduleId) as Row;
      const version = legoVersionSchema.parse({
        moduleId,
        version: Number(latest.version ?? 0) + 1,
        payload,
        authorship,
        evidenceSegmentIds: options.evidenceSegmentIds ?? [],
        attemptIds: options.attemptIds ?? [],
        createdAt: now,
      });
      this.#insertVersion(version);
      this.#database.prepare('UPDATE lego_modules SET updated_at = ? WHERE id = ?').run(now, moduleId);
      return version;
    });
  }

  #insertVersion(version: LegoVersion): void {
    this.#database.prepare(`
      INSERT INTO lego_versions (module_id, version, payload_enc, authorship,
        evidence_segment_ids_json, attempt_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      version.moduleId, version.version, this.#codec.encrypt(JSON.stringify(version.payload)),
      version.authorship, JSON.stringify(version.evidenceSegmentIds),
      JSON.stringify(version.attemptIds), version.createdAt,
    );
  }

  confirmLegoVersion(moduleId: string, version: number, now = nowIso()): LegoModule {
    return this.#transaction(() => {
      const module = this.getLegoModule(moduleId);
      if (!module) throw new Error('Module does not exist.');
      const stored = this.getLegoVersion(moduleId, version);
      if (!stored) throw new Error('Module version does not exist.');
      this.#database.prepare(
        'UPDATE lego_modules SET status = ?, current_version = ?, updated_at = ? WHERE id = ?',
      ).run('confirmed', version, now, moduleId);
      this.#recordConsent({
        id: randomUUID(),
        action: 'formal-write',
        objectRef: `lego:${moduleId}@${version}`,
        scope: module.scope,
        decision: 'granted',
        occurredAt: now,
      });
      const masteryRow = this.#database.prepare(
        'SELECT module_id FROM mastery_states WHERE module_id = ?',
      ).get(moduleId) as Row | undefined;
      if (!masteryRow) {
        this.#database.prepare(`
          INSERT INTO mastery_states (module_id, stage, due_at, last_practiced_at,
            last_hint_level, pressure_notes, updated_at)
          VALUES (?, 'confirmed', NULL, NULL, 'none', '', ?)
        `).run(moduleId, now);
      }
      return { ...module, status: 'confirmed' as const, currentVersion: version, updatedAt: now };
    });
  }

  archiveLegoModule(moduleId: string, now = nowIso()): void {
    this.#database.prepare(
      'UPDATE lego_modules SET status = ?, updated_at = ? WHERE id = ?',
    ).run('archived', now, moduleId);
  }

  // Hard deletion of a whole module (layered-deletion family). Versions,
  // links, and mastery state cascade; practice events keep their rows with a
  // nulled module reference, and a deletion consent event is recorded.
  deleteLegoModule(moduleId: string, now = nowIso()): void {
    this.#transaction(() => {
      const module = this.getLegoModule(moduleId);
      if (!module) throw new Error('Module does not exist.');
      this.#dropSearchText('lego-module', moduleId);
      this.#database.prepare('DELETE FROM lego_modules WHERE id = ?').run(moduleId);
      this.#recordConsent({
        id: randomUUID(),
        action: 'deletion',
        objectRef: `lego:${moduleId}`,
        scope: module.scope,
        decision: 'granted',
        occurredAt: now,
      });
    });
  }

  renameLegoModule(moduleId: string, title: string, now = nowIso()): void {
    this.#transaction(() => {
      const module = this.getLegoModule(moduleId);
      if (!module) throw new Error('Module does not exist.');
      this.#database.prepare(
        'UPDATE lego_modules SET title = ?, updated_at = ? WHERE id = ?',
      ).run(title, now, moduleId);
      this.#indexSearchText('lego-module', moduleId, `${title} ${module.triggers.join(' ')}`);
    });
  }

  restoreLegoModule(moduleId: string, now = nowIso()): void {
    const module = this.getLegoModule(moduleId);
    if (!module) throw new Error('Module does not exist.');
    if (module.status !== 'archived') throw new Error('Only archived modules can be restored.');
    this.#database.prepare(
      'UPDATE lego_modules SET status = ?, updated_at = ? WHERE id = ?',
    ).run('confirmed', now, moduleId);
  }

  getLegoModule(id: string): LegoModule | null {
    const row = this.#database.prepare('SELECT * FROM lego_modules WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? this.#moduleFromRow(row) : null;
  }

  listLegoModules(
    filter: { scope?: DataScope; scenarioId?: string; status?: LegoModule['status'] } = {},
  ): LegoModule[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter.scope) { clauses.push('scope = ?'); args.push(filter.scope); }
    if (filter.scenarioId) { clauses.push('scenario_id = ?'); args.push(filter.scenarioId); }
    if (filter.status) { clauses.push('status = ?'); args.push(filter.status); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.#database.prepare(
      `SELECT * FROM lego_modules ${where} ORDER BY updated_at DESC`,
    ).all(...(args as string[])) as Row[];
    return rows.map((row) => this.#moduleFromRow(row));
  }

  #moduleFromRow(row: Row): LegoModule {
    return legoModuleSchema.parse({
      id: row.id,
      scope: row.scope,
      scenarioId: row.scenario_id,
      category: row.category,
      title: row.title,
      status: row.status,
      domain: row.domain,
      triggers: parseStringArray(row.triggers_json),
      currentVersion: row.current_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  // Scenario modules stay scenario-scoped until the user explicitly promotes
  // them (PRD: promotion requires proof of reuse or confirmation).
  promoteModuleToGlobal(
    moduleId: string,
    domain: NonNullable<LegoModule['domain']>,
    now = nowIso(),
  ): LegoModule {
    return this.#transaction(() => {
      const module = this.getLegoModule(moduleId);
      if (!module) throw new Error('Module does not exist.');
      if (module.scope !== 'scenario') {
        throw new Error('Only scenario modules can be promoted.');
      }
      this.#database.prepare(
        "UPDATE lego_modules SET scope = 'global', scenario_id = NULL, domain = ?, updated_at = ? WHERE id = ?",
      ).run(domain, now, moduleId);
      this.#recordConsent({
        id: randomUUID(),
        action: 'scope-promotion',
        objectRef: `lego:${moduleId}`,
        scope: 'global',
        decision: 'granted',
        occurredAt: now,
      });
      return { ...module, scope: 'global' as const, scenarioId: null, domain, updatedAt: now };
    });
  }

  getLegoVersion(moduleId: string, version: number): LegoVersion | null {
    const row = this.#database.prepare(
      'SELECT * FROM lego_versions WHERE module_id = ? AND version = ?',
    ).get(moduleId, version) as Row | undefined;
    return row ? this.#versionFromRow(row) : null;
  }

  listLegoVersions(moduleId: string): LegoVersion[] {
    const rows = this.#database.prepare(
      'SELECT * FROM lego_versions WHERE module_id = ? ORDER BY version DESC',
    ).all(moduleId) as Row[];
    return rows.map((row) => this.#versionFromRow(row));
  }

  #versionFromRow(row: Row): LegoVersion {
    return legoVersionSchema.parse({
      moduleId: row.module_id,
      version: row.version,
      payload: legoVersionPayloadSchema.parse(
        JSON.parse(this.#codec.decrypt(String(row.payload_enc))),
      ),
      authorship: row.authorship,
      evidenceSegmentIds: parseStringArray(row.evidence_segment_ids_json),
      attemptIds: parseStringArray(row.attempt_ids_json),
      createdAt: row.created_at,
    });
  }

  // Version-level deletion (PRD layered deletion): a single version may hold
  // phrasing the user wants gone without losing the module or its history.
  deleteLegoVersion(moduleId: string, version: number, now = nowIso()): LegoModule {
    return this.#transaction(() => {
      const module = this.getLegoModule(moduleId);
      if (!module) throw new Error('Module does not exist.');
      const stored = this.getLegoVersion(moduleId, version);
      if (!stored) throw new Error('Module version does not exist.');
      const countRow = this.#database.prepare(
        'SELECT COUNT(*) AS count FROM lego_versions WHERE module_id = ?',
      ).get(moduleId) as Row;
      if (Number(countRow.count) <= 1) {
        throw new Error('模块只剩这一个版本，不能再删。要移除全部内容请归档整个模块。');
      }
      this.#database.prepare(
        'DELETE FROM lego_versions WHERE module_id = ? AND version = ?',
      ).run(moduleId, version);
      let currentVersion = module.currentVersion;
      if (module.currentVersion === version) {
        const latest = this.#database.prepare(
          'SELECT MAX(version) AS version FROM lego_versions WHERE module_id = ?',
        ).get(moduleId) as Row;
        currentVersion = Number(latest.version);
      }
      this.#database.prepare(
        'UPDATE lego_modules SET current_version = ?, updated_at = ? WHERE id = ?',
      ).run(currentVersion, now, moduleId);
      this.#recordConsent({
        id: randomUUID(),
        action: 'deletion',
        objectRef: `lego:${moduleId}@${version}`,
        scope: module.scope,
        decision: 'granted',
        occurredAt: now,
      });
      return { ...module, currentVersion, updatedAt: now };
    });
  }

  linkModules(input: Omit<ModuleLink, 'createdAt'> & { now?: string }): ModuleLink {
    const now = input.now ?? nowIso();
    const link = moduleLinkSchema.parse({ ...input, createdAt: now });
    if (link.fromModuleId === link.toModuleId) {
      throw new Error('模块不能与自己建立关系。');
    }
    if (!this.getLegoModule(link.toModuleId)) throw new Error('Target module does not exist.');
    this.#database.prepare(`
      INSERT OR IGNORE INTO module_links (id, from_module_id, to_module_id, relation, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(link.id, link.fromModuleId, link.toModuleId, link.relation, link.createdAt);
    return link;
  }

  listModuleLinks(moduleId: string): Array<{
    id: string; otherModuleId: string; otherTitle: string;
    relation: ModuleLink['relation']; direction: 'out' | 'in';
  }> {
    const rows = this.#database.prepare(`
      SELECT ml.id, ml.relation, ml.from_module_id, ml.to_module_id, lm.title AS other_title
      FROM module_links ml
      JOIN lego_modules lm
        ON lm.id = CASE WHEN ml.from_module_id = ? THEN ml.to_module_id ELSE ml.from_module_id END
      WHERE ml.from_module_id = ? OR ml.to_module_id = ?
      ORDER BY ml.created_at
    `).all(moduleId, moduleId, moduleId) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      otherModuleId: String(row.from_module_id) === moduleId
        ? String(row.to_module_id)
        : String(row.from_module_id),
      otherTitle: String(row.other_title),
      relation: row.relation as ModuleLink['relation'],
      direction: String(row.from_module_id) === moduleId ? 'out' : 'in',
    }));
  }

  // Merge two similar modules: the kept module gains a new confirmed version
  // absorbing the other's language shells and triggers; the absorbed module is
  // archived (recoverable) and the similar link between them removed.
  mergeSimilarModules(keepId: string, absorbId: string, now = nowIso()): LegoModule {
    return this.#transaction(() => {
      const keep = this.getLegoModule(keepId);
      const absorb = this.getLegoModule(absorbId);
      if (!keep || !absorb) throw new Error('Module does not exist.');
      if (keepId === absorbId) throw new Error('不能与自己合并。');
      const keepVersion = keep.currentVersion ? this.getLegoVersion(keepId, keep.currentVersion) : null;
      const absorbVersion = absorb.currentVersion
        ? this.getLegoVersion(absorbId, absorb.currentVersion)
        : null;
      if (!keepVersion || !absorbVersion) throw new Error('两个模块都需要已确认的当前版本。');

      const mergedShells = [...keepVersion.payload.languageShells];
      for (const shell of absorbVersion.payload.languageShells) {
        if (!mergedShells.includes(shell)) mergedShells.push(shell);
      }
      const mergedTriggers = [...keep.triggers];
      for (const trigger of absorb.triggers) {
        if (!mergedTriggers.includes(trigger)) mergedTriggers.push(trigger);
      }

      const version = this.addLegoVersion(keepId, {
        ...keepVersion.payload,
        languageShells: mergedShells.slice(0, 10),
      }, 'user-native', { now });
      this.#database.prepare(
        'UPDATE lego_modules SET triggers_json = ?, updated_at = ? WHERE id = ?',
      ).run(JSON.stringify(mergedTriggers.slice(0, 20)), now, keepId);
      this.#indexSearchText('lego-module', keepId, `${keep.title} ${mergedTriggers.join(' ')}`);
      const merged = this.confirmLegoVersion(keepId, version.version, now);
      this.archiveLegoModule(absorbId, now);
      this.#database.prepare(`
        DELETE FROM module_links WHERE relation = 'similar-to'
          AND ((from_module_id = ? AND to_module_id = ?) OR (from_module_id = ? AND to_module_id = ?))
      `).run(keepId, absorbId, absorbId, keepId);
      return merged;
    });
  }

  unlinkModules(linkId: string): void {
    const result = this.#database.prepare('DELETE FROM module_links WHERE id = ?').run(linkId);
    if (Number(result.changes) === 0) throw new Error('Module link does not exist.');
  }

  // ─── Mastery and practice ────────────────────────────────────────────────

  getMasteryState(moduleId: string): MasteryState | null {
    const row = this.#database.prepare('SELECT * FROM mastery_states WHERE module_id = ?')
      .get(moduleId) as Row | undefined;
    if (!row) return null;
    return masteryStateSchema.parse({
      moduleId: row.module_id,
      stage: row.stage,
      dueAt: row.due_at,
      lastPracticedAt: row.last_practiced_at,
      lastHintLevel: row.last_hint_level,
      pressureNotes: row.pressure_notes,
      updatedAt: row.updated_at,
    });
  }

  updateMasteryState(
    moduleId: string,
    patch: Partial<Omit<MasteryState, 'moduleId' | 'updatedAt'>>,
    now = nowIso(),
  ): MasteryState {
    return this.#transaction(() => {
      const current = this.getMasteryState(moduleId);
      if (!current) throw new Error('Mastery state does not exist; confirm the module first.');
      const next = masteryStateSchema.parse({ ...current, ...patch, updatedAt: now });
      this.#database.prepare(`
        UPDATE mastery_states SET stage = ?, due_at = ?, last_practiced_at = ?,
          last_hint_level = ?, pressure_notes = ?, updated_at = ?
        WHERE module_id = ?
      `).run(
        next.stage, next.dueAt, next.lastPracticedAt, next.lastHintLevel,
        next.pressureNotes, next.updatedAt, moduleId,
      );
      return next;
    });
  }

  listDueModules(asOf: string): Array<{ module: LegoModule; mastery: MasteryState }> {
    const rows = this.#database.prepare(`
      SELECT module_id FROM mastery_states
      WHERE due_at IS NOT NULL AND due_at <= ?
      ORDER BY due_at
    `).all(asOf) as Row[];
    const results: Array<{ module: LegoModule; mastery: MasteryState }> = [];
    for (const row of rows) {
      const module = this.getLegoModule(String(row.module_id));
      const mastery = this.getMasteryState(String(row.module_id));
      if (module && mastery && module.status === 'confirmed') results.push({ module, mastery });
    }
    return results;
  }

  recordPracticeEvent(input: Omit<PracticeEvent, 'occurredAt'> & { now?: string }): PracticeEvent {
    const now = input.now ?? nowIso();
    const event = practiceEventSchema.parse({ ...input, occurredAt: now });
    this.#database.prepare(`
      INSERT INTO practice_events (id, module_id, attempt_id, kind, result, detail, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.moduleId, event.attemptId, event.kind, event.result, event.detail,
      event.occurredAt,
    );
    return event;
  }

  listPracticeEvents(moduleId: string): PracticeEvent[] {
    const rows = this.#database.prepare(
      'SELECT * FROM practice_events WHERE module_id = ? ORDER BY occurred_at',
    ).all(moduleId) as Row[];
    return rows.map((row) => practiceEventSchema.parse({
      id: row.id,
      moduleId: row.module_id,
      attemptId: row.attempt_id,
      kind: row.kind,
      result: row.result,
      detail: row.detail,
      occurredAt: row.occurred_at,
    }));
  }

  // ─── Growing professional profile seed ──────────────────────────────────

  saveProfileSeed(input: Omit<ProfileSeed, 'updatedAt'> & { now?: string }): ProfileSeed {
    const now = input.now ?? nowIso();
    const seed = profileSeedSchema.parse({ ...input, updatedAt: now });
    this.#database.prepare(`
      INSERT INTO profile_seed (id, direction_enc, current_work_enc, target_scenarios_enc,
        material_enc, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET direction_enc = excluded.direction_enc,
        current_work_enc = excluded.current_work_enc,
        target_scenarios_enc = excluded.target_scenarios_enc,
        material_enc = excluded.material_enc, updated_at = excluded.updated_at
    `).run(
      this.#codec.encrypt(seed.direction), this.#codec.encrypt(seed.currentWork),
      this.#codec.encrypt(seed.targetScenarios), this.#codec.encrypt(seed.material),
      seed.updatedAt,
    );
    return seed;
  }

  getProfileSeed(): ProfileSeed | null {
    const row = this.#database.prepare('SELECT * FROM profile_seed WHERE id = 1').get() as
      | Row
      | undefined;
    if (!row) return null;
    return profileSeedSchema.parse({
      direction: this.#codec.decrypt(String(row.direction_enc)),
      currentWork: this.#codec.decrypt(String(row.current_work_enc)),
      targetScenarios: this.#codec.decrypt(String(row.target_scenarios_enc)),
      material: this.#codec.decrypt(String(row.material_enc)),
      updatedAt: row.updated_at,
    });
  }

  listProfileAssertions(status?: ProfileAssertion['status']): ProfileAssertion[] {
    const rows = (status
      ? this.#database.prepare(
        'SELECT * FROM profile_assertions WHERE status = ? ORDER BY updated_at DESC',
      ).all(status)
      : this.#database.prepare('SELECT * FROM profile_assertions ORDER BY updated_at DESC')
        .all()) as Row[];
    return rows.map((row) => profileAssertionSchema.parse({
      id: row.id,
      tier: row.tier,
      statement: this.#codec.decrypt(String(row.statement_enc)),
      evidenceSegmentIds: parseStringArray(row.evidence_segment_ids_json),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  // ─── Sessions, consent, audit ────────────────────────────────────────────

  upsertAgentSession(input: Omit<AgentSessionRecord, 'createdAt' | 'updatedAt'> & { now?: string }): AgentSessionRecord {
    const now = input.now ?? nowIso();
    const existing = this.#database.prepare('SELECT created_at FROM agent_sessions WHERE id = ?')
      .get(input.id) as Row | undefined;
    const record = agentSessionSchema.parse({
      ...input,
      createdAt: existing ? String(existing.created_at) : now,
      updatedAt: now,
    });
    this.#database.prepare(`
      INSERT INTO agent_sessions (id, sdk_session_id, provider_profile_id, purpose, status,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sdk_session_id = excluded.sdk_session_id,
        provider_profile_id = excluded.provider_profile_id, purpose = excluded.purpose,
        status = excluded.status, updated_at = excluded.updated_at
    `).run(
      record.id, record.sdkSessionId, record.providerProfileId, record.purpose, record.status,
      record.createdAt, record.updatedAt,
    );
    return record;
  }

  #recordConsent(event: ConsentEvent): void {
    consentEventSchema.parse(event);
    this.#database.prepare(`
      INSERT INTO consent_events (id, action, object_ref, scope, decision, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.id, event.action, event.objectRef, event.scope, event.decision, event.occurredAt);
  }

  recordConsentEvent(input: Omit<ConsentEvent, 'occurredAt'> & { now?: string }): ConsentEvent {
    const now = input.now ?? nowIso();
    const event = consentEventSchema.parse({ ...input, occurredAt: now });
    this.#recordConsent(event);
    return event;
  }

  listConsentEvents(objectRef?: string): ConsentEvent[] {
    const rows = (objectRef
      ? this.#database.prepare(
        'SELECT * FROM consent_events WHERE object_ref = ? ORDER BY occurred_at',
      ).all(objectRef)
      : this.#database.prepare('SELECT * FROM consent_events ORDER BY occurred_at').all()) as Row[];
    return rows.map((row) => consentEventSchema.parse({
      id: row.id,
      action: row.action,
      objectRef: row.object_ref,
      scope: row.scope,
      decision: row.decision,
      occurredAt: row.occurred_at,
    }));
  }

  recordAuditEvent(input: Omit<AuditEvent, 'occurredAt'> & { now?: string }): AuditEvent {
    const now = input.now ?? nowIso();
    const event = auditEventSchema.parse({ ...input, occurredAt: now });
    this.#database.prepare(`
      INSERT INTO audit_events (id, category, code, detail, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.id, event.category, event.code, event.detail, event.occurredAt);
    return event;
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  search(query: string, limit = 20): SearchHit[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    let rows: Row[];
    if (trimmed.length >= 3) {
      rows = this.#database.prepare(`
        SELECT entity_type, entity_id, text FROM search_index
        WHERE search_index MATCH ? ORDER BY rank LIMIT ?
      `).all(`"${trimmed.replaceAll('"', '""')}"`, limit) as Row[];
    } else {
      rows = this.#database.prepare(`
        SELECT entity_type, entity_id, text FROM search_index
        WHERE text LIKE ? LIMIT ?
      `).all(`%${trimmed}%`, limit) as Row[];
    }
    return rows.map((row) => ({
      entityType: row.entity_type as SearchHit['entityType'],
      entityId: String(row.entity_id),
      text: String(row.text),
    }));
  }

  searchDeep(
    query: string,
    filter: { scope?: DataScope; scenarioId?: string } = {},
    limit = 20,
  ): DeepSearchHit[] {
    const needle = query.trim();
    if (needle.length === 0) return [];
    const hits: DeepSearchHit[] = [];
    for (const item of this.listKnowledge(filter)) {
      if (hits.length >= limit) break;
      if (item.content.includes(needle) || item.title.includes(needle)) {
        hits.push({ entityType: 'knowledge', entityId: item.id, excerpt: excerptAround(item.content, needle) });
      }
    }
    for (const module of this.listLegoModules(filter)) {
      if (hits.length >= limit) break;
      const version = module.currentVersion
        ? this.getLegoVersion(module.id, module.currentVersion)
        : this.getLegoVersion(module.id, 1);
      if (!version) continue;
      const haystack = [
        version.payload.semanticKernel,
        version.payload.logicSkeleton.join(' '),
        version.payload.languageShells.join(' '),
      ].join(' ');
      if (haystack.includes(needle)) {
        hits.push({ entityType: 'lego-version', entityId: module.id, excerpt: excerptAround(haystack, needle) });
      }
    }
    return hits;
  }

  // ─── Scenario deletion ───────────────────────────────────────────────────

  previewScenarioDeletion(scenarioId: string): ScenarioDeletionPreview {
    const count = (sql: string): number => {
      const row = this.#database.prepare(sql).get(scenarioId) as Row;
      return Number(row.n ?? 0);
    };
    const preview = {
      scenarioId,
      sources: count('SELECT COUNT(*) AS n FROM sources WHERE scenario_id = ?'),
      segments: count(`SELECT COUNT(*) AS n FROM source_segments
        WHERE source_id IN (SELECT id FROM sources WHERE scenario_id = ?)`),
      questions: count('SELECT COUNT(*) AS n FROM questions WHERE scenario_id = ?'),
      attempts: count(`SELECT COUNT(*) AS n FROM attempts
        WHERE question_id IN (SELECT id FROM questions WHERE scenario_id = ?)`),
      diagnostics: count(`SELECT COUNT(*) AS n FROM diagnostics WHERE attempt_id IN (
        SELECT id FROM attempts WHERE question_id IN (
          SELECT id FROM questions WHERE scenario_id = ?))`),
      knowledgeItems: count('SELECT COUNT(*) AS n FROM knowledge_items WHERE scenario_id = ?'),
      scopedModules: count(
        "SELECT COUNT(*) AS n FROM lego_modules WHERE scenario_id = ? AND scope = 'scenario'",
      ),
      globalModuleReferences: count(`SELECT COUNT(DISTINCT lv.module_id) AS n FROM lego_versions lv
        JOIN lego_modules lm ON lm.id = lv.module_id AND lm.scope = 'global'
        WHERE EXISTS (
          SELECT 1 FROM json_each(lv.evidence_segment_ids_json) je
          JOIN source_segments ss ON ss.id = je.value
          JOIN sources s ON s.id = ss.source_id
          WHERE s.scenario_id = ?)`),
    };
    return scenarioDeletionPreviewSchema.parse(preview);
  }

  deleteScenario(scenarioId: string, now = nowIso()): ScenarioDeletionPreview {
    return this.#transaction(() => {
      const preview = this.previewScenarioDeletion(scenarioId);
      const scenario = this.getScenario(scenarioId);
      if (!scenario) throw new Error('Scenario does not exist.');
      const scopedModuleRows = this.#database.prepare(
        "SELECT id FROM lego_modules WHERE scenario_id = ? AND scope = 'scenario'",
      ).all(scenarioId) as Row[];
      for (const row of scopedModuleRows) {
        this.#dropSearchText('lego-module', String(row.id));
        this.#database.prepare('DELETE FROM lego_modules WHERE id = ?').run(String(row.id));
      }
      this.#database.prepare(
        "UPDATE lego_modules SET scenario_id = NULL WHERE scenario_id = ? AND scope != 'scenario'",
      ).run(scenarioId);
      const knowledgeRows = this.#database.prepare(
        'SELECT id FROM knowledge_items WHERE scenario_id = ?',
      ).all(scenarioId) as Row[];
      for (const row of knowledgeRows) {
        this.#dropSearchText('knowledge', String(row.id));
        this.#database.prepare('DELETE FROM knowledge_items WHERE id = ?').run(String(row.id));
      }
      this.#database.prepare(`DELETE FROM diagnostics WHERE attempt_id IN (
        SELECT id FROM attempts WHERE question_id IN (
          SELECT id FROM questions WHERE scenario_id = ?))`).run(scenarioId);
      this.#database.prepare(`DELETE FROM attempts WHERE question_id IN (
        SELECT id FROM questions WHERE scenario_id = ?)`).run(scenarioId);
      this.#database.prepare('DELETE FROM questions WHERE scenario_id = ?').run(scenarioId);
      this.#database.prepare(`DELETE FROM source_segments WHERE source_id IN (
        SELECT id FROM sources WHERE scenario_id = ?)`).run(scenarioId);
      this.#database.prepare('DELETE FROM sources WHERE scenario_id = ?').run(scenarioId);
      this.#dropSearchText('scenario', scenarioId);
      this.#database.prepare('DELETE FROM scenarios WHERE id = ?').run(scenarioId);
      this.#recordConsent({
        id: randomUUID(),
        action: 'deletion',
        objectRef: `scenario:${scenarioId}`,
        scope: 'scenario',
        decision: 'granted',
        occurredAt: now,
      });
      return preview;
    });
  }

  rebuildSearchIndex(): void {
    this.#transaction(() => {
      this.#database.exec('DELETE FROM search_index');
      const scenarios = this.#database.prepare('SELECT id, title, objective FROM scenarios')
        .all() as Row[];
      for (const row of scenarios) {
        this.#indexSearchText('scenario', String(row.id), `${String(row.title)} ${String(row.objective)}`);
      }
      const knowledge = this.#database.prepare('SELECT id, title FROM knowledge_items')
        .all() as Row[];
      for (const row of knowledge) {
        this.#indexSearchText('knowledge', String(row.id), String(row.title));
      }
      const modules = this.#database.prepare('SELECT id, title, triggers_json FROM lego_modules')
        .all() as Row[];
      for (const row of modules) {
        this.#indexSearchText(
          'lego-module',
          String(row.id),
          `${String(row.title)} ${parseStringArray(row.triggers_json).join(' ')}`,
        );
      }
    });
  }

  // ─── Raw table access for export (data layer internal) ───────────────────

  dumpTable(table: string): Row[] {
    if (!/^[a-z_]+$/u.test(table)) throw new Error('Invalid table name.');
    return this.#database.prepare(`SELECT * FROM ${table}`).all() as Row[];
  }

  restoreRow(table: string, row: Row): void {
    if (!/^[a-z_]+$/u.test(table)) throw new Error('Invalid table name.');
    const keys = Object.keys(row);
    const placeholders = keys.map(() => '?').join(', ');
    this.#database.prepare(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
    ).run(...(keys.map((key) => row[key]) as string[]));
  }

  decryptField(value: string): string {
    return this.#codec.decrypt(value);
  }

  encryptField(value: string): string {
    return this.#codec.encrypt(value);
  }
}

function excerptAround(text: string, needle: string, radius = 40): string {
  const index = text.indexOf(needle);
  if (index < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needle.length + radius);
  return text.slice(start, end);
}
