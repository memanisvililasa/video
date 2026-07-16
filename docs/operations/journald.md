# Phase A journald operations

The application emits bounded, line-oriented JSON only to stdout/stderr. Production systemd units route both streams to journald; the application does not create log files. Rotation, retention, rate limiting, access control, forwarding, and capacity are host-operator responsibilities. The recommended normal level is `OBSERVABILITY_LOG_LEVEL=info`; use `debug` only for a bounded approved diagnostic window.

Each application record is one JSON object on one physical line. Control characters and embedded newlines are escaped, and oversized metadata is rejected or bounded before emission. Expected common fields include `schemaVersion`, `timestamp`, `level`, `event`, `processRole`, `service`, `releaseCommit`, and `releaseId`. Correlation may use `requestId` and `publicJobId`, but neither is a metric label or authority token.

Safe read-only examples use placeholder unit names and never print environment files:

```bash
journalctl --unit 'videosave-<role>.service' --since '15 minutes ago' --output cat --no-pager
journalctl --unit 'videosave-<role>.service' --since '15 minutes ago' --output cat --no-pager | jq -c 'select(.event == "process.ready")'
journalctl --unit 'videosave-<role>.service' --since '15 minutes ago' --output cat --no-pager | jq -c 'select(.processRole == "worker" and .releaseCommit == "<full-commit>")'
journalctl --unit 'videosave-<role>.service' --since '15 minutes ago' --output cat --no-pager | jq -c 'select(.publicJobId == "<public-job-id>")'
```

Filter only bounded canonical fields such as `event`, `processRole`, `releaseCommit`, `requestId`, and `publicJobId`. Do not query or export raw environment, command lines, credentials, cookies, authorization headers, payloads, source URLs/query parameters, SQL, filesystem paths, or FFmpeg stderr. Media-tool failures are represented by fixed `reasonCategory`, stage, outcome, and bounded exit code metadata rather than raw commands or stderr.

Nginx access/error logs are a separate host-level source with their own retention and access policy. They must not be merged into an application support bundle without an independent redaction review. Application support bundles must contain only the minimum time window and sanitized fields; secrets and environment files are prohibited. Missing logs, a disabled alert, or an active silence is not proof of service health—verify loopback liveness, readiness, metrics, and exact release identity separately.
