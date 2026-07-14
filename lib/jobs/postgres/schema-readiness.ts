import "server-only";
import type { Pool } from "pg";

const REQUIRED_MIGRATIONS = Object.freeze([
  Object.freeze({ version: "001", checksum: "117b7a013b24735bfbeb96e6fafa605d2ccd419d51428f02ac9f972503a6048d" }),
  Object.freeze({ version: "002", checksum: "0ea84b543bd1c51b89cd8cb369f73eb6dedb97dbf3ddc06ac574e033a27f0f16" }),
  Object.freeze({ version: "003", checksum: "d82d680738a69c73e9b4cbee47ec0998fda4613bcb17493c4b5ef167593c5d70" }),
  Object.freeze({ version: "004", checksum: "13dad638517d45904468963fb050b25445cf4d2d890541ae4e69eccf14cbcc19" })
]);

export class PostgresSchemaCompatibilityError extends Error {
  constructor() {
    super("PostgreSQL schema is not compatible with this application release.");
    this.name = "PostgresSchemaCompatibilityError";
  }
}

/** Read-only schema/checksum/capability verification shared by web readiness. */
export async function assertProductionWebSchemaCompatible(pool: Pool): Promise<void> {
  try {
    const history = await pool.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM _videosave_migrations ORDER BY version"
    );
    if (
      history.rows.length !== REQUIRED_MIGRATIONS.length ||
      history.rows.some((row, index) => {
        const expected = REQUIRED_MIGRATIONS[index];
        return !expected || row.version !== expected.version || row.checksum !== expected.checksum;
      })
    ) {
      throw new PostgresSchemaCompatibilityError();
    }

    const capabilities = await pool.query<{
      jobs: string | null;
      artifacts: string | null;
      payload_columns: number;
      queue_columns: number;
      artifact_columns: number;
    }>(
      `SELECT
         to_regclass('media_jobs')::text AS jobs,
         to_regclass('media_artifacts')::text AS artifacts,
         (
           SELECT count(*)::int FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'media_jobs'
             AND column_name = ANY(ARRAY['source_url', 'format_id']::text[])
         ) AS payload_columns,
         (
           SELECT count(*)::int FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'media_jobs'
             AND column_name = ANY(ARRAY[
               'lease_attempt_id', 'available_at', 'deadline_at',
               'cancellation_requested_at', 'final_result_metadata'
             ]::text[])
         ) AS queue_columns,
         (
           SELECT count(*)::int FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'media_artifacts'
             AND column_name = ANY(ARRAY[
               'artifact_id', 'kind', 'publication_state', 'storage_key',
               'byte_size', 'expires_at'
             ]::text[])
         ) AS artifact_columns`
    );
    const row = capabilities.rows[0];
    if (
      !row?.jobs ||
      !row.artifacts ||
      row.payload_columns !== 2 ||
      row.queue_columns !== 5 ||
      row.artifact_columns !== 6
    ) {
      throw new PostgresSchemaCompatibilityError();
    }

    // Exercises the exact read-only registry/queue surfaces without mutating state.
    await Promise.all([
      pool.query("SELECT job_id FROM media_jobs WHERE false"),
      pool.query("SELECT artifact_id FROM media_artifacts WHERE false")
    ]);
  } catch (error) {
    if (error instanceof PostgresSchemaCompatibilityError) throw error;
    throw new PostgresSchemaCompatibilityError();
  }
}
