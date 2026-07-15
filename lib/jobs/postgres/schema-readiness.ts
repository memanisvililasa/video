import "server-only";
import type { Pool } from "pg";
import { POSTGRES_MIGRATION_CATALOG } from "../../../scripts/postgres-migration-catalog.mjs";

const REQUIRED_TABLES = Object.freeze([
  "_videosave_migrations",
  "media_artifacts",
  "media_jobs",
  "media_lifecycle_state"
]);
const REQUIRED_COLUMNS = Object.freeze({
  _videosave_migrations: Object.freeze(["applied_at", "checksum", "version"]),
  media_jobs: Object.freeze([
    "available_at", "cancellation_requested_at", "canonical_error", "completed_at", "created_at",
    "deadline_at", "expires_at", "final_result_metadata", "format_id", "job_id",
    "lease_attempt_id", "lease_expires_at", "lease_owner", "processing_preset", "progress",
    "retry_count", "source_metadata", "source_url", "started_at", "status", "version"
  ]),
  media_artifacts: Object.freeze([
    "artifact_id", "attempt_id", "byte_size", "checksum_sha256", "content_type", "created_at",
    "expires_at", "filename", "job_id", "kind", "publication_state", "published_at",
    "storage_key", "updated_at", "version"
  ]),
  media_lifecycle_state: Object.freeze([
    "last_expiration_at", "last_full_sweep_at", "last_reconciliation_at", "last_recovery_at",
    "singleton_key", "updated_at", "version"
  ])
});
const REQUIRED_INDEXES = Object.freeze([
  "_videosave_migrations_pkey",
  "media_artifacts_expiry_cleanup_idx",
  "media_artifacts_job_attempt_kind_key",
  "media_artifacts_job_id_idx",
  "media_artifacts_one_published_final_per_job_idx",
  "media_artifacts_pkey",
  "media_artifacts_reconciliation_idx",
  "media_artifacts_storage_key_key",
  "media_jobs_active_deadline_idx",
  "media_jobs_claim_fifo_idx",
  "media_jobs_expired_lease_idx",
  "media_jobs_expires_at_idx",
  "media_jobs_pkey",
  "media_jobs_status_idx",
  "media_lifecycle_state_pkey"
]);
const REQUIRED_CONSTRAINTS = Object.freeze([
  "_videosave_migrations_pkey",
  "media_artifacts_artifact_id_check",
  "media_artifacts_attempt_id_check",
  "media_artifacts_byte_size_check",
  "media_artifacts_checksum_check",
  "media_artifacts_content_type_check",
  "media_artifacts_filename_check",
  "media_artifacts_identity_kind_check",
  "media_artifacts_job_attempt_kind_key",
  "media_artifacts_job_id_fkey",
  "media_artifacts_kind_check",
  "media_artifacts_pkey",
  "media_artifacts_publication_state_check",
  "media_artifacts_state_shape_check",
  "media_artifacts_storage_key_check",
  "media_artifacts_storage_key_key",
  "media_artifacts_timestamp_check",
  "media_artifacts_version_check",
  "media_jobs_active_shape_check",
  "media_jobs_available_at_state_check",
  "media_jobs_cancelled_shape_check",
  "media_jobs_canonical_error_check",
  "media_jobs_completed_shape_check",
  "media_jobs_deadline_at_state_check",
  "media_jobs_execution_payload_pair_check",
  "media_jobs_failed_shape_check",
  "media_jobs_final_result_metadata_check",
  "media_jobs_format_id_check",
  "media_jobs_job_id_check",
  "media_jobs_lease_attempt_id_check",
  "media_jobs_lease_owner_format_check",
  "media_jobs_lease_status_check",
  "media_jobs_lease_tuple_check",
  "media_jobs_lifecycle_timing_check",
  "media_jobs_pkey",
  "media_jobs_processing_preset_check",
  "media_jobs_progress_check",
  "media_jobs_queued_shape_check",
  "media_jobs_ready_shape_check",
  "media_jobs_retry_count_check",
  "media_jobs_running_shape_check",
  "media_jobs_source_metadata_check",
  "media_jobs_source_url_check",
  "media_jobs_status_check",
  "media_jobs_terminal_payload_check",
  "media_jobs_timestamp_order_check",
  "media_jobs_version_check",
  "media_lifecycle_state_pkey",
  "media_lifecycle_state_singleton_check",
  "media_lifecycle_state_timestamp_order_check",
  "media_lifecycle_state_version_check"
]);

export class PostgresSchemaCompatibilityError extends Error {
  constructor() {
    super("PostgreSQL schema is not compatible with this application release.");
    this.name = "PostgresSchemaCompatibilityError";
  }
}

/** Exact read-only schema contract shared by web, worker, and cutover checks. */
export async function assertPostgresSchemaCompatible(
  pool: Pick<Pool, "query">
): Promise<void> {
  try {
    const history = await pool.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM _videosave_migrations ORDER BY version"
    );
    if (
      history.rows.length !== POSTGRES_MIGRATION_CATALOG.length ||
      history.rows.some((row, index) => {
        const expected = POSTGRES_MIGRATION_CATALOG[index];
        return !expected || row.version !== expected.version || row.checksum !== expected.checksum;
      })
    ) {
      throw new PostgresSchemaCompatibilityError();
    }

    const tables = await pool.query<{ name: string }>(
        `SELECT c.relname AS name
         FROM pg_catalog.pg_class AS c
         JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
           AND c.relname = ANY($1::text[])
         ORDER BY c.relname`,
        [REQUIRED_TABLES]
      );
    const columns = await pool.query<{ table_name: string; column_name: string }>(
        `SELECT c.relname AS table_name, a.attname AS column_name
         FROM pg_catalog.pg_attribute AS a
         JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND a.attnum > 0 AND NOT a.attisdropped
           AND c.relname = ANY($1::text[])
         ORDER BY c.relname, a.attname`,
        [Object.keys(REQUIRED_COLUMNS)]
      );
    const indexes = await pool.query<{ name: string }>(
        `SELECT i.relname AS name
         FROM pg_catalog.pg_index AS x
         JOIN pg_catalog.pg_class AS i ON i.oid = x.indexrelid
         JOIN pg_catalog.pg_class AS t ON t.oid = x.indrelid
         JOIN pg_catalog.pg_namespace AS n ON n.oid = t.relnamespace
         WHERE n.nspname = current_schema() AND x.indisvalid
           AND i.relname = ANY($1::text[])
         ORDER BY i.relname`,
        [REQUIRED_INDEXES]
      );
    const constraints = await pool.query<{ name: string }>(
        `SELECT con.conname AS name
         FROM pg_catalog.pg_constraint AS con
         JOIN pg_catalog.pg_namespace AS n ON n.oid = con.connamespace
         WHERE n.nspname = current_schema() AND con.convalidated
           AND con.conname = ANY($1::text[])
         ORDER BY con.conname`,
        [REQUIRED_CONSTRAINTS]
      );
    const tableSet = new Set(tables.rows.map((row) => row.name));
    const columnSet = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
    const indexSet = new Set(indexes.rows.map((row) => row.name));
    const constraintSet = new Set(constraints.rows.map((row) => row.name));
    if (
      REQUIRED_TABLES.some((name) => !tableSet.has(name)) ||
      Object.entries(REQUIRED_COLUMNS).some(([table, names]) =>
        names.some((name) => !columnSet.has(`${table}.${name}`))
      ) ||
      REQUIRED_INDEXES.some((name) => !indexSet.has(name)) ||
      REQUIRED_CONSTRAINTS.some((name) => !constraintSet.has(name))
    ) {
      throw new PostgresSchemaCompatibilityError();
    }
  } catch (error) {
    if (error instanceof PostgresSchemaCompatibilityError) throw error;
    throw new PostgresSchemaCompatibilityError();
  }
}

export const assertProductionWebSchemaCompatible = assertPostgresSchemaCompatible;
export const assertProductionWorkerSchemaCompatible = assertPostgresSchemaCompatible;
