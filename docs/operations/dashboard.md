# Phase A vendor-neutral observability dashboard

This specification describes operator-owned queries only. The repository does not install a collector, dashboard product, alert evaluator, or delivery provider. Scrape the web and worker loopback endpoints every 15–30 seconds; never expose them through public ingress. Use the exact `processRole` and `releaseCommit` resource identity supplied by the host integration, not a user-controlled metric label.

Every panel below has a bounded operational purpose. Rate and increase calculations must handle process restarts. Histograms use cumulative buckets and a percentile or bucket calculation supported by the operator's chosen metrics system.

## Service status

- Metrics: `process_up`, `process_start_time_seconds`, `build_info`, `migration_compatible`.
- Aggregation: latest value by process role and exact release; show one expected web and one expected worker.
- Window: current value with a 15-minute release-change context.
- Unit: boolean, Unix seconds, and release identity.
- Normal: both roles are up and migration compatibility is `1`.
- Warning/critical: a missing scrape is warning; the matching unavailable or migration alert is critical.
- Runbook: [web-down](runbooks.md#web-down), [worker-down](runbooks.md#worker-down), [migration-mismatch](runbooks.md#migration-mismatch).

## Web requests: rate, errors, latency, and in-flight

- Metrics: `http_requests_total`, `http_responses_total`, `http_request_duration_seconds`, `http_in_flight`.
- Aggregation: request rate by allowlisted `route`/`method`/`outcome`, error ratio by fixed response `statusClass`, latency percentiles from histogram buckets, and sum in-flight.
- Window: 5 minutes, with a 1-hour comparison.
- Unit: requests/second, percent, seconds, requests.
- Normal: stable rate, low bounded error ratio, latency within the service objective, and in-flight below capacity.
- Warning/critical: sustained 5xx or latency is warning; loss of readiness/public availability is critical.
- Runbook: [web-down](runbooks.md#web-down), [nginx-5xx-internal-exposure](runbooks.md#nginx-5xx-internal-exposure).

## Queue depth and oldest queued job

- Metrics: `queue_depth`, `oldest_queued_job_age_seconds`, `running_jobs`.
- Aggregation: latest worker snapshot; compare depth with oldest age rather than summing process-local gauges.
- Window: current value and 30-minute trend.
- Unit: jobs and seconds.
- Normal: bounded depth that drains and oldest age below the warning threshold.
- Warning/critical: the corresponding warning means sustained backlog; treat growth with zero ready capacity as a traffic blocker.
- Runbook: [queue-backlog](runbooks.md#queue-backlog).

## Job outcomes

- Metrics: `jobs_submitted_total`, `jobs_completed_total`, `jobs_failed_total`, `jobs_cancelled_total`, `jobs_expired_total`.
- Aggregation: restart-aware increases and outcome ratios using only fixed `preset`/`reasonCategory` dimensions.
- Window: 15 minutes and 24 hours.
- Unit: jobs and percent.
- Normal: completion dominates terminal outcomes and failures do not trend upward.
- Warning/critical: the failure-rate warning requires diagnosis; systemic failure may require pausing submissions.
- Runbook: [ffmpeg-failure-spike](runbooks.md#ffmpeg-failure-spike), [retry-exhaustion](runbooks.md#retry-exhaustion).

## Job and stage duration

- Metrics: `job_duration_seconds`, `job_stage_duration_seconds`.
- Aggregation: percentile/bucket analysis by fixed `preset`, `stage`, and `outcome` only.
- Window: 15 minutes and 6 hours.
- Unit: seconds.
- Normal: stable percentile distribution for the approved media preset.
- Warning/critical: sustained stage inflation is warning; combine with backlog and dependency signals before stopping traffic.
- Runbook: [queue-backlog](runbooks.md#queue-backlog), [ffmpeg-failure-spike](runbooks.md#ffmpeg-failure-spike).

## Worker capacity and active jobs

- Metrics: `worker_available_slots`, `worker_active_jobs`, `active_jobs`, `ffmpeg_processes`, `worker_last_heartbeat_timestamp`.
- Aggregation: latest values from the single worker; derive heartbeat age from the current time.
- Window: current value and 30 minutes.
- Unit: slots, jobs, processes, seconds of age.
- Normal: capacity matches configured bounds, FFmpeg children do not exceed active work, and heartbeat is fresh.
- Warning/critical: sustained zero capacity with a backlog is warning; absent worker readiness is critical.
- Runbook: [worker-down](runbooks.md#worker-down).

## Retry exhaustion and stale leases

- Metrics: `jobs_retried_total`, `retry_exhausted_total`, `stale_leases`, `recovery_actions_total`.
- Aggregation: restart-aware increases for counters and latest stale gauge; fixed reason/operation/outcome dimensions only.
- Window: 15 minutes and 2 hours.
- Unit: jobs and actions.
- Normal: no exhausted retries or stale leases; bounded recovery converges.
- Warning/critical: either alert is warning; increasing stale leases with missing maintenance leadership blocks new work.
- Runbook: [retry-exhaustion](runbooks.md#retry-exhaustion), [stale-leases-jobs](runbooks.md#stale-leases-jobs).

## PostgreSQL availability and pool

- Metrics: `db_up`, `db_pool_active`, `db_pool_idle`, `db_pool_waiting`, `db_query_failures_total`, `migration_compatible`.
- Aggregation: latest gauges and restart-aware failure increase; never display connection strings or SQL.
- Window: current value and 30 minutes.
- Unit: boolean, connections, failures.
- Normal: DB and migration gauges are `1`, with no sustained waiters.
- Warning/critical: pool saturation is warning; database or migration unavailability is critical.
- Runbook: [postgresql-unavailable](runbooks.md#postgresql-unavailable), [migration-mismatch](runbooks.md#migration-mismatch).

## Durable storage capacity, read-only state, and marker

- Metrics: `storage_up`, `storage_read_only`, `storage_marker_valid`, `storage_free_bytes`, `storage_free_inodes`.
- Aggregation: latest cached values from the worker; do not sum capacity gauges.
- Window: current value and 7-day capacity trend.
- Unit: boolean, bytes, inodes.
- Normal: storage and marker are `1`, read-only is `0`, and capacity stays above warning headroom.
- Warning/critical: warning/critical capacity thresholds use the alert catalog; unavailable/read-only storage is critical.
- Runbook: [storage-unavailable-read-only](runbooks.md#storage-unavailable-read-only), [disk-inode-low](runbooks.md#disk-inode-low).

## Cleanup, reconciliation, and recovery

- Metrics: `cleanup_failures_total`, `reconciliation_failures_total`, `cleanup_last_success_timestamp`, `maintenance_leader`, `maintenance_last_success_timestamp`, `recovery_actions_total`, `orphan_artifacts`.
- Aggregation: restart-aware failure/action increases and age from latest success timestamps.
- Window: 30 minutes and 24 hours.
- Unit: failures, actions, artifacts, seconds of age.
- Normal: exactly one leader, recent success, and no rising failure/orphan signal.
- Warning/critical: stale or failed maintenance is warning; missing leadership beyond its page duration is critical.
- Runbook: [maintenance-leader-missing](runbooks.md#maintenance-leader-missing), [cleanup-reconciliation-failure](runbooks.md#cleanup-reconciliation-failure).

## Release and build information

- Metrics: `build_info`, `process_start_time_seconds`, `process_up`.
- Aggregation: latest exact release identity per role; flag simultaneous unexpected release identities.
- Window: current value and deployment window.
- Unit: release identity and Unix seconds.
- Normal: web and worker match the approved exact commit and release ID.
- Warning/critical: unexpected or mixed identity blocks promotion; loss of a process follows its availability severity.
- Runbook: [release-rollback](runbooks.md#release-rollback), [migration-mismatch](runbooks.md#migration-mismatch).

## No-egress smoke

- Metrics: operator signal `operator_no_egress_smoke_success` tied to the exact release.
- Aggregation: latest approved CI/operator evidence; never infer it from application traffic.
- Window: current release promotion window.
- Unit: boolean.
- Normal: `1` for the exact commit under promotion.
- Warning/critical: missing evidence blocks promotion; explicit failure is critical.
- Runbook: [no-egress-smoke-failure](runbooks.md#no-egress-smoke-failure).

## Alert state

- Metrics: the signals referenced by `lib/observability/alert-rules.ts` plus operator-owned alert evaluation state.
- Aggregation: count firing alerts by allowlisted severity and alert name; do not add job/user dimensions.
- Window: current state and 24-hour transition history.
- Unit: alerts and duration.
- Normal: no firing page alerts and explained bounded warnings.
- Warning/critical: use the catalog severity; a silence or missing metrics is never evidence of recovery.
- Runbook: follow each alert's `runbookSlug`; use [observability-endpoint-failure](runbooks.md#observability-endpoint-failure) when evaluation lacks scrape data.
