import "server-only";

export const APPLICATION_ALERT_METRICS = Object.freeze([
  "process_up",
  "db_up",
  "storage_up",
  "storage_read_only",
  "storage_free_bytes",
  "storage_free_inodes",
  "migration_compatible",
  "maintenance_leader",
  "maintenance_last_success_timestamp",
  "queue_depth",
  "oldest_queued_job_age_seconds",
  "jobs_failed_total",
  "jobs_submitted_total",
  "http_requests_total",
  "retry_exhausted_total",
  "stale_leases",
  "cleanup_failures_total",
  "reconciliation_failures_total",
  "artifact_publication_failures_total",
  "db_pool_waiting",
  "worker_processing_failures_total"
] as const);

export const OPERATOR_ALERT_SIGNALS = Object.freeze([
  "operator_no_egress_smoke_success",
  "operator_process_restarts_total"
] as const);

export type AlertSeverity = "page" | "warning";
export type AlertAggregation = "value" | "increase" | "rate" | "ratio" | "age";
export type AlertComparator = "lt" | "lte" | "gt" | "gte" | "eq";

export type AlertRuleDefinition = Readonly<{
  name: string;
  severity: AlertSeverity;
  signal: (typeof APPLICATION_ALERT_METRICS)[number] | (typeof OPERATOR_ALERT_SIGNALS)[number];
  denominator?: (typeof APPLICATION_ALERT_METRICS)[number];
  aggregation: AlertAggregation;
  comparator: AlertComparator;
  defaultThreshold: number;
  durationSeconds: number;
  recoveryCondition: string;
  runbookSlug: string;
  overrideBounds: Readonly<{ minimum: number; maximum: number }>;
  rationale: string;
}>;

const GiB = 1024 ** 3;

const RULE_DEFINITIONS = [
  { name: "WebUnavailable", severity: "page", signal: "process_up", aggregation: "value", comparator: "lt", defaultThreshold: 1, durationSeconds: 120, recoveryCondition: "web process_up equals 1 for two minutes", runbookSlug: "web-down", overrideBounds: { minimum: 0, maximum: 1 }, rationale: "Public traffic has no healthy web process." },
  { name: "WorkerUnavailable", severity: "page", signal: "process_up", aggregation: "value", comparator: "lt", defaultThreshold: 1, durationSeconds: 300, recoveryCondition: "worker process_up equals 1 and readiness succeeds", runbookSlug: "worker-down", overrideBounds: { minimum: 0, maximum: 1 }, rationale: "Queued work cannot progress." },
  { name: "PostgreSQLUnavailable", severity: "page", signal: "db_up", aggregation: "value", comparator: "lt", defaultThreshold: 1, durationSeconds: 120, recoveryCondition: "db_up equals 1 for two minutes", runbookSlug: "postgresql-unavailable", overrideBounds: { minimum: 0, maximum: 1 }, rationale: "Both request persistence and worker coordination require PostgreSQL." },
  { name: "DurableVolumeUnavailable", severity: "page", signal: "storage_up", aggregation: "value", comparator: "lt", defaultThreshold: 1, durationSeconds: 120, recoveryCondition: "storage_up equals 1 and marker is valid", runbookSlug: "storage-unavailable-read-only", overrideBounds: { minimum: 0, maximum: 1 }, rationale: "Media processing and file delivery require the durable volume." },
  { name: "DurableVolumeReadOnly", severity: "page", signal: "storage_read_only", aggregation: "value", comparator: "gte", defaultThreshold: 1, durationSeconds: 120, recoveryCondition: "storage_read_only equals 0 for two minutes", runbookSlug: "storage-unavailable-read-only", overrideBounds: { minimum: 0, maximum: 1 }, rationale: "The worker cannot publish or clean artifacts." },
  { name: "MigrationIncompatible", severity: "page", signal: "migration_compatible", aggregation: "value", comparator: "lt", defaultThreshold: 1, durationSeconds: 60, recoveryCondition: "migration_compatible equals 1 after an exact catalog check", runbookSlug: "migration-mismatch", overrideBounds: { minimum: 0, maximum: 1 }, rationale: "The running release and database catalog disagree." },
  { name: "MaintenanceLeaderMissing", severity: "page", signal: "maintenance_leader", aggregation: "value", comparator: "lt", defaultThreshold: 1, durationSeconds: 600, recoveryCondition: "exactly one worker reports maintenance_leader equals 1", runbookSlug: "maintenance-leader-missing", overrideBounds: { minimum: 0, maximum: 1 }, rationale: "Recovery and reconciliation cannot make progress without the elected authority." },
  { name: "NoEgressSmokeFailed", severity: "page", signal: "operator_no_egress_smoke_success", aggregation: "value", comparator: "lt", defaultThreshold: 1, durationSeconds: 60, recoveryCondition: "the exact-release no-egress smoke succeeds", runbookSlug: "no-egress-smoke-failure", overrideBounds: { minimum: 0, maximum: 1 }, rationale: "The release safety smoke no longer validates its egress boundary." },
  { name: "DiskSpaceCritical", severity: "page", signal: "storage_free_bytes", aggregation: "value", comparator: "lt", defaultThreshold: 5 * GiB, durationSeconds: 300, recoveryCondition: "free bytes exceed the operator critical threshold plus headroom", runbookSlug: "disk-inode-low", overrideBounds: { minimum: GiB, maximum: 100 * GiB }, rationale: "Publication can fail or strand attempts when capacity is exhausted." },
  { name: "InodesCritical", severity: "page", signal: "storage_free_inodes", aggregation: "value", comparator: "lt", defaultThreshold: 10_000, durationSeconds: 300, recoveryCondition: "free inodes exceed the critical threshold plus headroom", runbookSlug: "disk-inode-low", overrideBounds: { minimum: 1_000, maximum: 1_000_000 }, rationale: "Free bytes do not protect against inode exhaustion." },
  { name: "QueueDepthHigh", severity: "warning", signal: "queue_depth", aggregation: "value", comparator: "gt", defaultThreshold: 100, durationSeconds: 600, recoveryCondition: "queue depth remains below the warning threshold for ten minutes", runbookSlug: "queue-backlog", overrideBounds: { minimum: 10, maximum: 10_000 }, rationale: "Sustained backlog indicates insufficient throughput or dependency degradation." },
  { name: "OldestQueuedJobTooOld", severity: "warning", signal: "oldest_queued_job_age_seconds", aggregation: "value", comparator: "gt", defaultThreshold: 900, durationSeconds: 300, recoveryCondition: "oldest queued age stays below threshold for five minutes", runbookSlug: "queue-backlog", overrideBounds: { minimum: 120, maximum: 7_200 }, rationale: "A single old job can reveal starvation even at low queue depth." },
  { name: "JobFailureRateHigh", severity: "warning", signal: "jobs_failed_total", denominator: "jobs_submitted_total", aggregation: "ratio", comparator: "gt", defaultThreshold: 0.2, durationSeconds: 600, recoveryCondition: "ten-minute failure ratio remains below threshold", runbookSlug: "ffmpeg-failure-spike", overrideBounds: { minimum: 0.01, maximum: 1 }, rationale: "A sustained terminal failure ratio merits diagnosis." },
  { name: "RetryExhaustion", severity: "warning", signal: "retry_exhausted_total", aggregation: "increase", comparator: "gt", defaultThreshold: 0, durationSeconds: 300, recoveryCondition: "no retry exhaustion occurs for the configured window", runbookSlug: "retry-exhaustion", overrideBounds: { minimum: 0, maximum: 100 }, rationale: "Exhausted jobs indicate repeated attempt failure." },
  { name: "StaleLeases", severity: "warning", signal: "stale_leases", aggregation: "value", comparator: "gt", defaultThreshold: 0, durationSeconds: 300, recoveryCondition: "stale_leases equals 0 after recovery", runbookSlug: "stale-leases-jobs", overrideBounds: { minimum: 0, maximum: 100 }, rationale: "Expired running leases should be recovered promptly." },
  { name: "MaintenanceStale", severity: "warning", signal: "maintenance_last_success_timestamp", aggregation: "age", comparator: "gt", defaultThreshold: 1_800, durationSeconds: 300, recoveryCondition: "all required maintenance operations complete within the window", runbookSlug: "cleanup-reconciliation-failure", overrideBounds: { minimum: 300, maximum: 14_400 }, rationale: "Leadership alone does not prove successful maintenance." },
  { name: "CleanupFailures", severity: "warning", signal: "cleanup_failures_total", aggregation: "increase", comparator: "gt", defaultThreshold: 0, durationSeconds: 300, recoveryCondition: "a complete cleanup succeeds with no new failures", runbookSlug: "cleanup-reconciliation-failure", overrideBounds: { minimum: 0, maximum: 100 }, rationale: "Retention failures consume durable capacity." },
  { name: "ReconciliationFailures", severity: "warning", signal: "reconciliation_failures_total", aggregation: "increase", comparator: "gt", defaultThreshold: 0, durationSeconds: 300, recoveryCondition: "a complete reconciliation succeeds with no new failures", runbookSlug: "cleanup-reconciliation-failure", overrideBounds: { minimum: 0, maximum: 100 }, rationale: "Registry and durable objects can diverge without reconciliation." },
  { name: "ArtifactPublicationFailures", severity: "warning", signal: "artifact_publication_failures_total", aggregation: "increase", comparator: "gt", defaultThreshold: 0, durationSeconds: 300, recoveryCondition: "no publication failures occur for the configured window", runbookSlug: "artifact-publication-failure", overrideBounds: { minimum: 0, maximum: 100 }, rationale: "Processed media is unusable until immutable publication succeeds." },
  { name: "PostgreSQLPoolSaturation", severity: "warning", signal: "db_pool_waiting", aggregation: "value", comparator: "gt", defaultThreshold: 0, durationSeconds: 300, recoveryCondition: "db_pool_waiting equals 0 for five minutes", runbookSlug: "postgresql-unavailable", overrideBounds: { minimum: 0, maximum: 100 }, rationale: "Sustained waiters increase request and lease risk." },
  { name: "WorkerRestartLoop", severity: "warning", signal: "operator_process_restarts_total", aggregation: "increase", comparator: "gt", defaultThreshold: 3, durationSeconds: 600, recoveryCondition: "fewer than the threshold restarts occur for fifteen minutes", runbookSlug: "worker-down", overrideBounds: { minimum: 1, maximum: 20 }, rationale: "Host supervision is the authority for restart counts." },
  { name: "FFmpegFailureRateHigh", severity: "warning", signal: "worker_processing_failures_total", aggregation: "rate", comparator: "gt", defaultThreshold: 0.1, durationSeconds: 600, recoveryCondition: "ten-minute FFmpeg failure rate remains below threshold", runbookSlug: "ffmpeg-failure-spike", overrideBounds: { minimum: 0.01, maximum: 10 }, rationale: "Media tool failures can indicate bad release binaries or media drift." },
  { name: "DiskSpaceWarning", severity: "warning", signal: "storage_free_bytes", aggregation: "value", comparator: "lt", defaultThreshold: 20 * GiB, durationSeconds: 600, recoveryCondition: "free bytes exceed the warning threshold plus headroom", runbookSlug: "disk-inode-low", overrideBounds: { minimum: 2 * GiB, maximum: 500 * GiB }, rationale: "Early capacity warning leaves time for safe operator action." },
  { name: "InodesWarning", severity: "warning", signal: "storage_free_inodes", aggregation: "value", comparator: "lt", defaultThreshold: 50_000, durationSeconds: 600, recoveryCondition: "free inodes exceed the warning threshold plus headroom", runbookSlug: "disk-inode-low", overrideBounds: { minimum: 5_000, maximum: 5_000_000 }, rationale: "Inode pressure can precede byte exhaustion." }
] satisfies readonly AlertRuleDefinition[];

export const ALERT_RULES: readonly AlertRuleDefinition[] = Object.freeze(
  RULE_DEFINITIONS.map((rule) => Object.freeze({ ...rule, overrideBounds: Object.freeze(rule.overrideBounds) }))
);

export function validateAlertRules(rules: readonly AlertRuleDefinition[] = ALERT_RULES): void {
  const names = new Set<string>();
  const signals = new Set<string>([...APPLICATION_ALERT_METRICS, ...OPERATOR_ALERT_SIGNALS]);
  const applicationMetrics = new Set<string>(APPLICATION_ALERT_METRICS);
  for (const rule of rules) {
    if (!/^[A-Z][A-Za-z0-9]{2,63}$/.test(rule.name) || names.has(rule.name)) throw new TypeError("Alert name is invalid or duplicated.");
    names.add(rule.name);
    if (rule.severity !== "page" && rule.severity !== "warning") throw new TypeError("Alert severity is invalid.");
    if (!signals.has(rule.signal) || (rule.denominator !== undefined && !applicationMetrics.has(rule.denominator))) throw new TypeError("Alert signal is unsupported.");
    if (rule.aggregation === "ratio" && !rule.denominator) throw new TypeError("Ratio alerts require a denominator.");
    if (rule.aggregation !== "ratio" && rule.denominator) throw new TypeError("Only ratio alerts may define a denominator.");
    if (!Number.isFinite(rule.defaultThreshold) || rule.defaultThreshold < 0) throw new TypeError("Alert threshold is invalid.");
    if (!Number.isSafeInteger(rule.durationSeconds) || rule.durationSeconds <= 0 || rule.durationSeconds > 86_400) throw new TypeError("Alert duration is invalid.");
    if (!Number.isFinite(rule.overrideBounds.minimum) || !Number.isFinite(rule.overrideBounds.maximum) || rule.overrideBounds.minimum < 0 || rule.overrideBounds.maximum < rule.overrideBounds.minimum || rule.defaultThreshold < rule.overrideBounds.minimum || rule.defaultThreshold > rule.overrideBounds.maximum) throw new TypeError("Alert override bounds are invalid.");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.runbookSlug)) throw new TypeError("Alert runbook slug is invalid.");
    if (!rule.recoveryCondition || rule.recoveryCondition.length > 180 || !rule.rationale || rule.rationale.length > 180) throw new TypeError("Alert documentation is invalid.");
  }
}

export function validateAlertThresholdOverrides(
  overrides: Readonly<Record<string, number>>,
  rules: readonly AlertRuleDefinition[] = ALERT_RULES
): Readonly<Record<string, number>> {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("Alert overrides are invalid.");
  }
  const definitions = new Map(rules.map((rule) => [rule.name, rule]));
  const normalized: Record<string, number> = {};
  for (const [name, value] of Object.entries(overrides)) {
    const rule = definitions.get(name);
    if (!rule) throw new TypeError("Alert override name is unknown.");
    if (!Number.isFinite(value) || value < rule.overrideBounds.minimum || value > rule.overrideBounds.maximum) {
      throw new TypeError("Alert override is outside its bounded range.");
    }
    normalized[name] = value;
  }
  return Object.freeze(normalized);
}
