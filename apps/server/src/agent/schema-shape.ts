import { type DatabaseHandle, preparedStatement } from "../db.js";

/**
 * The Agent store's on-disk contract, kept apart from its migrations.
 *
 * Everything here answers one question -- whether this Runtime can read the file
 * it was handed -- and every store entry point asks it. Migrations belong to
 * `schema.ts`, where a change of shape is a change of version; this module only
 * checks what that version is supposed to mean.
 */

export const AGENT_STORE_SCHEMA_VERSION = 7;
export const AGENT_STORE_MINIMUM_READER_VERSION = 7;

/** Raised when the file's version or shape cannot be read by this Runtime. */
export class AgentStoreVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStoreVersionError";
  }
}

export type AgentStoreVersionRow = {
  schema_version: number;
  minimum_reader_version: number;
};

type TableColumn = {
  name: string;
  pk: number;
};

export function tableExists(db: DatabaseHandle, name: string): boolean {
  return Boolean(preparedStatement(db, `
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function columnsFor(db: DatabaseHandle, table: string): TableColumn[] {
  // The table name is interpolated because SQLite does not accept a bind
  // parameter there; every caller passes one of this module's own literals, so
  // the statement cache holds one entry per table rather than one per call.
  return preparedStatement(db, `PRAGMA table_info(${table})`).all() as TableColumn[];
}

export function requireColumns(db: DatabaseHandle, table: string, names: readonly string[]): void {
  const columns = new Set(columnsFor(db, table).map((column) => column.name));
  if (!names.every((name) => columns.has(name))) {
    throw new AgentStoreVersionError(`The Agent store ${table} schema is incomplete.`);
  }
}

export function assertCurrentSchemaShape(db: DatabaseHandle): void {
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

/**
 * Despite its name this is the version row's only reader and it sits on the
 * hottest path in the store: every store entry point calls
 * `assertAgentStoreReadable`, so a per-row batch loop compiled this SELECT
 * thousands of times for one row it already had.
 */
export function versionRow(db: DatabaseHandle): AgentStoreVersionRow | undefined {
  return preparedStatement(db, `
    SELECT schema_version, minimum_reader_version
    FROM agent_store_schema
    WHERE id = 1
  `).get() as AgentStoreVersionRow | undefined;
}

/**
 * Shapes already verified on a live connection, keyed by the version row they
 * were verified against.
 *
 * `assertCurrentSchemaShape` issues ~18 `PRAGMA table_info` reads, and every
 * store entry point calls `assertAgentStoreReadable`: one mail-state write
 * reaches it through the outbox enqueue, `current()`, `assertCurrent` (twice)
 * and `accountDataKey`. A 1300-message flags acceptance therefore paid roughly
 * 117k PRAGMAs and spent 5.5s of a 5.9s transaction in this assertion alone.
 *
 * The shape is a compatibility contract between this Runtime and the file, not
 * a per-write obligation: nothing outside `applyAgentStoreSchema` changes these
 * tables, and that function owns the version row. The version row is still read
 * on every call, so a missing, migrated or newer store fails closed exactly as
 * before; only the column/list-of-tables comparison is reused while the version
 * is unchanged. `forgetVerifiedAgentStoreShape` drops the entry, so a migration
 * -- or a failed attempt at one -- is re-verified on the next read.
 */
const verifiedSchemaShapes = new WeakMap<DatabaseHandle, { schemaVersion: number; minimumReaderVersion: number }>();

/**
 * Drops the verification for a connection before a migration attempt, not after
 * it: a migration that throws leaves the file on its old version, but the next
 * read must re-verify the shape instead of inheriting a verification from
 * before the attempt.
 */
export function forgetVerifiedAgentStoreShape(db: DatabaseHandle): void {
  verifiedSchemaShapes.delete(db);
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
  const verified = verifiedSchemaShapes.get(db);
  if (verified && verified.schemaVersion === row.schema_version && verified.minimumReaderVersion === row.minimum_reader_version) {
    return;
  }
  assertCurrentSchemaShape(db);
  verifiedSchemaShapes.set(db, { schemaVersion: row.schema_version, minimumReaderVersion: row.minimum_reader_version });
}
