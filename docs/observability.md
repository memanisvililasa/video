# Phase A observability

Stage 5.9.9B extends the process-local 5.9.9A registry and structured logger. It does not install or require a collector, dashboard, alert delivery service, or background evaluator. Web and worker expose the same internal, loopback-only endpoints established in 5.9.9A; public Nginx ingress does not proxy them.

## Event catalog

Lifecycle events are `job.queued`, `job.claimed`, `job.lease_lost`, debug-only `job.progress`, `job.retry_scheduled`, `job.retry_exhausted`, `job.completed`, `job.failed`, `job.cancelled`, and `job.expired`. Worker stages use `download.*`, `probe.*`, `transcode.*`, and `artifact.staged|published|publication_failed`. The elected coordinator emits `lifecycle.leader_*`, `recovery.*`, `reconciliation.*`, and `cleanup.*`.

Every record uses schema `1.0` and the 5.9.9A redaction boundary. Public job ID is correlation only. Lease owner/token, request ID, source URL, payload, SQL, path, command and raw stderr never become metric labels or event metadata. Heartbeats and progress are metrics/debug signals, not info-level polling logs.

## Metric catalog and semantics

Event-driven counters and histograms are process-local and reset on process restart: `jobs_*_total`, `retry_exhausted_total`, `job*_duration_seconds`, `worker_processing_failures_total`, `download_bytes_total`, `artifact_publication_failures_total`, `db_query_failures_total`, `reconciliation_failures_total`, `cleanup_failures_total`, and `recovery_actions_total`. They are operational observations, not historical database truth.

Snapshot gauges are refreshed read-only: `db_up`, pool gauges, `migration_compatible`, `active_jobs`, `queue_depth`, `oldest_queued_job_age_seconds`, `running_jobs`, `stale_leases`, `storage_*`, plus lifecycle checkpoint/leadership gauges. Worker capacity and FFmpeg gauges describe only the worker process that serves the endpoint. `orphan_artifacts` is the bounded discovery count from the last completed reconciliation, never a scrape-time tree scan.

PostgreSQL collection uses fixed SQL in a read-only transaction with a one-second statement timeout and existing status/claim/expired-lease indexes. Storage collection performs marker validation, access checks and one `statfs`; it never traverses or mutates the durable tree. Collectors are single-flight, have a two-second endpoint budget, a ten-second DB cache and a fifteen-second storage cache. A failed collector leaves liveness independent and returns bounded partial metrics.

For a single host, scrape web and worker loopback endpoints every 15–30 seconds with a client timeout below two seconds. There is no cross-process aggregation or persistent metric store in Phase A. Multi-host aggregation, tracing and collector deployment remain Phase B/operator work.

## Alerts

`lib/observability/alert-rules.ts` is an inert, vendor-neutral catalog. Thresholds and durations are conservative defaults; threshold overrides are accepted only inside each rule's validated operator bounds. The application does not evaluate rules or deliver pages. Host restart counts and the no-egress smoke result remain explicit operator-provided signals.

Runbook procedures are indexed in [Phase A operational runbooks](operations/runbooks.md).
