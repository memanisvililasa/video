import "server-only";
import type { Pool } from "pg";
import { assertPostgresSchemaCompatible } from "@/lib/jobs/postgres/schema-readiness";

export const MIGRATION_ADVISORY_LOCK_KEY = 5_903_000_001n;
const SAFE_ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

export class PostgresCutoverReadinessError extends Error {
  constructor() {
    super("PostgreSQL cutover readiness failed.");
    this.name = "PostgresCutoverReadinessError";
  }
}

export type PostgresCutoverRoleNames = Readonly<{
  migration: string;
  web: string;
  worker: string;
}>;

export const DEFAULT_POSTGRES_CUTOVER_ROLES: PostgresCutoverRoleNames = Object.freeze({
  migration: "videosave_migration",
  web: "videosave_web",
  worker: "videosave_worker"
});

function roleNames(input: PostgresCutoverRoleNames): PostgresCutoverRoleNames {
  if (Object.values(input).some((value) => !SAFE_ROLE.test(value))) {
    throw new PostgresCutoverReadinessError();
  }
  return input;
}

type RoleRow = Readonly<{
  rolname: string;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  migration_member: boolean;
  schema_owner: boolean;
  schema_usage: boolean;
  schema_create: boolean;
}>;

/** All queries are catalog/data SELECTs; this function never acquires an advisory lock. */
export async function assertPostgresCutoverReady(
  pool: Pool,
  options: Readonly<{ roles?: PostgresCutoverRoleNames }> = {}
): Promise<void> {
  const roles = roleNames(options.roles ?? DEFAULT_POSTGRES_CUTOVER_ROLES);
  const client = await pool.connect().catch(() => {
    throw new PostgresCutoverReadinessError();
  });
  try {
    await client.query("BEGIN READ ONLY");
    await assertPostgresSchemaCompatible(client);
    const roleState = await client.query<RoleRow>(
        `SELECT r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
                pg_has_role(r.oid, migration.oid, 'MEMBER') AS migration_member,
                n.nspowner = r.oid AS schema_owner,
                has_schema_privilege(r.oid, n.oid, 'USAGE') AS schema_usage,
                has_schema_privilege(r.oid, n.oid, 'CREATE') AS schema_create
         FROM pg_catalog.pg_roles AS r
         CROSS JOIN pg_catalog.pg_roles AS migration
         CROSS JOIN pg_catalog.pg_namespace AS n
         WHERE n.nspname = current_schema() AND migration.rolname = $2
           AND r.rolname = ANY($1::text[])
         ORDER BY r.rolname`,
        [[roles.migration, roles.web, roles.worker], roles.migration]
      );
    const privileges = await client.query<{
        web_history_select: boolean;
        web_jobs_select: boolean;
        web_jobs_insert: boolean;
        web_jobs_update: boolean;
        web_jobs_delete: boolean;
        web_artifacts_select: boolean;
        web_artifacts_insert: boolean;
        web_artifacts_update: boolean;
        web_artifacts_delete: boolean;
        web_lifecycle_select: boolean;
        worker_history_select: boolean;
        worker_history_update: boolean;
        worker_jobs_select: boolean;
        worker_jobs_insert: boolean;
        worker_jobs_update: boolean;
        worker_jobs_delete: boolean;
        worker_artifacts_select: boolean;
        worker_artifacts_insert: boolean;
        worker_artifacts_update: boolean;
        worker_artifacts_delete: boolean;
        worker_lifecycle_select: boolean;
        worker_lifecycle_update: boolean;
      }>(
        `SELECT
          has_table_privilege($1, format('%I._videosave_migrations', current_schema()), 'SELECT') AS web_history_select,
          has_table_privilege($1, format('%I.media_jobs', current_schema()), 'SELECT') AS web_jobs_select,
          has_table_privilege($1, format('%I.media_jobs', current_schema()), 'INSERT') AS web_jobs_insert,
          has_table_privilege($1, format('%I.media_jobs', current_schema()), 'UPDATE') AS web_jobs_update,
          has_table_privilege($1, format('%I.media_jobs', current_schema()), 'DELETE') AS web_jobs_delete,
          has_table_privilege($1, format('%I.media_artifacts', current_schema()), 'SELECT') AS web_artifacts_select,
          has_table_privilege($1, format('%I.media_artifacts', current_schema()), 'INSERT') AS web_artifacts_insert,
          has_table_privilege($1, format('%I.media_artifacts', current_schema()), 'UPDATE') AS web_artifacts_update,
          has_table_privilege($1, format('%I.media_artifacts', current_schema()), 'DELETE') AS web_artifacts_delete,
          has_table_privilege($1, format('%I.media_lifecycle_state', current_schema()), 'SELECT') AS web_lifecycle_select,
          has_table_privilege($2, format('%I._videosave_migrations', current_schema()), 'SELECT') AS worker_history_select,
          has_table_privilege($2, format('%I._videosave_migrations', current_schema()), 'UPDATE') AS worker_history_update,
          has_table_privilege($2, format('%I.media_jobs', current_schema()), 'SELECT') AS worker_jobs_select,
          has_table_privilege($2, format('%I.media_jobs', current_schema()), 'INSERT') AS worker_jobs_insert,
          has_table_privilege($2, format('%I.media_jobs', current_schema()), 'UPDATE') AS worker_jobs_update,
          has_table_privilege($2, format('%I.media_jobs', current_schema()), 'DELETE') AS worker_jobs_delete,
          has_table_privilege($2, format('%I.media_artifacts', current_schema()), 'SELECT') AS worker_artifacts_select,
          has_table_privilege($2, format('%I.media_artifacts', current_schema()), 'INSERT') AS worker_artifacts_insert,
          has_table_privilege($2, format('%I.media_artifacts', current_schema()), 'UPDATE') AS worker_artifacts_update,
          has_table_privilege($2, format('%I.media_artifacts', current_schema()), 'DELETE') AS worker_artifacts_delete,
          has_table_privilege($2, format('%I.media_lifecycle_state', current_schema()), 'SELECT') AS worker_lifecycle_select,
          has_table_privilege($2, format('%I.media_lifecycle_state', current_schema()), 'UPDATE') AS worker_lifecycle_update`,
        [roles.web, roles.worker]
      );
    const blockers = await client.query<{
        migration_lock_held: boolean;
        invalid_indexes: number;
        unvalidated_constraints: number;
        unclaimable_jobs: number;
      }>(
        `SELECT
          EXISTS (
            SELECT 1 FROM pg_catalog.pg_locks
            WHERE locktype = 'advisory' AND granted AND objsubid = 1
              AND ((classid::bigint << 32) | objid::bigint) = $1::bigint
          ) AS migration_lock_held,
          (
            SELECT count(*)::int
            FROM pg_catalog.pg_index AS i
            JOIN pg_catalog.pg_class AS t ON t.oid = i.indrelid
            JOIN pg_catalog.pg_namespace AS n ON n.oid = t.relnamespace
            WHERE n.nspname = current_schema() AND NOT i.indisvalid
          ) AS invalid_indexes,
          (
            SELECT count(*)::int FROM pg_catalog.pg_constraint AS c
            JOIN pg_catalog.pg_namespace AS n ON n.oid = c.connamespace
            WHERE n.nspname = current_schema() AND NOT c.convalidated
          ) AS unvalidated_constraints,
          (
            SELECT count(*)::int FROM media_jobs
            WHERE status = 'queued' AND (source_url IS NULL OR format_id IS NULL)
          ) AS unclaimable_jobs`,
        [MIGRATION_ADVISORY_LOCK_KEY.toString()]
      );

    if (roleState.rows.length !== 3) throw new PostgresCutoverReadinessError();
    const byName = new Map(roleState.rows.map((row) => [row.rolname, row]));
    const migration = byName.get(roles.migration);
    const web = byName.get(roles.web);
    const worker = byName.get(roles.worker);
    if (!migration?.schema_owner || web?.schema_owner || worker?.schema_owner) {
      throw new PostgresCutoverReadinessError();
    }
    for (const runtime of [migration, web, worker]) {
      if (
        !runtime || runtime.rolsuper || runtime.rolcreatedb || runtime.rolcreaterole ||
        runtime.rolreplication
      ) throw new PostgresCutoverReadinessError();
    }
    if (
      !web?.schema_usage || !worker?.schema_usage || web.schema_create || worker.schema_create ||
      web.migration_member || worker.migration_member
    ) throw new PostgresCutoverReadinessError();
    const privilegeRow = privileges.rows[0];
    if (!privilegeRow) throw new PostgresCutoverReadinessError();
    const requiredPrivileges = [
      privilegeRow.web_history_select,
      privilegeRow.web_jobs_select,
      privilegeRow.web_jobs_insert,
      privilegeRow.web_jobs_update,
      privilegeRow.web_artifacts_select,
      privilegeRow.worker_history_select,
      privilegeRow.worker_jobs_select,
      privilegeRow.worker_jobs_update,
      privilegeRow.worker_jobs_delete,
      privilegeRow.worker_artifacts_select,
      privilegeRow.worker_artifacts_insert,
      privilegeRow.worker_artifacts_update,
      privilegeRow.worker_artifacts_delete,
      privilegeRow.worker_lifecycle_select,
      privilegeRow.worker_lifecycle_update
    ];
    const forbiddenPrivileges = [
      privilegeRow.web_jobs_delete,
      privilegeRow.web_artifacts_insert,
      privilegeRow.web_artifacts_update,
      privilegeRow.web_artifacts_delete,
      privilegeRow.web_lifecycle_select,
      privilegeRow.worker_history_update,
      privilegeRow.worker_jobs_insert
    ];
    if (
      requiredPrivileges.some((value) => value !== true) ||
      forbiddenPrivileges.some((value) => value !== false)
    ) {
      throw new PostgresCutoverReadinessError();
    }
    const blockerRow = blockers.rows[0];
    if (
      !blockerRow || blockerRow.migration_lock_held || blockerRow.invalid_indexes !== 0 ||
      blockerRow.unvalidated_constraints !== 0 || blockerRow.unclaimable_jobs !== 0
    ) throw new PostgresCutoverReadinessError();
  } catch (error) {
    if (error instanceof PostgresCutoverReadinessError) throw error;
    throw new PostgresCutoverReadinessError();
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}
