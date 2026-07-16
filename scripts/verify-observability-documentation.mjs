import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

const REQUIRED_ALERTS = Object.freeze([
  "WebUnavailable", "WorkerUnavailable", "PostgreSQLUnavailable", "DurableVolumeUnavailable",
  "DurableVolumeReadOnly", "MigrationIncompatible", "MaintenanceLeaderMissing", "NoEgressSmokeFailed",
  "DiskSpaceCritical", "InodesCritical", "QueueDepthHigh", "OldestQueuedJobTooOld", "JobFailureRateHigh",
  "RetryExhaustion", "StaleLeases", "MaintenanceStale", "CleanupFailures", "ReconciliationFailures",
  "ArtifactPublicationFailures", "PostgreSQLPoolSaturation", "WorkerRestartLoop", "FFmpegFailureRateHigh",
  "DiskSpaceWarning", "InodesWarning"
]);

const REQUIRED_RUNBOOKS = Object.freeze([
  "web-down", "worker-down", "postgresql-unavailable", "storage-unavailable-read-only", "queue-backlog",
  "stale-leases-jobs", "retry-exhaustion", "maintenance-leader-missing", "cleanup-reconciliation-failure",
  "disk-inode-low", "ffmpeg-failure-spike", "artifact-publication-failure", "no-egress-smoke-failure",
  "migration-mismatch", "nginx-5xx-internal-exposure", "observability-endpoint-failure",
  "metrics-cardinality-size-anomaly", "release-rollback"
]);

const REQUIRED_DASHBOARD_SECTIONS = Object.freeze([
  "Service status", "Web requests: rate, errors, latency, and in-flight", "Queue depth and oldest queued job",
  "Job outcomes", "Job and stage duration", "Worker capacity and active jobs", "Retry exhaustion and stale leases",
  "PostgreSQL availability and pool", "Durable storage capacity, read-only state, and marker",
  "Cleanup, reconciliation, and recovery", "Release and build information", "No-egress smoke", "Alert state"
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function text(relative) {
  return readFile(path.join(projectRoot, relative), "utf8");
}

function occurrences(content, pattern) {
  return [...content.matchAll(pattern)];
}

function extractMetricNames(...sources) {
  const names = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/\.register(?:Counter|Gauge|Histogram)\(\s*"([a-z][a-z0-9_]*)"/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

function assertSafeDocumentation(content, label) {
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content), `${label} contains key material.`);
  assert(!/\/Users\/[A-Za-z0-9._-]+\//.test(content), `${label} contains a user path.`);
  assert(!/\$\{\{\s*secrets\./.test(content), `${label} references CI secrets.`);
  assert(!/(?:api[_-]?key|password|authorization|cookie)\s*[:=]\s*[^<\s]/i.test(content), `${label} contains a credential-like value.`);
}

export async function verifyObservabilityDocumentation() {
  const [alerts, coreMetrics, operationalMetrics, runbooks, dashboard, journald, observability, deployment, release] = await Promise.all([
    text("lib/observability/alert-rules.ts"),
    text("lib/observability/core-metrics.ts"),
    text("lib/observability/operational-metrics.ts"),
    text("docs/operations/runbooks.md"),
    text("docs/operations/dashboard.md"),
    text("docs/operations/journald.md"),
    text("docs/observability.md"),
    text("deployment/README.md"),
    text("docs/production-release.md")
  ]);

  const alertNames = occurrences(alerts, /name: "([A-Z][A-Za-z0-9]+)"/g).map((match) => match[1]);
  assert(alertNames.length === REQUIRED_ALERTS.length, "Alert catalog count changed without documentation review.");
  assert(new Set(alertNames).size === alertNames.length, "Alert names must be unique.");
  for (const name of REQUIRED_ALERTS) assert(alertNames.includes(name), `Alert catalog is missing ${name}.`);
  assert(!/\b(?:fetch|setInterval|setTimeout|http\.request|https\.request)\s*\(/.test(alerts),
    "Alert definitions must remain inert and provider-neutral.");

  const runbookHeadings = new Set(occurrences(runbooks, /^## ([a-z0-9]+(?:-[a-z0-9]+)*)$/gm).map((match) => match[1]));
  for (const slug of REQUIRED_RUNBOOKS) assert(runbookHeadings.has(slug), `Runbook is missing ${slug}.`);
  const alertSlugs = occurrences(alerts, /runbookSlug: "([a-z0-9-]+)"/g).map((match) => match[1]);
  assert(alertSlugs.length === REQUIRED_ALERTS.length, "Every alert must define one runbook slug.");
  for (const slug of alertSlugs) assert(runbookHeadings.has(slug), `Alert runbook does not exist: ${slug}.`);
  for (const slug of REQUIRED_RUNBOOKS) {
    const section = runbooks.match(new RegExp(`^## ${slug}$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"))?.[1] ?? "";
    for (const field of ["Symptoms:", "Safe read-only checks:", "Traffic decision:", "Worker action:", "Web action:", "DB action:", "Storage action:", "Rollback", "Verification:", "Escalation:", "Alert/dashboard:"]) {
      assert(section.includes(field), `Runbook ${slug} is missing ${field}`);
    }
  }

  const metrics = extractMetricNames(coreMetrics, operationalMetrics);
  const operatorSignals = new Set(occurrences(alerts, /"(operator_[a-z0-9_]+)"/g).map((match) => match[1]));
  const metricLabelNames = new Set(["route", "method", "outcome", "role", "preset", "stage", "operation"]);
  for (const heading of REQUIRED_DASHBOARD_SECTIONS) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const section = dashboard.match(new RegExp(`^## ${escaped}$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"))?.[1] ?? "";
    assert(section.length > 0, `Dashboard is missing ${heading}.`);
    for (const field of ["Metrics:", "Aggregation:", "Window:", "Unit:", "Normal:", "Warning/critical:", "Runbook:"]) {
      assert(section.includes(field), `Dashboard section ${heading} is missing ${field}`);
    }
    for (const match of section.matchAll(/`([a-z][a-z0-9_]+)`/g)) {
      const candidate = match[1];
      if (candidate === "processRole" || candidate === "releaseCommit" || metricLabelNames.has(candidate)) continue;
      assert(metrics.has(candidate) || operatorSignals.has(candidate), `Dashboard references unknown metric ${candidate}.`);
    }
  }

  for (const term of ["stdout/stderr", "journald", "does not create log files", "OBSERVABILITY_LOG_LEVEL=info", "journalctl", "processRole", "releaseCommit", "publicJobId", "FFmpeg", "support bundles"]) {
    assert(journald.includes(term), `Journald guide is missing ${term}.`);
  }
  for (const link of ["operations/dashboard.md", "operations/journald.md", "operations/runbooks.md"]) {
    assert(observability.includes(link) && release.includes(link), `Documentation index is missing ${link}.`);
  }
  for (const item of ["exact-commit Linux workflow", "artifact", "PostgreSQL TLS", "POSIX volume", "systemd-analyze verify", "worker observability bind", "nginx -t", "backup", "metrics", "alert definitions", "dashboard", "no-egress smoke", "Traffic enable", "Rollback-check"]) {
    assert(deployment.toLowerCase().includes(item.toLowerCase()), `Cutover checklist is missing ${item}.`);
  }
  assert(deployment.includes("Repository не устанавливает collector, dashboard, alert evaluator/delivery provider"),
    "Deployment documentation must preserve the external integration boundary.");

  for (const [label, content] of [["runbooks", runbooks], ["dashboard", dashboard], ["journald", journald], ["observability", observability], ["release index", release]]) {
    assertSafeDocumentation(content, label);
  }
  return Object.freeze({ alerts: alertNames.length, runbooks: REQUIRED_RUNBOOKS.length, dashboardSections: REQUIRED_DASHBOARD_SECTIONS.length });
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  verifyObservabilityDocumentation().then(
    (result) => console.info(`Observability documentation passed: ${JSON.stringify(result)}.`),
    (error) => {
      console.error(error instanceof Error ? error.message : "Observability documentation verification failed.");
      process.exitCode = 1;
    }
  );
}
