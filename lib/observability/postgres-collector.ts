import "server-only";
import type { Pool, PoolClient } from "pg";
import { assertPostgresSchemaCompatible } from "@/lib/jobs/postgres/schema-readiness";
import type { MetricsCollector } from "@/lib/observability/collectors";
import { classifyError } from "@/lib/observability/redaction";
import type { OperationalSignals } from "@/lib/observability/signals";
import { safeSignalMetric } from "@/lib/observability/signals";

type QueueRow = Readonly<{
  queued: string | number;
  oldest_queued_age_seconds: string | number | null;
  running: string | number;
  stale_leases: string | number;
}>;

type CheckpointRow = Readonly<{
  last_recovery_at: Date | string | null;
  last_reconciliation_at: Date | string | null;
  last_expiration_at: Date | string | null;
}>;

const SNAPSHOT_SQL = `
  SELECT
    (SELECT count(*) FROM media_jobs WHERE status = 'queued') AS queued,
    COALESCE((
      SELECT EXTRACT(EPOCH FROM (statement_timestamp() - created_at))
      FROM media_jobs
      WHERE status = 'queued'
        AND cancellation_requested_at IS NULL
        AND expires_at IS NULL
        AND source_url IS NOT NULL
        AND format_id IS NOT NULL
      ORDER BY available_at, created_at, job_id
      LIMIT 1
    ), 0) AS oldest_queued_age_seconds,
    (SELECT count(*) FROM media_jobs WHERE status = 'running') AS running,
    (SELECT count(*) FROM media_jobs
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= statement_timestamp()) AS stale_leases
`;

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000_000) {
    throw new TypeError("PostgreSQL metrics count is invalid.");
  }
  return parsed;
}

function seconds(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 604_800) {
    throw new TypeError("PostgreSQL metrics age is invalid.");
  }
  return parsed;
}

function unixTimestamp(value: Date | string | null): number | undefined {
  if (value === null) return undefined;
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 1_000 : undefined;
}

export function createPostgresMetricsCollector(options: Readonly<{
  pool: Pool;
  signals: OperationalSignals;
  cacheTtlMs?: number;
  now?: () => number;
}>): MetricsCollector {
  if (!options.pool || typeof options.pool.connect !== "function") {
    throw new TypeError("PostgreSQL metrics collector requires a pool.");
  }
  const cacheTtlMs = options.cacheTtlMs ?? 10_000;
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 1_000 || cacheTtlMs > 60_000) {
    throw new TypeError("PostgreSQL metrics cache TTL is invalid.");
  }
  const now = options.now ?? Date.now;
  let lastCollectedAt = 0;
  let inFlight: Promise<void> | null = null;
  let lastUp: boolean | null = null;
  let lastCompatible: boolean | null = null;
  let poolExhausted = false;

  function poolState(up: boolean, migrationCompatible: boolean): void {
    const active = Math.max(0, options.pool.totalCount - options.pool.idleCount);
    safeSignalMetric(() => options.signals.metrics.setPoolSnapshot({
      up,
      active,
      idle: options.pool.idleCount,
      waiting: options.pool.waitingCount,
      migrationCompatible
    }));
    const exhausted = options.pool.waitingCount > 0;
    if (exhausted && !poolExhausted) {
      options.signals.emit("warn", "db.pool.exhausted", {
        outcome: "failure",
        reasonCode: "pool_exhausted",
        errorCategory: "database"
      });
    }
    poolExhausted = exhausted;
  }

  async function execute(): Promise<void> {
    let client: PoolClient | null = null;
    let transaction = false;
    let destroyClient = false;
    try {
      poolState(lastUp === true, lastCompatible === true);
      client = await options.pool.connect();
      await client.query("BEGIN READ ONLY");
      transaction = true;
      await client.query("SET LOCAL statement_timeout = '1000ms'");
      const result = await client.query<QueueRow>(SNAPSHOT_SQL);
      const row = result.rows[0];
      if (!row) throw new TypeError("PostgreSQL metrics snapshot is missing.");
      const checkpoint = await client.query<CheckpointRow>(
        `SELECT last_recovery_at, last_reconciliation_at, last_expiration_at
         FROM media_lifecycle_state WHERE singleton_key = 1`
      );
      await assertPostgresSchemaCompatible(client as unknown as Pool);
      await client.query("COMMIT");
      transaction = false;
      safeSignalMetric(() => options.signals.metrics.setQueueSnapshot({
        queued: count(row.queued),
        oldestQueuedAgeSeconds: seconds(row.oldest_queued_age_seconds),
        running: count(row.running),
        staleLeases: count(row.stale_leases)
      }));
      const checkpointRow = checkpoint.rows[0];
      if (checkpointRow) {
        safeSignalMetric(() => options.signals.metrics.setMaintenanceSnapshot({
          recovery: unixTimestamp(checkpointRow.last_recovery_at),
          reconciliation: unixTimestamp(checkpointRow.last_reconciliation_at),
          cleanup: unixTimestamp(checkpointRow.last_expiration_at),
          expiration: unixTimestamp(checkpointRow.last_expiration_at)
        }));
      }
      poolState(true, true);
      if (lastUp !== true) {
        options.signals.emit("info", "db.connected", { outcome: "success", reasonCode: "none" });
      }
      if (lastCompatible !== true) {
        options.signals.emit("info", "migration.status", { outcome: "success", reasonCode: "none" });
      }
      lastUp = true;
      lastCompatible = true;
      lastCollectedAt = now();
    } catch (error) {
      if (transaction) {
        await client?.query("ROLLBACK").catch(() => { destroyClient = true; });
      }
      const classified = classifyError(error);
      const migrationMismatch = classified.category === "migration";
      poolState(migrationMismatch, false);
      safeSignalMetric(() => options.signals.metrics.databaseQueryFailure(
        migrationMismatch ? "migration" : classified.category === "timeout" ? "timeout" : "database"
      ));
      if (migrationMismatch) {
        if (lastCompatible !== false) {
          options.signals.emit("error", "migration.mismatch", {
            outcome: "failure",
            reasonCode: "schema_mismatch",
            errorCategory: "migration"
          });
        }
        lastUp = true;
        lastCompatible = false;
      } else {
        if (lastUp !== false) {
          options.signals.emit("warn", "db.unavailable", {
            outcome: "failure",
            reasonCode: "database_unavailable",
            errorCategory: "database"
          });
          options.signals.emit("warn", "db.query.failed", {
            outcome: "failure",
            reasonCode: classified.reasonCode === "readiness_timeout" ? "readiness_timeout" : "database_unavailable",
            errorCategory: classified.category === "timeout" ? "timeout" : "database"
          });
        }
        lastUp = false;
      }
      lastCollectedAt = now();
    } finally {
      client?.release(destroyClient);
    }
  }

  return Object.freeze({
    name: "postgres",
    collect() {
      if (lastCollectedAt > 0 && now() - lastCollectedAt < cacheTtlMs) {
        poolState(lastUp === true, lastCompatible === true);
        return Promise.resolve();
      }
      if (!inFlight) inFlight = execute().finally(() => { inFlight = null; });
      return inFlight;
    }
  });
}
