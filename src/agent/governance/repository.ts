import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import type { AttemptState, CandidateKind, DataScope } from './schemas';
import { createOpaqueToken, hashOpaqueToken, tokenHashMatches } from './tokens';

type JsonRecord = Record<string, unknown>;

interface ContextRow {
  ref: string;
  scope: DataScope;
  kind: string;
  content: string;
  disclosure: 'general' | 'answer' | 'evidence_hint';
  provenance: JsonRecord;
}

interface CandidateRow {
  id: string;
  session_id: string;
  kind: CandidateKind;
  payload: JsonRecord;
  provenance: JsonRecord;
  scope: DataScope;
  status: 'candidate' | 'committed';
  version: number;
}

const databaseRowSchema = z.record(z.string(), z.unknown());

function parseJsonRecord(value: unknown): JsonRecord {
  return databaseRowSchema.parse(JSON.parse(String(value)));
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

export class GovernanceRepository {
  readonly #database: DatabaseSync;

  constructor(databasePath = ':memory:') {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS context_items (
        ref TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        disclosure TEXT NOT NULL,
        provenance_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        question_ref TEXT NOT NULL,
        state TEXT NOT NULL,
        response TEXT NOT NULL DEFAULT '',
        outcome TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS commit_previews (
        preview_id TEXT PRIMARY KEY,
        candidate_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS confirmation_tokens (
        token_hash TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        preview_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS formal_assets (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        scope TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS practice_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        attempt_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS media_transcripts (
        transcript_id TEXT PRIMARY KEY,
        segments_json TEXT NOT NULL,
        timing_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS delete_previews (
        preview_id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  close(): void {
    this.#database.close();
  }

  seedContext(item: ContextRow): void {
    this.#database.prepare(`
      INSERT INTO context_items(ref, scope, kind, content, disclosure, provenance_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ref) DO UPDATE SET
        scope = excluded.scope,
        kind = excluded.kind,
        content = excluded.content,
        disclosure = excluded.disclosure,
        provenance_json = excluded.provenance_json
    `).run(
      item.ref,
      item.scope,
      item.kind,
      item.content,
      item.disclosure,
      JSON.stringify(item.provenance),
    );
  }

  createQuestion(options: {
    attemptId: string;
    sessionId: string;
    questionRef: string;
  }): AttemptState {
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO attempts(attempt_id, session_id, question_ref, state, created_at, updated_at)
      VALUES (?, ?, ?, 'QUESTION_CREATED', ?, ?)
    `).run(options.attemptId, options.sessionId, options.questionRef, now, now);
    return 'QUESTION_CREATED';
  }

  getAttemptState(attemptId: string): AttemptState {
    const row = this.#database.prepare(
      'SELECT state FROM attempts WHERE attempt_id = ?',
    ).get(attemptId) as { state?: unknown } | undefined;
    if (!row) throw new Error('Attempt does not exist.');
    return z.enum([
      'QUESTION_CREATED',
      'FIRST_ATTEMPT_RECORDING',
      'FIRST_ATTEMPT_CLOSED',
      'ASSISTANCE_ALLOWED',
    ]).parse(row.state);
  }

  recordAttempt(input: {
    sessionId: string;
    attemptId: string;
    questionRef: string;
    response: string;
    idempotencyKey: string;
  }): { attemptId: string; state: AttemptState; duplicate: boolean } {
    const existing = this.#database.prepare(
      'SELECT event_id FROM practice_events WHERE idempotency_key = ?',
    ).get(input.idempotencyKey);
    if (existing) {
      return { attemptId: input.attemptId, state: this.getAttemptState(input.attemptId), duplicate: true };
    }
    if (this.getAttemptState(input.attemptId) !== 'QUESTION_CREATED') {
      throw new Error('First attempt can only start from QUESTION_CREATED.');
    }

    const now = new Date().toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        UPDATE attempts
        SET state = 'FIRST_ATTEMPT_RECORDING', response = ?, updated_at = ?
        WHERE attempt_id = ? AND session_id = ? AND question_ref = ?
      `).run(input.response, now, input.attemptId, input.sessionId, input.questionRef);
      this.#insertPracticeEvent({
        sessionId: input.sessionId,
        attemptId: input.attemptId,
        eventType: 'first_attempt_recorded',
        payload: { outcome: input.response.trim() ? 'response' : 'blank' },
        idempotencyKey: input.idempotencyKey,
      });
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return { attemptId: input.attemptId, state: 'FIRST_ATTEMPT_RECORDING', duplicate: false };
  }

  closeFirstAttempt(input: {
    attemptId: string;
    outcome: 'blank' | 'partial' | 'completed';
    idempotencyKey: string;
  }): { attemptId: string; state: AttemptState; duplicate: boolean } {
    const existing = this.#database.prepare(
      'SELECT event_id FROM practice_events WHERE idempotency_key = ?',
    ).get(input.idempotencyKey);
    if (existing) {
      return { attemptId: input.attemptId, state: this.getAttemptState(input.attemptId), duplicate: true };
    }
    if (this.getAttemptState(input.attemptId) !== 'FIRST_ATTEMPT_RECORDING') {
      throw new Error('Only a recording first attempt can be closed.');
    }

    const row = this.#database.prepare(
      'SELECT session_id FROM attempts WHERE attempt_id = ?',
    ).get(input.attemptId) as { session_id: string };
    const now = new Date().toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        UPDATE attempts SET state = 'FIRST_ATTEMPT_CLOSED', outcome = ?, updated_at = ?
        WHERE attempt_id = ?
      `).run(input.outcome, now, input.attemptId);
      this.#insertPracticeEvent({
        sessionId: row.session_id,
        attemptId: input.attemptId,
        eventType: 'first_attempt_closed',
        payload: { outcome: input.outcome },
        idempotencyKey: input.idempotencyKey,
      });
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return { attemptId: input.attemptId, state: 'FIRST_ATTEMPT_CLOSED', duplicate: false };
  }

  allowAssistance(attemptId: string): AttemptState {
    if (this.getAttemptState(attemptId) !== 'FIRST_ATTEMPT_CLOSED') {
      throw new Error('Assistance requires a closed first attempt.');
    }
    this.#database.prepare(`
      UPDATE attempts SET state = 'ASSISTANCE_ALLOWED', updated_at = ? WHERE attempt_id = ?
    `).run(new Date().toISOString(), attemptId);
    return 'ASSISTANCE_ALLOWED';
  }

  searchContext(input: {
    query: string;
    scopes: DataScope[];
    kinds: string[];
    limit: number;
    attemptId?: string;
  }): Array<{ ref: string; scope: string; kind: string; excerpt: string; withheld: boolean }> {
    const assistanceAllowed = input.attemptId === undefined
      || this.getAttemptState(input.attemptId) === 'ASSISTANCE_ALLOWED';
    const rows = this.#database.prepare(`
      SELECT ref, scope, kind, content, disclosure
      FROM context_items
      WHERE instr(lower(content), lower(?)) > 0
      ORDER BY ref
    `).all(input.query) as Array<{
      ref: string;
      scope: string;
      kind: string;
      content: string;
      disclosure: string;
    }>;

    return rows
      .filter((row) => input.scopes.includes(row.scope as DataScope)
        && input.kinds.includes(row.kind))
      .slice(0, input.limit)
      .map((row) => {
        const withheld = !assistanceAllowed && row.disclosure !== 'general';
        return {
          ref: row.ref,
          scope: row.scope,
          kind: row.kind,
          excerpt: withheld ? '[WITHHELD_UNTIL_FIRST_ATTEMPT_CLOSED]' : row.content.slice(0, 240),
          withheld,
        };
      });
  }

  readContextExcerpt(input: {
    ref: string;
    purpose: string;
    maxChars: number;
    attemptId?: string;
  }): { ref: string; content: string; provenance: JsonRecord; purpose: string } {
    const row = this.#database.prepare(`
      SELECT content, disclosure, provenance_json FROM context_items WHERE ref = ?
    `).get(input.ref) as {
      content: string;
      disclosure: string;
      provenance_json: string;
    } | undefined;
    if (!row) throw new Error('Context reference does not exist.');
    if (input.attemptId !== undefined
      && this.getAttemptState(input.attemptId) !== 'ASSISTANCE_ALLOWED'
      && row.disclosure !== 'general') {
      throw new Error('Context is withheld until the first attempt is closed and assistance is allowed.');
    }
    return {
      ref: input.ref,
      content: row.content.slice(0, input.maxChars),
      provenance: parseJsonRecord(row.provenance_json),
      purpose: input.purpose,
    };
  }

  submitCandidate(input: {
    sessionId: string;
    attemptId?: string;
    kind: CandidateKind;
    payload: JsonRecord;
    provenance: JsonRecord;
    scope: DataScope;
    idempotencyKey: string;
  }): { candidateId: string; status: 'candidate'; duplicate: boolean } {
    if (input.attemptId !== undefined
      && this.getAttemptState(input.attemptId) !== 'ASSISTANCE_ALLOWED'
      && ['reference_answer', 'language_module', 'diagnosis'].includes(input.kind)) {
      throw new Error('Answer-shaped candidates are blocked until assistance is allowed.');
    }
    const existing = this.#database.prepare(
      'SELECT id FROM candidates WHERE idempotency_key = ?',
    ).get(input.idempotencyKey) as { id: string } | undefined;
    if (existing) return { candidateId: existing.id, status: 'candidate', duplicate: true };

    const id = randomUUID();
    this.#database.prepare(`
      INSERT INTO candidates(
        id, session_id, kind, payload_json, provenance_json, scope,
        status, version, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'candidate', 1, ?, ?)
    `).run(
      id,
      input.sessionId,
      input.kind,
      JSON.stringify(input.payload),
      JSON.stringify(input.provenance),
      input.scope,
      input.idempotencyKey,
      new Date().toISOString(),
    );
    return { candidateId: id, status: 'candidate', duplicate: false };
  }

  listPendingCandidates(sessionId: string): CandidateRow[] {
    const rows = this.#database.prepare(`
      SELECT id, session_id, kind, payload_json, provenance_json, scope, status, version
      FROM candidates WHERE session_id = ? AND status = 'candidate' ORDER BY created_at
    `).all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      session_id: String(row.session_id),
      kind: String(row.kind) as CandidateKind,
      payload: parseJsonRecord(row.payload_json),
      provenance: parseJsonRecord(row.provenance_json),
      scope: String(row.scope) as DataScope,
      status: 'candidate',
      version: Number(row.version),
    }));
  }

  prepareCommit(candidateIds: string[]): { previewId: string; candidates: CandidateRow[] } {
    const candidates = candidateIds.map((id) => {
      const row = this.#database.prepare(`
        SELECT id, session_id, kind, payload_json, provenance_json, scope, status, version
        FROM candidates WHERE id = ?
      `).get(id) as Record<string, unknown> | undefined;
      if (!row || row.status !== 'candidate') throw new Error(`Candidate is not pending: ${id}`);
      return {
        id: String(row.id),
        session_id: String(row.session_id),
        kind: String(row.kind) as CandidateKind,
        payload: parseJsonRecord(row.payload_json),
        provenance: parseJsonRecord(row.provenance_json),
        scope: String(row.scope) as DataScope,
        status: 'candidate' as const,
        version: Number(row.version),
      };
    });
    const previewId = randomUUID();
    this.#database.prepare(`
      INSERT INTO commit_previews(preview_id, candidate_ids_json, created_at) VALUES (?, ?, ?)
    `).run(previewId, JSON.stringify(candidateIds), new Date().toISOString());
    return { previewId, candidates };
  }

  issueConfirmationToken(options: {
    action: 'commit' | 'delete';
    previewId: string;
    ttlMs?: number;
  }): string {
    const previewTable = options.action === 'commit' ? 'commit_previews' : 'delete_previews';
    const exists = this.#database.prepare(
      `SELECT preview_id FROM ${previewTable} WHERE preview_id = ?`,
    ).get(options.previewId);
    if (!exists) throw new Error('Preview does not exist.');
    const token = createOpaqueToken();
    this.#database.prepare(`
      INSERT INTO confirmation_tokens(token_hash, action, preview_id, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(
      hashOpaqueToken(token),
      options.action,
      options.previewId,
      Date.now() + (options.ttlMs ?? 5 * 60_000),
    );
    return token;
  }

  commitConfirmed(input: {
    token: string;
    previewId: string;
    userEdits: Record<string, JsonRecord>;
  }): { assetIds: string[]; duplicateCount: number } {
    const tokenHash = this.#assertToken(input.token, 'commit', input.previewId);
    const preview = this.#database.prepare(
      'SELECT candidate_ids_json FROM commit_previews WHERE preview_id = ?',
    ).get(input.previewId) as { candidate_ids_json: string } | undefined;
    if (!preview) throw new Error('Commit preview does not exist.');
    const candidateIds = z.array(z.string()).parse(JSON.parse(preview.candidate_ids_json));
    const assetIds: string[] = [];
    let duplicateCount = 0;

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(
        'UPDATE confirmation_tokens SET consumed_at = ? WHERE token_hash = ?',
      ).run(Date.now(), tokenHash);
      for (const candidateId of candidateIds) {
        const existing = this.#database.prepare(
          'SELECT id FROM formal_assets WHERE candidate_id = ?',
        ).get(candidateId) as { id: string } | undefined;
        if (existing) {
          assetIds.push(existing.id);
          duplicateCount += 1;
          continue;
        }
        const candidate = this.#database.prepare(`
          SELECT kind, payload_json, provenance_json, scope, version
          FROM candidates WHERE id = ?
        `).get(candidateId) as Record<string, unknown> | undefined;
        if (!candidate) throw new Error(`Candidate disappeared: ${candidateId}`);
        const payload = {
          ...parseJsonRecord(candidate.payload_json),
          ...(input.userEdits[candidateId] ?? {}),
        };
        const assetId = randomUUID();
        this.#database.prepare(`
          INSERT INTO formal_assets(
            id, candidate_id, kind, payload_json, provenance_json, scope, version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          assetId,
          candidateId,
          String(candidate.kind),
          JSON.stringify(payload),
          String(candidate.provenance_json),
          String(candidate.scope),
          Number(candidate.version),
          new Date().toISOString(),
        );
        this.#database.prepare(
          "UPDATE candidates SET status = 'committed' WHERE id = ?",
        ).run(candidateId);
        assetIds.push(assetId);
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return { assetIds, duplicateCount };
  }

  listFormalAssets(): Array<{
    id: string;
    candidateId: string;
    kind: CandidateKind;
    payload: JsonRecord;
    provenance: JsonRecord;
    scope: DataScope;
    version: number;
  }> {
    const rows = this.#database.prepare(`
      SELECT id, candidate_id, kind, payload_json, provenance_json, scope, version
      FROM formal_assets ORDER BY created_at
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      candidateId: String(row.candidate_id),
      kind: String(row.kind) as CandidateKind,
      payload: parseJsonRecord(row.payload_json),
      provenance: parseJsonRecord(row.provenance_json),
      scope: String(row.scope) as DataScope,
      version: Number(row.version),
    }));
  }

  getFormalAssetCount(): number {
    const row = this.#database.prepare('SELECT count(*) AS count FROM formal_assets').get() as {
      count: number;
    };
    return Number(row.count);
  }

  recordPracticeEvent(input: {
    sessionId: string;
    attemptId?: string;
    eventType: string;
    payload: JsonRecord;
    idempotencyKey: string;
  }): { eventId: string; duplicate: boolean } {
    const existing = this.#database.prepare(
      'SELECT event_id FROM practice_events WHERE idempotency_key = ?',
    ).get(input.idempotencyKey) as { event_id: string } | undefined;
    if (existing) return { eventId: existing.event_id, duplicate: true };
    return {
      eventId: this.#insertPracticeEvent(input),
      duplicate: false,
    };
  }

  seedSyntheticTranscript(input: {
    transcriptId: string;
    segments: Array<{ start_ms: number; end_ms: number; text: string }>;
    timing: JsonRecord;
    provenance: JsonRecord;
  }): void {
    this.#database.prepare(`
      INSERT INTO media_transcripts(transcript_id, segments_json, timing_json, provenance_json)
      VALUES (?, ?, ?, ?)
    `).run(
      input.transcriptId,
      JSON.stringify(input.segments),
      JSON.stringify(input.timing),
      JSON.stringify(input.provenance),
    );
  }

  getTranscript(input: {
    transcriptId: string;
    startMs?: number;
    endMs?: number;
  }): { transcriptId: string; segments: unknown[]; provenance: JsonRecord } {
    const row = this.#database.prepare(`
      SELECT segments_json, provenance_json FROM media_transcripts WHERE transcript_id = ?
    `).get(input.transcriptId) as {
      segments_json: string;
      provenance_json: string;
    } | undefined;
    if (!row) throw new Error('Transcript reference does not exist.');
    const segments = z.array(z.object({
      start_ms: z.number(), end_ms: z.number(), text: z.string(),
    })).parse(JSON.parse(row.segments_json)).filter((segment) => (
      (input.startMs === undefined || segment.end_ms >= input.startMs)
      && (input.endMs === undefined || segment.start_ms <= input.endMs)
    ));
    return {
      transcriptId: input.transcriptId,
      segments,
      provenance: parseJsonRecord(row.provenance_json),
    };
  }

  getTimingFeatures(transcriptId: string): JsonRecord {
    const row = this.#database.prepare(
      'SELECT timing_json FROM media_transcripts WHERE transcript_id = ?',
    ).get(transcriptId) as { timing_json: string } | undefined;
    if (!row) throw new Error('Transcript reference does not exist.');
    return parseJsonRecord(row.timing_json);
  }

  previewDelete(input: {
    targetType: 'candidate' | 'formal_asset' | 'practice_event';
    targetIds: string[];
  }): { previewId: string; targetType: string; targetIds: string[] } {
    const previewId = randomUUID();
    this.#database.prepare(`
      INSERT INTO delete_previews(preview_id, target_type, target_ids_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(previewId, input.targetType, JSON.stringify(input.targetIds), new Date().toISOString());
    return { previewId, targetType: input.targetType, targetIds: input.targetIds };
  }

  executeDelete(input: {
    previewId: string;
    token: string;
  }): { deleted: number } {
    const tokenHash = this.#assertToken(input.token, 'delete', input.previewId);
    const preview = this.#database.prepare(`
      SELECT target_type, target_ids_json FROM delete_previews WHERE preview_id = ?
    `).get(input.previewId) as {
      target_type: 'candidate' | 'formal_asset' | 'practice_event';
      target_ids_json: string;
    } | undefined;
    if (!preview) throw new Error('Delete preview does not exist.');
    const targetIds = z.array(z.string()).parse(JSON.parse(preview.target_ids_json));
    const tableAndColumn = {
      candidate: ['candidates', 'id'],
      formal_asset: ['formal_assets', 'id'],
      practice_event: ['practice_events', 'event_id'],
    } as const;
    const [table, column] = tableAndColumn[preview.target_type];
    let deleted = 0;
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(
        'UPDATE confirmation_tokens SET consumed_at = ? WHERE token_hash = ?',
      ).run(Date.now(), tokenHash);
      for (const targetId of targetIds) {
        deleted += Number(this.#database.prepare(
          `DELETE FROM ${table} WHERE ${column} = ?`,
        ).run(targetId).changes);
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return { deleted };
  }

  #insertPracticeEvent(input: {
    sessionId: string;
    attemptId?: string;
    eventType: string;
    payload: JsonRecord;
    idempotencyKey: string;
  }): string {
    const eventId = randomUUID();
    this.#database.prepare(`
      INSERT INTO practice_events(
        event_id, session_id, attempt_id, event_type, payload_json, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      input.sessionId,
      input.attemptId ?? null,
      input.eventType,
      stableJson(input.payload),
      input.idempotencyKey,
      new Date().toISOString(),
    );
    return eventId;
  }

  #assertToken(
    token: string,
    action: 'commit' | 'delete',
    previewId: string,
  ): string {
    const tokenHash = hashOpaqueToken(token);
    const row = this.#database.prepare(`
      SELECT token_hash, action, preview_id, expires_at, consumed_at
      FROM confirmation_tokens WHERE token_hash = ?
    `).get(tokenHash) as {
      token_hash: string;
      action: string;
      preview_id: string;
      expires_at: number;
      consumed_at: number | null;
    } | undefined;
    if (!row
      || !tokenHashMatches(token, row.token_hash)
      || row.action !== action
      || row.preview_id !== previewId
      || row.expires_at < Date.now()
      || row.consumed_at !== null) {
      throw new Error('Confirmation token is invalid, expired, mismatched, or already used.');
    }
    return tokenHash;
  }
}
