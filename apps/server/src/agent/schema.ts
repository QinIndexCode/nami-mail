import type { DatabaseHandle } from "../db.js";

export const AGENT_STORE_SCHEMA_VERSION = 6;
export const AGENT_STORE_MINIMUM_READER_VERSION = 6;

export class AgentStoreVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStoreVersionError";
  }
}

type AgentStoreVersionRow = {
  schema_version: number;
  minimum_reader_version: number;
};

type TableColumn = {
  name: string;
  pk: number;
};

const agentStoreVersionSql = `
CREATE TABLE IF NOT EXISTS agent_store_schema (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  minimum_reader_version INTEGER NOT NULL CHECK (minimum_reader_version >= 1),
  updated_at TEXT NOT NULL
);
`;

const agentSourceEventsTableSql = `
CREATE TABLE IF NOT EXISTS agent_source_events (
  event_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL CHECK (account_generation >= 0),
  source_locator_opaque TEXT NOT NULL,
  encrypted_source_locator TEXT,
  source_locator_crypto_version INTEGER NOT NULL DEFAULT 0 CHECK (source_locator_crypto_version >= 0),
  source_revision TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'message-upserted', 'message-deleted', 'attachment-upserted',
    'attachment-deleted', 'account-generation-advanced', 'account-deleted'
  )),
  payload_digest TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claimed_at TEXT,
  claim_owner TEXT,
  claim_token_hash TEXT,
  claim_version INTEGER NOT NULL DEFAULT 0 CHECK (claim_version >= 0),
  claim_expires_at TEXT,
  next_attempt_at TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (event_type IN ('account-generation-advanced', 'account-deleted')
      AND encrypted_source_locator IS NULL
      AND source_locator_crypto_version = 0)
    OR
    (event_type NOT IN ('account-generation-advanced', 'account-deleted')
      AND (
        (encrypted_source_locator IS NOT NULL AND source_locator_crypto_version >= 1)
        OR (state IN ('completed', 'cancelled')
          AND encrypted_source_locator IS NULL
          AND source_locator_crypto_version = 0)
      ))
  ),
  CHECK (
    (state = 'processing'
      AND claim_owner IS NOT NULL
      AND claim_token_hash IS NOT NULL
      AND claim_expires_at IS NOT NULL)
    OR
    (state <> 'processing'
      AND claim_owner IS NULL
      AND claim_token_hash IS NULL
      AND claim_expires_at IS NULL)
  ),
  UNIQUE (account_id, account_generation, source_locator_opaque, source_revision, event_type)
);
`;

const agentRagPagesTableSql = `
CREATE TABLE IF NOT EXISTS agent_rag_pages (
  account_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL CHECK (account_generation >= 0),
  page_id TEXT NOT NULL,
  page_revision INTEGER NOT NULL CHECK (page_revision >= 1),
  page_kind TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  content_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (account_id, account_generation, page_id, page_revision)
);
`;

/** The complete current Agent-owned schema for a new database. */
export const agentStoreSchemaSql = `
${agentStoreVersionSql}

CREATE TABLE IF NOT EXISTS agent_account_lifecycle (
  account_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'deleting', 'deleted')),
  encrypted_dek TEXT,
  crypto_version INTEGER NOT NULL DEFAULT 0 CHECK (crypto_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_account_lifecycle_state
  ON agent_account_lifecycle(state, updated_at DESC);

${agentSourceEventsTableSql}

CREATE INDEX IF NOT EXISTS idx_agent_source_events_ready
  ON agent_source_events(state, next_attempt_at, occurred_at, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_source_events_account
  ON agent_source_events(account_id, account_generation, state, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_source_events_claim_expiry
  ON agent_source_events(state, claim_expires_at);

${agentRagPagesTableSql}

CREATE INDEX IF NOT EXISTS idx_agent_rag_pages_active
  ON agent_rag_pages(account_id, account_generation, page_id, page_revision DESC)
  WHERE state = 'active';

CREATE TABLE IF NOT EXISTS agent_conversations (
  conversation_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_conversation_scopes (
  conversation_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL CHECK (account_generation >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, account_id, account_generation)
);

CREATE INDEX IF NOT EXISTS idx_agent_conversation_scopes_account
  ON agent_conversation_scopes(account_id, account_generation, conversation_id);

CREATE TABLE IF NOT EXISTS agent_conversation_records (
  record_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  account_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL CHECK (account_generation >= 0),
  encrypted_payload TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (record_id, account_id, account_generation)
);

CREATE INDEX IF NOT EXISTS idx_agent_conversation_records_sequence
  ON agent_conversation_records(conversation_id, sequence, record_id);

-- Durable in-progress assistant draft. Unlike agent_conversation_records
-- (append-only immutable history), this row is updated in place while a reply
-- streams and is removed once the finished turn is appended. A re-opened panel
-- reads it from storage instead of relying on process memory; if the process
-- disappears mid-stream the stale draft marks the reply as interrupted.
CREATE TABLE IF NOT EXISTS agent_conversation_streaming (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_conversation_streaming_updated
  ON agent_conversation_streaming(updated_at);

CREATE TRIGGER IF NOT EXISTS agent_conversation_records_no_update
BEFORE UPDATE ON agent_conversation_records
BEGIN
  SELECT RAISE(ABORT, 'Agent conversation records are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS agent_conversation_records_no_delete
BEFORE DELETE ON agent_conversation_records
BEGIN
  SELECT RAISE(ABORT, 'Agent conversation records are immutable.');
END;

CREATE TABLE IF NOT EXISTS agent_audit_intents (
  intent_id TEXT PRIMARY KEY,
  account_id TEXT,
  account_generation INTEGER,
  action_type TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  encrypted_details TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_intents_account
  ON agent_audit_intents(account_id, account_generation, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_audit_events (
  event_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  encrypted_details TEXT,
  crypto_version INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_events_intent
  ON agent_audit_events(intent_id, created_at);

CREATE TRIGGER IF NOT EXISTS agent_audit_intents_no_update
BEFORE UPDATE ON agent_audit_intents
BEGIN
  SELECT RAISE(ABORT, 'Agent audit intents are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS agent_audit_intents_no_delete
BEFORE DELETE ON agent_audit_intents
BEGIN
  SELECT RAISE(ABORT, 'Agent audit intents are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS agent_audit_events_no_update
BEFORE UPDATE ON agent_audit_events
BEGIN
  SELECT RAISE(ABORT, 'Agent audit events are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS agent_audit_events_no_delete
BEFORE DELETE ON agent_audit_events
BEGIN
  SELECT RAISE(ABORT, 'Agent audit events are immutable.');
END;

CREATE TABLE IF NOT EXISTS agent_gui_confirmation_records (
  record_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  account_id TEXT,
  account_generation INTEGER,
  confirmation_token_hash TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('requested', 'confirmed', 'rejected', 'consumed', 'expired')),
  encrypted_snapshot TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_gui_confirmation_one_request
  ON agent_gui_confirmation_records(intent_id)
  WHERE event_type = 'requested';
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_gui_confirmation_one_confirm
  ON agent_gui_confirmation_records(intent_id)
  WHERE event_type = 'confirmed';
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_gui_confirmation_one_consume
  ON agent_gui_confirmation_records(intent_id)
  WHERE event_type = 'consumed';
CREATE INDEX IF NOT EXISTS idx_agent_gui_confirmation_intent
  ON agent_gui_confirmation_records(intent_id, created_at);

CREATE TRIGGER IF NOT EXISTS agent_gui_confirmation_records_no_update
BEFORE UPDATE ON agent_gui_confirmation_records
BEGIN
  SELECT RAISE(ABORT, 'Agent GUI confirmation records are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS agent_gui_confirmation_records_no_delete
BEFORE DELETE ON agent_gui_confirmation_records
BEGIN
  SELECT RAISE(ABORT, 'Agent GUI confirmation records are immutable.');
END;

CREATE TABLE IF NOT EXISTS agent_provider_configurations (
  provider_id TEXT PRIMARY KEY,
  encrypted_configuration TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_mcp_servers (
  server_id TEXT PRIMARY KEY,
  encrypted_configuration TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_memory_records (
  record_id TEXT PRIMARY KEY,
  record_kind TEXT NOT NULL CHECK (record_kind IN (
    'auto-reply-sent', 'auto-reply-ignored', 'email-sent',
    'calendar-created', 'calendar-updated', 'calendar-deleted', 'note'
  )),
  account_id TEXT,
  encrypted_payload TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_occurred
  ON agent_memory_records(occurred_at DESC, record_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_kind
  ON agent_memory_records(record_kind, occurred_at DESC, record_id);

CREATE TABLE IF NOT EXISTS agent_rag_index (
  account_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL CHECK (account_generation >= 0),
  page_id TEXT NOT NULL,
  page_revision INTEGER NOT NULL CHECK (page_revision >= 1),
  message_id TEXT NOT NULL,
  term TEXT NOT NULL,
  tf_subject INTEGER NOT NULL CHECK (tf_subject >= 0),
  tf_sender INTEGER NOT NULL CHECK (tf_sender >= 0),
  tf_body INTEGER NOT NULL CHECK (tf_body >= 0),
  term_count INTEGER NOT NULL CHECK (term_count >= 0),
  sent_at TEXT,
  PRIMARY KEY (account_id, account_generation, page_id, page_revision, term)
);

CREATE INDEX IF NOT EXISTS idx_agent_rag_index_term
  ON agent_rag_index(term, account_id, account_generation);

CREATE INDEX IF NOT EXISTS idx_agent_rag_index_page
  ON agent_rag_index(account_id, account_generation, page_id, page_revision);

CREATE TABLE IF NOT EXISTS agent_rag_index_stats (
  account_id TEXT NOT NULL,
  account_generation INTEGER NOT NULL CHECK (account_generation >= 0),
  doc_count INTEGER NOT NULL CHECK (doc_count >= 0),
  term_total INTEGER NOT NULL CHECK (term_total >= 0),
  PRIMARY KEY (account_id, account_generation)
);
`;

const agentTableNames = [
  "agent_account_lifecycle",
  "agent_source_events",
  "agent_rag_pages",
  "agent_conversations",
  "agent_conversation_scopes",
  "agent_conversation_records",
  "agent_conversation_streaming",
  "agent_audit_intents",
  "agent_audit_events",
  "agent_gui_confirmation_records",
  "agent_provider_configurations",
  "agent_mcp_servers",
  "agent_memory_records",
  "agent_rag_index",
  "agent_rag_index_stats",
] as const;

function tableExists(db: DatabaseHandle, name: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function existingAgentTables(db: DatabaseHandle): string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'agent_%' AND name <> 'agent_store_schema'
  `).all() as Array<{ name: string }>).map((row) => row.name);
}

function columnsFor(db: DatabaseHandle, table: string): TableColumn[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableColumn[];
}

function requireColumns(db: DatabaseHandle, table: string, names: readonly string[]): void {
  const columns = new Set(columnsFor(db, table).map((column) => column.name));
  if (!names.every((name) => columns.has(name))) {
    throw new AgentStoreVersionError(`The Agent store ${table} schema is incomplete.`);
  }
}

function assertCurrentSchemaShape(db: DatabaseHandle): void {
  requireColumns(db, "agent_source_events", [
    "encrypted_source_locator",
    "source_locator_crypto_version",
    "claim_owner",
    "claim_token_hash",
    "claim_version",
    "claim_expires_at",
    "next_attempt_at",
  ]);
  requireColumns(db, "agent_provider_configurations", [
    "provider_id",
    "encrypted_configuration",
    "crypto_version",
    "created_at",
    "updated_at",
  ]);
  requireColumns(db, "agent_mcp_servers", [
    "server_id",
    "encrypted_configuration",
    "crypto_version",
    "created_at",
    "updated_at",
  ]);
  requireColumns(db, "agent_memory_records", [
    "record_id",
    "record_kind",
    "account_id",
    "encrypted_payload",
    "crypto_version",
    "occurred_at",
    "created_at",
    "updated_at",
  ]);
  requireColumns(db, "agent_conversation_streaming", [
    "conversation_id",
    "message_id",
    "encrypted_payload",
    "crypto_version",
    "created_at",
    "updated_at",
  ]);
  requireColumns(db, "agent_rag_index", [
    "account_id",
    "account_generation",
    "page_id",
    "page_revision",
    "message_id",
    "term",
    "tf_subject",
    "tf_sender",
    "tf_body",
    "term_count",
    "sent_at",
  ]);
  requireColumns(db, "agent_rag_index_stats", [
    "account_id",
    "account_generation",
    "doc_count",
    "term_total",
  ]);
  const primaryKey = columnsFor(db, "agent_rag_pages")
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  const expectedPrimaryKey = ["account_id", "account_generation", "page_id", "page_revision"];
  if (primaryKey.length !== expectedPrimaryKey.length || primaryKey.some((column, index) => column !== expectedPrimaryKey[index])) {
    throw new AgentStoreVersionError("The Agent RAG page schema has an unsupported primary key.");
  }
  const indexPrimaryKey = columnsFor(db, "agent_rag_index")
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  const expectedIndexPrimaryKey = ["account_id", "account_generation", "page_id", "page_revision", "term"];
  if (indexPrimaryKey.length !== expectedIndexPrimaryKey.length || indexPrimaryKey.some((column, index) => column !== expectedIndexPrimaryKey[index])) {
    throw new AgentStoreVersionError("The Agent RAG index schema has an unsupported primary key.");
  }
  const statsPrimaryKey = columnsFor(db, "agent_rag_index_stats")
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  const expectedStatsPrimaryKey = ["account_id", "account_generation"];
  if (statsPrimaryKey.length !== expectedStatsPrimaryKey.length || statsPrimaryKey.some((column, index) => column !== expectedStatsPrimaryKey[index])) {
    throw new AgentStoreVersionError("The Agent RAG index stats schema has an unsupported primary key.");
  }
}

function migrateSourceEventsV1ToV2(db: DatabaseHandle, now: string): void {
  if (!tableExists(db, "agent_source_events")) return;
  db.exec("DROP INDEX IF EXISTS idx_agent_source_events_ready");
  db.exec("DROP INDEX IF EXISTS idx_agent_source_events_account");
  db.exec("ALTER TABLE agent_source_events RENAME TO agent_source_events_v1");
  db.exec(agentSourceEventsTableSql);
  db.prepare(`
    INSERT INTO agent_source_events (
      event_id, account_id, account_generation, source_locator_opaque,
      encrypted_source_locator, source_locator_crypto_version, source_revision,
      event_type, payload_digest, occurred_at, state, attempt_count, claimed_at,
      claim_owner, claim_token_hash, claim_version, claim_expires_at, next_attempt_at,
      completed_at, last_error_code, last_error_at, created_at
    )
    SELECT
      event_id,
      account_id,
      account_generation,
      source_locator_opaque,
      NULL,
      0,
      source_revision,
      event_type,
      payload_digest,
      occurred_at,
      CASE
        WHEN event_type NOT IN ('account-generation-advanced', 'account-deleted')
          AND state IN ('pending', 'processing', 'failed') THEN 'cancelled'
        WHEN event_type IN ('account-generation-advanced', 'account-deleted')
          AND state = 'processing' THEN 'failed'
        ELSE state
      END,
      attempt_count,
      CASE WHEN state = 'processing' THEN NULL ELSE claimed_at END,
      NULL,
      NULL,
      0,
      NULL,
      CASE
        WHEN event_type IN ('account-generation-advanced', 'account-deleted')
          AND state IN ('processing', 'failed') THEN ?
        ELSE NULL
      END,
      CASE
        WHEN event_type NOT IN ('account-generation-advanced', 'account-deleted')
          AND state IN ('pending', 'processing', 'failed') THEN ?
        WHEN event_type IN ('account-generation-advanced', 'account-deleted')
          AND state = 'processing' THEN NULL
        ELSE completed_at
      END,
      CASE
        WHEN event_type NOT IN ('account-generation-advanced', 'account-deleted')
          AND state IN ('pending', 'processing', 'failed') THEN 'source_locator_unrecoverable_after_migration'
        WHEN event_type IN ('account-generation-advanced', 'account-deleted')
          AND state = 'processing' THEN 'claim_recovered_after_migration'
        ELSE last_error_code
      END,
      CASE
        WHEN event_type NOT IN ('account-generation-advanced', 'account-deleted')
          AND state IN ('pending', 'processing', 'failed') THEN ?
        WHEN event_type IN ('account-generation-advanced', 'account-deleted')
          AND state = 'processing' THEN ?
        ELSE last_error_at
      END,
      created_at
    FROM agent_source_events_v1
  `).run(now, now, now, now);
  db.exec("DROP TABLE agent_source_events_v1");
}

function migrateRagPagesV1ToV2(db: DatabaseHandle): void {
  if (!tableExists(db, "agent_rag_pages")) return;
  db.exec("DROP INDEX IF EXISTS idx_agent_rag_pages_active");
  db.exec("ALTER TABLE agent_rag_pages RENAME TO agent_rag_pages_v1");
  db.exec(agentRagPagesTableSql);
  db.exec(`
    INSERT INTO agent_rag_pages (
      account_id, account_generation, page_id, page_revision, page_kind,
      encrypted_payload, crypto_version, content_digest, state, created_at,
      updated_at, deleted_at
    )
    SELECT
      account_id, account_generation, page_id, page_revision, page_kind,
      encrypted_payload, crypto_version, content_digest, state, created_at,
      updated_at, deleted_at
    FROM agent_rag_pages_v1
  `);
  db.exec("DROP TABLE agent_rag_pages_v1");
}

function migrateAuditIntentLinksV1ToV2(db: DatabaseHandle): void {
  if (!tableExists(db, "agent_audit_intents") || !tableExists(db, "agent_audit_events")) return;
  db.exec("DROP TRIGGER IF EXISTS agent_audit_events_no_update");
  db.prepare(`
    UPDATE agent_audit_events
    SET intent_id = (
      SELECT intent_id
      FROM agent_audit_intents
      WHERE request_fingerprint = agent_audit_events.intent_id
      ORDER BY created_at DESC, intent_id DESC
      LIMIT 1
    )
    WHERE EXISTS (
      SELECT 1
      FROM agent_audit_intents
      WHERE request_fingerprint = agent_audit_events.intent_id
    )
  `).run();
}

function assertV1MigrationInputs(db: DatabaseHandle): void {
  if (!tableExists(db, "agent_source_events") || !tableExists(db, "agent_rag_pages")) {
    throw new AgentStoreVersionError("The Agent v1 store is incomplete and cannot be migrated safely.");
  }
  requireColumns(db, "agent_source_events", [
    "event_id",
    "account_id",
    "account_generation",
    "source_locator_opaque",
    "source_revision",
    "event_type",
    "state",
  ]);
  requireColumns(db, "agent_rag_pages", [
    "account_id",
    "account_generation",
    "page_id",
    "page_revision",
    "encrypted_payload",
  ]);
}

function migrateAgentStoreV1ToV2(db: DatabaseHandle, now: string): void {
  assertV1MigrationInputs(db);
  migrateSourceEventsV1ToV2(db, now);
  migrateRagPagesV1ToV2(db);
  migrateAuditIntentLinksV1ToV2(db);
  db.exec(agentStoreSchemaSql);
}

/** v2 → v3 adds the encrypted MCP server configuration table. */
function migrateAgentStoreV2ToV3(db: DatabaseHandle): void {
  if (tableExists(db, "agent_mcp_servers")) {
    requireColumns(db, "agent_mcp_servers", [
      "server_id",
      "encrypted_configuration",
      "crypto_version",
      "created_at",
      "updated_at",
    ]);
    return;
  }
  db.exec(agentStoreSchemaSql);
}

/** v3 → v4 adds the encrypted Agent memory records table. */
function migrateAgentStoreV3ToV4(db: DatabaseHandle): void {
  if (tableExists(db, "agent_memory_records")) {
    requireColumns(db, "agent_memory_records", [
      "record_id",
      "record_kind",
      "account_id",
      "encrypted_payload",
      "crypto_version",
      "occurred_at",
      "created_at",
      "updated_at",
    ]);
    return;
  }
  db.exec(agentStoreSchemaSql);
}

/** v4 → v5 adds the persisted lexical RAG index and per-generation stats tables. */
function migrateAgentStoreV4ToV5(db: DatabaseHandle): void {
  if (tableExists(db, "agent_rag_index") || tableExists(db, "agent_rag_index_stats")) {
    requireColumns(db, "agent_rag_index", [
      "account_id",
      "account_generation",
      "page_id",
      "page_revision",
      "message_id",
      "term",
      "tf_subject",
      "tf_sender",
      "tf_body",
      "term_count",
      "sent_at",
    ]);
    requireColumns(db, "agent_rag_index_stats", [
      "account_id",
      "account_generation",
      "doc_count",
      "term_total",
    ]);
    return;
  }
  db.exec(agentStoreSchemaSql);
}

/** v5 → v6 adds the replaceable in-progress streaming draft table. */
function migrateAgentStoreV5ToV6(db: DatabaseHandle): void {
  if (tableExists(db, "agent_conversation_streaming")) {
    requireColumns(db, "agent_conversation_streaming", [
      "conversation_id",
      "message_id",
      "encrypted_payload",
      "crypto_version",
      "created_at",
      "updated_at",
    ]);
    return;
  }
  db.exec(agentStoreSchemaSql);
}

function versionRow(db: DatabaseHandle): AgentStoreVersionRow | undefined {
  return db.prepare(`
    SELECT schema_version, minimum_reader_version
    FROM agent_store_schema
    WHERE id = 1
  `).get() as AgentStoreVersionRow | undefined;
}

/**
 * Installs a new Agent schema or migrates the explicitly supported previous
 * version. A version row is never advanced unless its SQLite migration ran.
 */
export function applyAgentStoreSchema(db: DatabaseHandle, now = new Date().toISOString()): void {
  db.transaction(() => {
    db.exec(agentStoreVersionSql);
    const row = versionRow(db);
    if (!row) {
      const tables = existingAgentTables(db);
      if (tables.length) {
        throw new AgentStoreVersionError("The Agent store has tables but no schema version; migration is unsafe.");
      }
      db.exec(agentStoreSchemaSql);
      db.prepare(`
        INSERT INTO agent_store_schema (id, schema_version, minimum_reader_version, updated_at)
        VALUES (1, ?, ?, ?)
      `).run(AGENT_STORE_SCHEMA_VERSION, AGENT_STORE_MINIMUM_READER_VERSION, now);
      assertCurrentSchemaShape(db);
      return;
    }
    if (row.minimum_reader_version > AGENT_STORE_SCHEMA_VERSION || row.schema_version > AGENT_STORE_SCHEMA_VERSION) {
      throw new AgentStoreVersionError("The Agent store requires a newer Nami Mail Runtime.");
    }
    if (row.schema_version < 1) {
      throw new AgentStoreVersionError("The Agent store has an invalid schema version.");
    }
    if (row.schema_version === 1) {
      migrateAgentStoreV1ToV2(db, now);
    } else if (row.schema_version === 2) {
      migrateAgentStoreV2ToV3(db);
    } else if (row.schema_version === 3) {
      migrateAgentStoreV3ToV4(db);
    } else if (row.schema_version === 4) {
      migrateAgentStoreV4ToV5(db);
    } else if (row.schema_version === 5) {
      migrateAgentStoreV5ToV6(db);
    } else if (row.schema_version !== AGENT_STORE_SCHEMA_VERSION) {
      throw new AgentStoreVersionError("The Agent store schema is not supported by this Runtime.");
    }
    assertCurrentSchemaShape(db);
    db.prepare(`
      UPDATE agent_store_schema
      SET schema_version = ?, minimum_reader_version = ?, updated_at = ?
      WHERE id = 1
    `).run(AGENT_STORE_SCHEMA_VERSION, AGENT_STORE_MINIMUM_READER_VERSION, now);
  })();
}

/** Fails closed when schema installation or a compatible reader is unavailable. */
export function assertAgentStoreReadable(db: DatabaseHandle): void {
  let row: AgentStoreVersionRow | undefined;
  try {
    row = versionRow(db);
  } catch {
    throw new AgentStoreVersionError("The Agent store has not been initialized by this Runtime.");
  }
  if (!row) throw new AgentStoreVersionError("The Agent store has not been initialized by this Runtime.");
  if (
    row.schema_version !== AGENT_STORE_SCHEMA_VERSION
    || row.minimum_reader_version > AGENT_STORE_SCHEMA_VERSION
  ) {
    throw new AgentStoreVersionError("The Agent store requires a schema migration or a newer Nami Mail Runtime.");
  }
  assertCurrentSchemaShape(db);
}
