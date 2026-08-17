// Versioned schema migrations for the formal product database (PRD §23).
// Each migration runs once inside a transaction; applied versions are recorded
// in schema_migrations. Never edit a shipped migration — append a new one.

export interface Migration {
  version: number;
  name: string;
  statements: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'formal-core-entities',
    statements: `
      CREATE TABLE scenarios (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL DEFAULT '',
        counterpart TEXT NOT NULL DEFAULT '',
        scheduled_for TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        scenario_id TEXT REFERENCES scenarios(id),
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        media_path TEXT,
        retention TEXT NOT NULL DEFAULT 'keep',
        authorized_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_sources_scenario ON sources(scenario_id);

      CREATE TABLE source_segments (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        content_enc TEXT NOT NULL,
        start_ms INTEGER,
        end_ms INTEGER,
        page INTEGER,
        speaker TEXT,
        confidence REAL
      ) STRICT;
      CREATE INDEX idx_segments_source ON source_segments(source_id);

      CREATE TABLE knowledge_items (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scenario_id TEXT REFERENCES scenarios(id),
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content_enc TEXT NOT NULL,
        status TEXT NOT NULL,
        source_segment_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_knowledge_scope ON knowledge_items(scope, status);
      CREATE INDEX idx_knowledge_scenario ON knowledge_items(scenario_id);

      CREATE TABLE profile_assertions (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        statement_enc TEXT NOT NULL,
        evidence_segment_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scenario_id TEXT REFERENCES scenarios(id),
        prompt_enc TEXT NOT NULL,
        origin TEXT NOT NULL,
        parent_question_id TEXT REFERENCES questions(id),
        target_module_ids_json TEXT NOT NULL DEFAULT '[]',
        pressure TEXT NOT NULL DEFAULT 'none',
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_questions_scenario ON questions(scenario_id);

      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL REFERENCES questions(id),
        round TEXT NOT NULL,
        state TEXT NOT NULL,
        outcome TEXT,
        response_enc TEXT NOT NULL DEFAULT '',
        recording_source_id TEXT REFERENCES sources(id),
        opening_delay_ms INTEGER,
        duration_ms INTEGER,
        hint_level TEXT NOT NULL DEFAULT 'none',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_attempts_question ON attempts(question_id);

      CREATE TABLE diagnostics (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        dimension TEXT NOT NULL,
        finding_enc TEXT NOT NULL,
        evidence_quote_enc TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_diagnostics_attempt ON diagnostics(attempt_id);

      CREATE TABLE lego_modules (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scenario_id TEXT REFERENCES scenarios(id),
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        triggers_json TEXT NOT NULL DEFAULT '[]',
        current_version INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_modules_scope ON lego_modules(scope, status);
      CREATE INDEX idx_modules_scenario ON lego_modules(scenario_id);

      CREATE TABLE lego_versions (
        module_id TEXT NOT NULL REFERENCES lego_modules(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        payload_enc TEXT NOT NULL,
        authorship TEXT NOT NULL,
        evidence_segment_ids_json TEXT NOT NULL DEFAULT '[]',
        attempt_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        PRIMARY KEY (module_id, version)
      ) STRICT;

      CREATE TABLE module_links (
        id TEXT PRIMARY KEY,
        from_module_id TEXT NOT NULL REFERENCES lego_modules(id) ON DELETE CASCADE,
        to_module_id TEXT NOT NULL REFERENCES lego_modules(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (from_module_id, to_module_id, relation)
      ) STRICT;

      CREATE TABLE mastery_states (
        module_id TEXT PRIMARY KEY REFERENCES lego_modules(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        due_at TEXT,
        last_practiced_at TEXT,
        last_hint_level TEXT NOT NULL DEFAULT 'none',
        pressure_notes TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE practice_events (
        id TEXT PRIMARY KEY,
        module_id TEXT REFERENCES lego_modules(id) ON DELETE SET NULL,
        attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT 'not-applicable',
        detail TEXT NOT NULL DEFAULT '',
        occurred_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_practice_module ON practice_events(module_id, occurred_at);

      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        sdk_session_id TEXT NOT NULL,
        provider_profile_id TEXT,
        purpose TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE consent_events (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        object_ref TEXT NOT NULL,
        scope TEXT NOT NULL,
        decision TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        code TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        occurred_at TEXT NOT NULL
      ) STRICT;

      CREATE VIRTUAL TABLE search_index USING fts5(
        entity_type,
        entity_id UNINDEXED,
        text,
        tokenize = 'trigram'
      );
    `,
  },
  {
    version: 2,
    name: 'profile-grounding-and-module-domains',
    statements: `
      -- Growing professional profile seed: a single row of three short answers
      -- plus optional pasted material, all encrypted (personal free text).
      CREATE TABLE profile_seed (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        direction_enc TEXT NOT NULL,
        current_work_enc TEXT NOT NULL,
        target_scenarios_enc TEXT NOT NULL,
        material_enc TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      ) STRICT;

      -- Six alternating question types plus the exploratory marker (questions
      -- outside the confirmed profile do not count as expression failures).
      ALTER TABLE questions ADD COLUMN question_type TEXT;
      ALTER TABLE questions ADD COLUMN exploratory INTEGER NOT NULL DEFAULT 0;

      -- Knowledge gap vs expression gap, chosen by the user when stuck.
      ALTER TABLE attempts ADD COLUMN gap TEXT;

      -- Three-tier module scopes: generic / professional (global scope) with
      -- scenario modules staying domain-null until explicitly promoted.
      ALTER TABLE lego_modules ADD COLUMN domain TEXT;
    `,
  },
];
