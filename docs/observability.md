# Phase A observability

Stage 5.9.9C completes the production repository boundary built by 5.9.9A/5.9.9B. It does not install or require a collector, dashboard product, alert delivery service, or background evaluator. Web and worker expose internal loopback-only endpoints; public Nginx ingress rejects the exact internal root, its prefix, normalized/encoded variants, trailing slashes, and unsupported methods before generic proxying.

## Production configuration contract

`OBSERVABILITY_ENABLED=true` is required in production. `OBSERVABILITY_LOG_LEVEL` is one of `debug`, `info`, `warn`, or `error`; the production recommendation is `info`. `OBSERVABILITY_READINESS_TIMEOUT_MS` is bounded to 100–30000 ms and `OBSERVABILITY_METRICS_MAX_BYTES` to 4096–262144 bytes. Web keeps its established loopback origin and canonical `x-request-id` correlation contract.

Only the worker receives `WORKER_OBSERVABILITY_HOST` and `WORKER_OBSERVABILITY_PORT`. The host must be exactly `127.0.0.1` or `::1`; wildcard and non-loopback binds fail closed, and the port is an integer from 1 to 65535. Migration receives no listener, readiness, metrics-size, or storage-observability configuration and never starts web/worker/listeners. Fixed collector safety bounds are implementation contracts rather than operator inputs: a two-second overall collection budget, a one-second PostgreSQL statement/acquisition bound, a ten-second PostgreSQL cache, and a fifteen-second storage cache.

Release identity comes from verified build metadata (`releaseCommit` and `releaseId`) rather than arbitrary environment values. Importing configuration validates data only: it does not open a listener, create a database pool, read environment files, or touch storage. Environment templates contain placeholders, not credentials or deployment targets.

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

Runbook procedures are indexed in [Phase A operational runbooks](operations/runbooks.md). Operator integration is specified by the [vendor-neutral dashboard](operations/dashboard.md) and [journald operations](operations/journald.md). Alerts, dashboard queries, retention, scraping, and delivery remain operator-owned; no repository component provisions an external collector or provider.
