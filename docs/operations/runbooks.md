# Phase A operational runbooks

All commands below are placeholders for the operator's approved read-only tooling. Never paste credentials, environment files, URLs, payloads, paths, SQL text, or raw FFmpeg stderr into incidents. Stop traffic or workers through the existing deployment runbook; this document does not authorize deployment, destructive storage actions, schema mutation, or forced recovery.

## web-down

Symptoms: web `process_up`/readiness fails or Nginx returns 5xx. Evidence: release/process events, internal probes and Nginx host logs. Safe read-only checks: service status, loopback probes and DB/storage gauges. Traffic decision: stop admission while readiness is false. Worker action: leave a healthy worker running unless submissions have been stopped by policy. Web action: use only the approved graceful service procedure. DB action: inspect health; do not migrate. Storage action: inspect marker/readability only. Rollback: only to an exact known-good release when release evidence supports it. Verification: liveness, readiness and a safe API smoke. Escalation: provide release ID and sanitized events.

## worker-down

Symptoms: worker process/readiness absent, capacity zero or queue age grows. Evidence: process events, loopback probes and host restart count. Safe read-only checks: service status, readiness category, DB/storage/tool availability. Traffic decision: pause new submissions when backlog policy requires. Worker action: use only normal graceful recovery; never bypass lease fencing. Web action: keep reads available only while backlog policy allows. DB action: inspect pool/lease gauges without mutation. Storage action: inspect marker/capacity. Rollback: only for an exact release regression. Verification: one leader, restored capacity and a disposable job. Escalation: send aggregate queue/stage evidence.

## postgresql-unavailable

Symptoms: `db_up=0`, readiness false, pool waiters or `db.*` events. Evidence: bounded DB/pool metrics and reason categories. Safe read-only checks: network/TLS reachability and database service health without printing connection strings. Traffic decision: fail closed and stop new work. Worker action: allow graceful lease safety behavior; do not edit leases. Web action: keep unready. DB action: diagnose service/pool; do not mutate schema. Storage action: none beyond confirming it is not a second fault. Rollback: only when exact-release compatibility evidence identifies a regression. Verification: migration compatibility and both readiness probes. Escalation: DB operations with sanitized timestamps/categories.

## storage-unavailable-read-only

Symptoms: `storage_up=0`, marker invalid or `storage_read_only=1`. Evidence: storage metrics and sanitized storage/maintenance events. Safe read-only checks: mount presence, permissions, marker identity, bytes and inodes. Traffic decision: stop submissions. Worker action: stop claims through normal readiness behavior. Web action: keep file traffic unready when published storage is unreadable. DB action: leave state unchanged. Storage action: never recreate a marker or delete artifacts during diagnosis. Rollback: normally inapplicable to a host volume fault. Verification: marker, readable published data and writable worker readiness. Escalation: storage operations.

## queue-backlog

Symptoms: queue depth or oldest age remains high. Evidence: queue, capacity, stage duration and retry metrics. Safe read-only checks: worker readiness, DB pool and dependency status. Traffic decision: continue only within the backlog budget. Worker action: preserve configured concurrency/FIFO. Web action: pause submissions if the budget is exceeded. DB action: do not reorder rows or alter retry timing. Storage action: confirm capacity. Rollback: only for a demonstrated throughput regression. Verification: oldest age falls for two scrape windows. Escalation: aggregate counts only.

## stale-leases-jobs

Symptoms: `stale_leases>0`, retry scheduling or lease-loss events. Evidence: stale count and recovery/leadership events. Safe read-only checks: one leader, DB health and checkpoint age. Traffic decision: pause submissions if stale count grows. Worker action: let elected bounded recovery act. Web action: no direct job mutation. DB action: never claim, renew or edit leases manually. Storage action: confirm reconciliation is not blocked. Rollback: generally inapplicable. Verification: stale count reaches zero and jobs become queued/terminal. Escalation: omit lease identities.

## retry-exhaustion

Symptoms: `retry_exhausted_total` increases. Evidence: sanitized reason categories and stage metrics. Safe read-only checks: dependency readiness and release comparison. Traffic decision: pause submissions for systemic failures. Worker action: do not increase max retries. Web action: retain healthy reads only. DB action: do not requeue/edit jobs. Storage action: inspect capacity when publication-related. Rollback: only for a proven release regression. Verification: safe disposable job and stable counter. Escalation: owning dependency/team.

## maintenance-leader-missing

Symptoms: no `maintenance_leader=1` beyond the alert duration. Evidence: leadership events and checkpoint age. Safe read-only checks: worker/DB readiness and advisory-lock visibility. Traffic decision: pause submissions if maintenance staleness threatens safety/capacity. Worker action: recover the existing worker gracefully; never start a second authority. Web action: no mutation. DB action: do not clear locks manually. Storage action: confirm availability. Rollback: only for a proven election regression. Verification: exactly one leader and fresh recovery checkpoint. Escalation: worker/DB operations.

## cleanup-reconciliation-failure

Symptoms: failure counters rise or last success is stale. Evidence: bounded reports, failure categories and leadership. Safe read-only checks: DB/storage readiness and checkpoint age. Traffic decision: pause submissions if capacity/safety is threatened. Worker action: do not start concurrent maintenance. Web action: no maintenance endpoint exists. DB action: inspect only. Storage action: never delete during diagnosis. Rollback: only for a proven release regression. Verification: one complete elected operation and fresh timestamp. Escalation: aggregate counts only.

## disk-inode-low

Symptoms: free byte/inode warning or critical alert. Evidence: cached `statfs` gauges and maintenance status. Safe read-only checks: host capacity and mount health. Traffic decision: at critical level stop submissions. Worker action: stop claims through readiness policy. Web action: keep delivery only if safe/readable. DB action: no mutation. Storage action: do not recursively scan or delete ad hoc; use approved capacity/retention procedure. Rollback: inapplicable. Verification: restored headroom and successful maintenance. Escalation: host/storage operations.

## ffmpeg-failure-spike

Symptoms: worker processing or transcode/probe failures rise. Evidence: stage, preset, bounded exit category and release ID. Safe read-only checks: tool availability/version and sanitized events; never collect commands, paths, URLs or stderr. Traffic decision: pause affected submissions if systemic. Worker action: keep concurrency/presets unchanged. Web action: reject new work when paused. DB action: no mutation. Storage action: confirm capacity only. Rollback: only if exact-release comparison proves regression. Verification: safe fixture and readiness. Escalation: media/release owners.

## artifact-publication-failure

Symptoms: publication failures rise after processing. Evidence: publication events, storage and reconciliation metrics. Safe read-only checks: marker, capacity and DB/storage readiness. Traffic decision: stop submissions if failures persist. Worker action: allow graceful attempt cleanup only. Web action: do not expose incomplete files. DB action: never mark artifacts published manually. Storage action: never move files manually. Rollback: only for a proven publication regression. Verification: safe immutable publication and reconciliation success. Escalation: storage/worker owners.

## no-egress-smoke-failure

Symptoms: operator no-egress signal fails for the exact release. Evidence: exact-commit smoke conclusion and sanitized stage. Safe read-only checks: release identity and failed smoke logs. Traffic decision: stop promotion/traffic changes. Worker action: none. Web action: none. DB action: none. Storage action: none. Rollback: retain/return to the last accepted release if traffic is affected. Verification: same exact-commit approved smoke. Escalation: release/security owners; never enable egress to pass.

## migration-mismatch

Symptoms: `migration_compatible=0`, readiness false and `migration.mismatch`. Evidence: exact release commit and read-only migration status. Safe read-only checks: catalog versions/checksums through canonical tooling. Traffic decision: stop traffic. Worker action: stop through normal service control. Web action: remain unready. DB action: do not apply/edit migrations during diagnosis. Storage action: none. Rollback: only to a release compatible with the installed catalog under the deployment runbook. Verification: exact compatibility and both readiness probes. Escalation: release/DB owners.
