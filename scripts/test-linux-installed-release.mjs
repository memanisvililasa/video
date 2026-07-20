import { execFile, spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { initializeVolumeMarker } from "./durable-volume-admin.mjs";
import { installRelease } from "./release-deployment.mjs";
import {
  APPROVED_NODE_VERSION,
  APPROVED_NPM_VERSION,
  RELEASE_MANIFEST_FILE,
  RELEASE_ROOT_DIRECTORY
} from "./release-contract.mjs";

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const releaseRoot = path.join(projectRoot, RELEASE_ROOT_DIRECTORY);
const AUTHORITY = "0123456789abcdef0123456789abcdef";
export const INSTALLED_WORKER_OBSERVABILITY_SCHEMA_VERSION = "1.0";
export const INSTALLED_WORKER_MAX_LINE_BYTES = 8 * 1024;
export const INSTALLED_METRICS_MAX_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 5_000;
const PROCESS_INSTANCE_ID = /^[a-f0-9]{32}$/;
const RELEASE_COMMIT = /^[a-f0-9]{40}$/;
const RELEASE_ID = /^videosave-[A-Za-z0-9][A-Za-z0-9._-]{0,63}-[a-f0-9]{12}$/;
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const POSTGRES_SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
const INSTALLED_COMMAND_LABELS = new Set([
  "migration-apply",
  "migration-status",
  "web-readiness",
  "worker-readiness"
]);
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
const OPERATIONAL_EVENTS = new Set([
  "process.starting", "process.ready", "process.not_ready", "process.stopping", "process.stopped", "config.invalid",
  "http.request.completed", "job.submit.accepted", "job.submit.rejected", "job.status.read", "job.cancel.requested",
  "job.file.requested", "job.file.rejected", "db.connected", "db.unavailable", "migration.status",
  "migration.mismatch", "db.query.failed", "db.pool.exhausted", "job.queued", "job.claimed", "job.lease_lost",
  "job.progress", "job.retry_scheduled", "job.retry_exhausted", "job.completed", "job.failed", "job.cancelled",
  "job.expired", "download.started", "download.completed", "download.failed", "probe.started", "probe.completed",
  "probe.failed", "transcode.started", "transcode.completed", "transcode.failed", "artifact.staged",
  "artifact.published", "artifact.publication_failed", "lifecycle.leader_acquired", "lifecycle.leader_lost",
  "recovery.started", "recovery.completed", "recovery.failed", "reconciliation.started", "reconciliation.completed",
  "reconciliation.failed", "cleanup.started", "cleanup.completed", "cleanup.failed"
]);
const OPERATIONAL_OUTCOMES = new Set(["success", "failure", "rejected", "cancelled", "unknown"]);
const OPERATIONAL_REASON_CODES = new Set([
  "none", "invalid_event", "invalid_configuration", "invalid_request", "rate_limited", "job_not_found",
  "job_not_ready", "dependency_unavailable", "database_unavailable", "schema_mismatch", "storage_unavailable",
  "tool_unavailable", "listener_unavailable", "readiness_timeout", "readiness_failed", "method_not_allowed",
  "body_not_allowed", "request_aborted", "cancelled", "lease_lost", "retry_scheduled", "retry_exhausted",
  "download_failed", "probe_failed", "transcode_failed", "publication_failed", "maintenance_failed",
  "pool_exhausted", "storage_read_only", "internal_error"
]);
const REQUIRED_CORE_METRICS = Object.freeze([
  "build_info", "process_start_time_seconds", "process_up", "readiness_status",
  "http_requests_total", "http_request_duration_seconds", "http_in_flight", "http_responses_total"
]);
const REQUIRED_OPERATIONAL_METRICS = Object.freeze([
  "active_jobs", "queue_depth", "oldest_queued_job_age_seconds", "running_jobs", "stale_leases",
  "jobs_submitted_total", "jobs_completed_total", "jobs_failed_total", "retry_exhausted_total",
  "job_duration_seconds", "job_stage_duration_seconds", "db_up", "db_pool_active", "db_pool_idle",
  "db_pool_waiting", "migration_compatible", "storage_up", "storage_read_only", "storage_free_bytes",
  "storage_free_inodes", "storage_marker_valid", "cleanup_failures_total",
  "reconciliation_failures_total", "maintenance_leader", "maintenance_last_success_timestamp"
]);
const REQUIRED_WORKER_METRICS = Object.freeze([
  "worker_available_slots", "worker_active_jobs", "worker_last_heartbeat_timestamp",
  "worker_processing_failures_total", "ffmpeg_processes", "artifact_publication_failures_total"
]);
const METRIC_TYPES = new Set(["counter", "gauge", "histogram"]);
const LABEL_VALUES = Object.freeze({
  role: new Set(["local", "web", "worker", "migration"]),
  releaseCategory: new Set(["local", "test", "production"]),
  route: new Set(["job_submit", "job_status", "job_cancel", "job_file"]),
  method: new Set(["GET", "HEAD", "POST", "DELETE"]),
  outcome: new Set(["success", "failure", "rejected", "cancelled", "unknown"]),
  statusClass: new Set(["1xx", "2xx", "3xx", "4xx", "5xx"]),
  preset: new Set(["original", "remux-to-mp4", "compatible-mp4", "audio-only", "unknown"]),
  reasonCategory: new Set(["validation", "configuration", "database", "storage", "network", "ssrf", "timeout", "cancellation", "download", "probe", "transcode", "publication", "migration", "internal"]),
  stage: new Set(["queued", "download", "probe", "transcode", "remux", "audio", "publication", "completion"]),
  operation: new Set(["recovery", "reconciliation", "cleanup", "expiration"])
});

function exactRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function parseInstalledProcessLogLine(line, options) {
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > INSTALLED_WORKER_MAX_LINE_BYTES || RAW_CONTROL.test(line)) {
    return null;
  }
  let record;
  try {
    record = exactRecord(JSON.parse(line));
  } catch {
    return null;
  }
  if (!record) return null;
  const timestamp = record.timestamp;
  const parsedTimestamp = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  const nowMs = (options.now ?? Date.now)();
  if (
    record.schemaVersion !== INSTALLED_WORKER_OBSERVABILITY_SCHEMA_VERSION ||
    typeof record.event !== "string" ||
    !OPERATIONAL_EVENTS.has(record.event) ||
    (options.expectedEvent !== undefined && record.event !== options.expectedEvent) ||
    record.service !== "videosave" ||
    record.processRole !== options.expectedRole ||
    !LOG_LEVELS.has(record.level) ||
    typeof record.outcome !== "string" ||
    !OPERATIONAL_OUTCOMES.has(record.outcome) ||
    typeof record.reasonCode !== "string" ||
    !OPERATIONAL_REASON_CODES.has(record.reasonCode) ||
    (options.expectedEvent === "process.ready" && (record.outcome !== "success" || record.reasonCode !== "none")) ||
    typeof record.processInstanceId !== "string" ||
    !PROCESS_INSTANCE_ID.test(record.processInstanceId) ||
    typeof record.releaseCommit !== "string" ||
    !RELEASE_COMMIT.test(record.releaseCommit) ||
    record.releaseCommit !== options.expectedReleaseCommit ||
    typeof record.releaseId !== "string" ||
    !RELEASE_ID.test(record.releaseId) ||
    record.releaseId !== options.expectedReleaseId ||
    typeof timestamp !== "string" ||
    !Number.isFinite(parsedTimestamp) ||
    new Date(parsedTimestamp).toISOString() !== timestamp ||
    parsedTimestamp < options.startedAtMs ||
    parsedTimestamp > nowMs + MAX_CLOCK_SKEW_MS
  ) {
    return null;
  }
  return Object.freeze({ ...record });
}

export function parseInstalledWorkerReadyLine(line, options) {
  return parseInstalledProcessLogLine(line, {
    ...options,
    expectedRole: "worker",
    expectedEvent: "process.ready"
  });
}

export function waitForInstalledProcessReady(options) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    return Promise.reject(new TypeError("Installed release readiness timeout is invalid."));
  }
  if (options.child.exitCode !== null) {
    return Promise.reject(new Error("Installed release process exited before readiness."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = Buffer.alloc(0);
    const decoder = new TextDecoder("utf-8", { fatal: true });

    const cleanup = () => {
      clearTimeout(timer);
      options.stdout.off("data", onData);
      options.stdout.off("end", onEnd);
      options.stdout.off("error", onStreamError);
      options.child.off("exit", onExit);
    };
    const finish = (error, record) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(record);
    };
    const invalidOutput = () => finish(new Error("Installed release readiness output is invalid."));
    const inspectLine = (bytes) => {
      if (bytes.length > INSTALLED_WORKER_MAX_LINE_BYTES) {
        invalidOutput();
        return;
      }
      let line;
      try {
        line = decoder.decode(bytes);
      } catch {
        invalidOutput();
        return;
      }
      const record = parseInstalledProcessLogLine(line, { ...options, expectedEvent: "process.ready" });
      if (record) finish(null, record);
    };
    const onData = (value) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let offset = 0;
      while (!settled && offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);
        if (pending.length + segment.length > INSTALLED_WORKER_MAX_LINE_BYTES) {
          invalidOutput();
          return;
        }
        if (segment.length > 0) pending = Buffer.concat([pending, segment], pending.length + segment.length);
        if (newline === -1) return;
        const line = pending;
        pending = Buffer.alloc(0);
        inspectLine(line);
        offset = newline + 1;
      }
    };
    const onExit = () => finish(new Error("Installed release process exited before readiness."));
    const onEnd = () => finish(new Error("Installed release process stdout ended before readiness."));
    const onStreamError = () => invalidOutput();
    const timer = setTimeout(
      () => finish(new Error("Installed release process readiness timed out.")),
      timeoutMs
    );
    timer.unref?.();
    options.stdout.on("data", onData);
    options.stdout.once("end", onEnd);
    options.stdout.once("error", onStreamError);
    options.child.once("exit", onExit);
  });
}

export function waitForInstalledWorkerReady(options) {
  return waitForInstalledProcessReady({ ...options, expectedRole: "worker" });
}

function parseMetricLabels(raw) {
  if (!raw) return Object.freeze({});
  const body = raw.slice(1, -1);
  const output = {};
  let offset = 0;
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"(?:,|$)/gy;
  while (offset < body.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(body);
    if (!match) throw new Error("Installed metrics labels are malformed.");
    let value;
    try { value = JSON.parse(`"${match[2]}"`); } catch { throw new Error("Installed metrics label escaping is invalid."); }
    if (Object.hasOwn(output, match[1])) throw new Error("Installed metrics contain a duplicate label.");
    output[match[1]] = value;
    offset = pattern.lastIndex;
  }
  return Object.freeze(output);
}

function assertMetricLabels(labels) {
  for (const [name, value] of Object.entries(labels)) {
    if (/request.?id|public.?job.?id|job.?id|user|client|ip|url|filename|path|error/i.test(name)) {
      throw new Error("Installed metrics contain a high-cardinality label.");
    }
    if (name === "le") {
      if (value !== "+Inf" && (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))) {
        throw new Error("Installed histogram boundary is invalid.");
      }
      continue;
    }
    const allowed = LABEL_VALUES[name];
    if (!allowed || !allowed.has(value)) throw new Error("Installed metrics label value is outside its allowlist.");
  }
}

function canonicalMetricLabels(labels) {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right, "en"));
  return entries.length === 0
    ? ""
    : `{${entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(",")}}`;
}

function metricFamilyForSample(name, types) {
  if (types.has(name)) return name;
  for (const [family, type] of types) {
    if (type === "histogram" && ["_bucket", "_sum", "_count"].some((suffix) => name === `${family}${suffix}`)) {
      return family;
    }
  }
  return null;
}

function stableMapSignature(map) {
  return JSON.stringify([...map.entries()].sort(([left], [right]) => left.localeCompare(right, "en")));
}

function stableSetSignature(set) {
  return JSON.stringify([...set].sort((left, right) => left.localeCompare(right, "en")));
}

function parseInstalledMetricsText(text, options = {}) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > INSTALLED_METRICS_MAX_BYTES) {
    throw new Error("Installed metrics response exceeds its bound.");
  }
  if (!text.endsWith("\n") || /[\r\u0000]/.test(text)) throw new Error("Installed metrics exposition is malformed.");
  if (/postgres(?:ql)?:\/\/|https?:\/\/|(?:^|[\s"'])\/(?:home|tmp|var|opt|Users|private)\/|requestId|publicJobId|DATABASE_URL|TEST_DATABASE_URL|\.mp4\b/i.test(text)) {
    throw new Error("Installed metrics expose sensitive or high-cardinality content.");
  }
  const help = new Map();
  const types = new Map();
  const rawSamples = [];
  const normalizedLines = [];
  const valuePattern = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
  for (const line of text.trimEnd().split("\n")) {
    if (line.startsWith("# HELP ")) {
      const match = line.match(/^# HELP ([A-Za-z_:][A-Za-z0-9_:]*) ([^\r\n]{1,256})$/);
      if (!match || help.has(match[1])) throw new Error("Installed metrics HELP contract is invalid.");
      help.set(match[1], match[2]);
      normalizedLines.push(line);
      continue;
    }
    if (line.startsWith("# TYPE ")) {
      const match = line.match(/^# TYPE ([A-Za-z_:][A-Za-z0-9_:]*) (counter|gauge|histogram)$/);
      if (!match || !METRIC_TYPES.has(match[2]) || types.has(match[1])) throw new Error("Installed metrics TYPE contract is invalid.");
      types.set(match[1], match[2]);
      normalizedLines.push(line);
      continue;
    }
    const match = line.match(new RegExp(`^([A-Za-z_:][A-Za-z0-9_:]*)(\\{[^{}]*\\})? (${valuePattern})$`));
    if (!match || !Number.isFinite(Number(match[3]))) throw new Error("Installed metrics sample is invalid.");
    const labels = parseMetricLabels(match[2]);
    assertMetricLabels(labels);
    const canonicalLabels = canonicalMetricLabels(labels);
    rawSamples.push(Object.freeze({
      name: match[1],
      labels,
      canonicalLabels,
      value: Number(match[3])
    }));
    normalizedLines.push(`${match[1]}${canonicalLabels} <value>`);
  }
  for (const [name, type] of types) {
    if (!help.has(name) || !METRIC_TYPES.has(type)) throw new Error("Installed metrics descriptor is incomplete.");
  }
  if (help.size !== types.size) throw new Error("Installed metrics HELP/TYPE descriptors are inconsistent.");
  const required = [...REQUIRED_CORE_METRICS, ...REQUIRED_OPERATIONAL_METRICS, ...(options.role === "worker" ? REQUIRED_WORKER_METRICS : [])];
  for (const name of required) {
    if (!help.has(name) || !types.has(name)) throw new Error(`Installed metrics are missing required family: ${name}.`);
  }

  const samples = new Map();
  const labelSchemas = new Map();
  for (const sample of rawSamples) {
    const family = metricFamilyForSample(sample.name, types);
    if (!family) throw new Error(`Installed metrics sample has no descriptor: ${sample.name}.`);
    const identity = `${sample.name}${sample.canonicalLabels}`;
    if (samples.has(identity)) throw new Error("Installed metrics contain a duplicate sample.");
    const labelNames = Object.keys(sample.labels).sort((left, right) => left.localeCompare(right, "en"));
    const familySchemas = labelSchemas.get(family) ?? new Set();
    familySchemas.add(`${sample.name}:${labelNames.join(",")}`);
    labelSchemas.set(family, familySchemas);
    samples.set(identity, Object.freeze({ ...sample, family, identity }));
  }

  const buildSamples = [...samples.values()].filter((sample) => sample.name === "build_info");
  if (
    buildSamples.length !== 1 ||
    buildSamples[0].value !== 1 ||
    stableSetSignature(new Set(Object.keys(buildSamples[0].labels))) !== stableSetSignature(new Set(["releaseCategory", "role"])) ||
    buildSamples[0].labels.releaseCategory !== "production" ||
    (options.role !== undefined && buildSamples[0].labels.role !== options.role)
  ) {
    throw new Error("Installed metrics build identity is invalid.");
  }
  const processStartSamples = [...samples.values()].filter((sample) => sample.name === "process_start_time_seconds");
  if (
    processStartSamples.length !== 1 ||
    Object.keys(processStartSamples[0].labels).length !== 0 ||
    processStartSamples[0].value <= 0
  ) {
    throw new Error("Installed metrics process identity is invalid.");
  }

  return Object.freeze({
    help,
    types,
    samples,
    labelSchemas,
    normalizedStructure: normalizedLines.join("\n"),
    summary: Object.freeze({ families: help.size, samples: samples.size, bytes: Buffer.byteLength(text, "utf8") })
  });
}

export function validateInstalledMetricsText(text, options = {}) {
  return parseInstalledMetricsText(text, options).summary;
}

export function validateInstalledMetricsExpositionPair(firstText, secondText, options = {}) {
  const first = parseInstalledMetricsText(firstText, options);
  const second = parseInstalledMetricsText(secondText, options);
  if (stableSetSignature(new Set(first.help.keys())) !== stableSetSignature(new Set(second.help.keys()))) {
    throw new Error("Installed metrics family set changed between scrapes.");
  }
  if (stableMapSignature(first.help) !== stableMapSignature(second.help)) {
    throw new Error("Installed metrics HELP metadata changed between scrapes.");
  }
  if (stableMapSignature(first.types) !== stableMapSignature(second.types)) {
    throw new Error("Installed metrics TYPE metadata changed between scrapes.");
  }
  const schemaSignature = (parsed) => stableMapSignature(new Map(
    [...parsed.labelSchemas].map(([family, schemas]) => [family, stableSetSignature(schemas)])
  ));
  if (schemaSignature(first) !== schemaSignature(second)) {
    throw new Error("Installed metrics label schema changed between scrapes.");
  }
  if (stableSetSignature(new Set(first.samples.keys())) !== stableSetSignature(new Set(second.samples.keys()))) {
    throw new Error("Installed metrics series set changed between scrapes.");
  }
  if (first.normalizedStructure !== second.normalizedStructure) {
    throw new Error("Installed metrics canonical order changed between scrapes.");
  }
  for (const name of ["build_info", "process_start_time_seconds"]) {
    const firstSamples = [...first.samples.values()].filter((sample) => sample.family === name);
    const secondSamples = [...second.samples.values()].filter((sample) => sample.family === name);
    for (let index = 0; index < firstSamples.length; index += 1) {
      if (firstSamples[index].identity !== secondSamples[index]?.identity || firstSamples[index].value !== secondSamples[index]?.value) {
        throw new Error(`Installed metrics immutable identity changed between scrapes: ${name}.`);
      }
    }
  }
  return Object.freeze({ first: first.summary, second: second.summary });
}

export function validateInstalledStructuredLogs(text, options) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 128 * 1024) {
    throw new Error("Installed structured log capture is invalid.");
  }
  const records = [];
  for (const line of text.split("\n")) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { throw new Error("Installed structured log line is invalid JSON."); }
    if (parsed?.service !== "videosave") continue;
    const record = parseInstalledProcessLogLine(candidate, options);
    if (!record) throw new Error("Installed structured log record violates the canonical schema.");
    if (/DATABASE_URL|TEST_DATABASE_URL|Authorization|cookie|sourceUrl|payload|raw.?sql|ffmpegStderr|postgres(?:ql)?:\/\/|https?:\/\//i.test(candidate)) {
      throw new Error("Installed structured log record contains sensitive content.");
    }
    if (/(?:^|["'\s])\/(?:home|tmp|var|opt|Users|private)\//.test(candidate)) {
      throw new Error("Installed structured log record contains an absolute path.");
    }
    records.push(record);
  }
  for (const event of options.requiredEvents ?? []) {
    if (!records.some((record) => record.event === event)) throw new Error(`Installed structured logs are missing ${event}.`);
  }
  if (records.some((record) => record.level === "info" && /heartbeat/i.test(record.event))) {
    throw new Error("Installed structured logs contain heartbeat noise.");
  }
  return Object.freeze(records);
}

function captureProcessOutput(child) {
  let stdoutValue = "";
  let stderrValue = "";
  const appendStdout = (chunk) => { stdoutValue = `${stdoutValue}${Buffer.from(chunk).toString("utf8")}`.slice(-128 * 1024); };
  const appendStderr = (chunk) => { stderrValue = `${stderrValue}${Buffer.from(chunk).toString("utf8")}`.slice(-128 * 1024); };
  child.stdout?.on("data", appendStdout);
  child.stderr?.on("data", appendStderr);
  return Object.freeze({
    stdoutText: () => stdoutValue,
    stderrText: () => stderrValue,
    close() {
      child.stdout?.off("data", appendStdout);
      child.stderr?.off("data", appendStderr);
    }
  });
}

async function loopbackRequest(port, pathname, method = "GET") {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(5_000)
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > INSTALLED_METRICS_MAX_BYTES) throw new Error("Installed observability response is oversized.");
  return Object.freeze({
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: body.toString("utf8")
  });
}

async function assertLoopbackClosed(port, label) {
  try {
    await loopbackRequest(port, "/internal/observability/live");
  } catch {
    return;
  }
  throw new Error(`${label} listener remained reachable after cleanup.`);
}

async function snapshotDatabase(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const result = await pool.query(`SELECT
      (SELECT md5(COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.job_id)::text, '[]')) FROM media_jobs AS j) AS jobs,
      (SELECT md5(COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.artifact_id)::text, '[]')) FROM media_artifacts AS a) AS artifacts,
      (SELECT count(*)::text FROM media_lifecycle_state) AS lifecycle`);
    return Object.freeze({ ...result.rows[0] });
  } finally {
    await pool.end();
  }
}

async function snapshotStorage(root) {
  const [jobs, published, rootEntries] = await Promise.all([
    readdir(path.join(root, "jobs")),
    readdir(path.join(root, "published")),
    readdir(root)
  ]);
  return JSON.stringify({ jobs: jobs.sort(), published: published.sort(), root: rootEntries.sort() });
}

async function verifyInstalledEndpointSet(options) {
  const databaseBefore = await snapshotDatabase(options.databaseUrl);
  const storageBefore = await snapshotStorage(options.volumeRoot);
  const live = await loopbackRequest(options.port, "/internal/observability/live");
  if (live.status !== 200 || live.body !== JSON.stringify({ status: "live" })) throw new Error("Installed liveness contract failed.");
  const head = await loopbackRequest(options.port, "/internal/observability/live", "HEAD");
  if (head.status !== 200 || head.body !== "") throw new Error("Installed liveness HEAD contract failed.");
  const ready = await loopbackRequest(options.port, "/internal/observability/ready");
  if (ready.status !== 200 || ready.body !== JSON.stringify({ status: "ready" })) throw new Error("Installed readiness contract failed.");
  const first = await loopbackRequest(options.port, "/internal/observability/metrics");
  const second = await loopbackRequest(options.port, "/internal/observability/metrics");
  if (first.status !== 200 || second.status !== 200 || !first.contentType.startsWith("text/plain; version=0.0.4")) {
    throw new Error("Installed metrics HTTP contract failed.");
  }
  validateInstalledMetricsText(first.body, { role: options.role });
  validateInstalledMetricsText(second.body, { role: options.role });
  const third = await loopbackRequest(options.port, "/internal/observability/metrics");
  validateInstalledMetricsExpositionPair(second.body, third.body, { role: options.role });
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => loopbackRequest(options.port, "/internal/observability/metrics")));
  for (const response of concurrent) {
    if (response.status !== 200) throw new Error("Installed concurrent metrics scrape failed.");
    validateInstalledMetricsText(response.body, { role: options.role });
  }
  for (const method of ["POST", "DELETE", "OPTIONS"]) {
    const response = await loopbackRequest(options.port, "/internal/observability/metrics", method);
    if (response.status !== 405) throw new Error("Installed observability method rejection failed.");
  }
  const databaseAfter = await snapshotDatabase(options.databaseUrl);
  const storageAfter = await snapshotStorage(options.volumeRoot);
  if (JSON.stringify(databaseAfter) !== JSON.stringify(databaseBefore) || storageAfter !== storageBefore) {
    throw new Error("Installed metrics scrape mutated durable state.");
  }
}

async function verifyDependencyOutage(options) {
  const ready = await loopbackRequest(options.port, "/internal/observability/ready");
  if (ready.status !== 503 || !/^\{"status":"not_ready","reason":"(?:database|timeout|internal)"\}$/.test(ready.body)) {
    throw new Error("Installed readiness did not fail closed during dependency outage.");
  }
  const live = await loopbackRequest(options.port, "/internal/observability/live");
  if (live.status !== 200) throw new Error("Installed liveness depends on PostgreSQL availability.");
  const metrics = await loopbackRequest(options.port, "/internal/observability/metrics");
  if (metrics.status === 200) validateInstalledMetricsText(metrics.body, { role: options.role });
  else if (metrics.status !== 503 || Buffer.byteLength(metrics.body, "utf8") > 512) throw new Error("Installed outage metrics response is unsafe.");
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function executable(name) {
  const result = await run("which", [name], { maxBuffer: 64 * 1024 });
  const value = result.stdout.trim();
  if (!path.isAbsolute(value)) throw new Error("Required media executable is unavailable.");
  return value;
}

async function npmVersion() {
  const npm = process.env.npm_execpath?.trim();
  const result = npm
    ? await run(process.execPath, [npm, "--version"], { maxBuffer: 64 * 1024 })
    : await run("npm", ["--version"], { maxBuffer: 64 * 1024 });
  return result.stdout.trim();
}

async function makeWritable(value) {
  const info = await lstat(value).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(value, 0o755).catch(() => undefined);
    for (const entry of await readdir(value)) await makeWritable(path.join(value, entry));
  } else {
    await chmod(value, 0o644).catch(() => undefined);
  }
}

export async function runChecked(label, entrypoint, args, options) {
  if (!INSTALLED_COMMAND_LABELS.has(label)) {
    throw new TypeError("Installed release command label is invalid.");
  }
  const execute = options.execute ?? run;
  try {
    await execute(process.execPath, [entrypoint, ...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 512 * 1024
    });
  } catch {
    throw new Error(`Installed release command failed: ${label}.`);
  }
}

async function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Loopback test listener address is invalid."));
      else resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

export async function createPostgresTlsBridge(databaseUrl, root) {
  const upstreamUrl = new URL(databaseUrl);
  if (upstreamUrl.protocol !== "postgres:" && upstreamUrl.protocol !== "postgresql:") {
    throw new Error("Disposable PostgreSQL URL is invalid.");
  }
  if (upstreamUrl.hostname !== "127.0.0.1" && upstreamUrl.hostname !== "localhost") {
    throw new Error("Disposable PostgreSQL must use loopback for release validation.");
  }
  const upstreamPort = Number(upstreamUrl.port || "5432");
  if (!Number.isSafeInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65_535) {
    throw new Error("Disposable PostgreSQL port is invalid.");
  }
  const tlsRoot = await mkdtemp(path.join(root, ".postgres-tls-bridge-"));
  await chmod(tlsRoot, 0o700);
  const keyFile = path.join(tlsRoot, "server.key");
  const certificateFile = path.join(tlsRoot, "server.crt");
  const configFile = path.join(tlsRoot, "openssl.cnf");
  await writeFile(configFile, [
    "[req]",
    "distinguished_name=subject",
    "x509_extensions=extensions",
    "prompt=no",
    "[subject]",
    "CN=127.0.0.1",
    "[extensions]",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "basicConstraints=critical,CA:TRUE",
    "keyUsage=critical,keyCertSign,digitalSignature,keyEncipherment",
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
    "-keyout", keyFile, "-out", certificateFile, "-days", "1", "-config", configFile
  ], { maxBuffer: 64 * 1024 });
  await chmod(keyFile, 0o600);

  const sockets = new Set();
  const secureServer = createTlsServer({
    key: await readFile(keyFile),
    cert: await readFile(certificateFile),
    minVersion: "TLSv1.2"
  }, (secureSocket) => {
    sockets.add(secureSocket);
    secureSocket.once("close", () => sockets.delete(secureSocket));
    const upstream = connect({ host: upstreamUrl.hostname, port: upstreamPort });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    secureSocket.once("error", () => upstream.destroy());
    upstream.once("error", () => secureSocket.destroy());
    secureSocket.pipe(upstream).pipe(secureSocket);
  });
  secureServer.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  const securePort = await listen(secureServer);

  const frontServer = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => socket.destroy());
    socket.once("data", (request) => {
      if (request.length !== POSTGRES_SSL_REQUEST.length || !request.equals(POSTGRES_SSL_REQUEST)) {
        socket.destroy();
        return;
      }
      const bridge = connect({ host: "127.0.0.1", port: securePort });
      sockets.add(bridge);
      bridge.once("close", () => sockets.delete(bridge));
      bridge.once("error", () => socket.destroy());
      bridge.once("connect", () => {
        socket.write("S");
        socket.pipe(bridge).pipe(socket);
      });
    });
  });
  frontServer.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  const frontPort = await listen(frontServer);
  const bridgedUrl = new URL(databaseUrl);
  bridgedUrl.hostname = "127.0.0.1";
  bridgedUrl.port = String(frontPort);
  let closed = false;
  return Object.freeze({
    databaseUrl: bridgedUrl.toString(),
    certificateFile,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await Promise.all([closeServer(frontServer), closeServer(secureServer)]);
    }
  });
}

export async function validateInstalledReleaseReadiness(options) {
  const migrationEnvironment = { ...options.common, APP_PROCESS_ROLE: "migration" };
  await runChecked("migration-apply", "scripts/postgres-migrations.mjs", ["apply"], {
    cwd: options.installedRoot,
    env: migrationEnvironment,
    execute: options.execute
  });
  await runChecked("migration-status", "scripts/postgres-migrations.mjs", ["status"], {
    cwd: options.installedRoot,
    env: migrationEnvironment,
    execute: options.execute
  });
  await runChecked("web-readiness", "checks/web-readiness.mjs", [], {
    cwd: options.installedRoot,
    env: { ...options.common, APP_PROCESS_ROLE: "web" },
    execute: options.execute
  });
  await runChecked("worker-readiness", "worker/main.mjs", ["--check"], {
    cwd: options.installedRoot,
    env: options.workerEnvironment,
    execute: options.execute
  });
}

export async function stopInstalledProcess(child, label, timeoutMs = 15_000) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      child.kill("SIGKILL");
      reject(new Error(`${label} did not stop gracefully.`));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function isExpectedSigtermExit(exitCode, signalCode) {
  return (
    (signalCode === null && (exitCode === 0 || exitCode === 128 + 15)) ||
    (exitCode === null && signalCode === "SIGTERM")
  );
}

function assertInstalledStderrSafe(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 128 * 1024) {
    throw new Error("Installed process stderr capture is invalid.");
  }
  if (/(?:fatal|uncaught|unhandled|EADDRINUSE|startup failed|runtime failed)/i.test(text)) {
    throw new Error("Installed process stderr contains a fatal runtime error.");
  }
  for (const line of text.split("\n")) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    let record;
    try { record = JSON.parse(candidate); } catch { continue; }
    if (record?.event === "process.stopping" || record?.event === "process.stopped") {
      throw new Error("Installed process lifecycle evidence must come from stdout.");
    }
  }
}

export function verifyInstalledProcessShutdown(options) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    return Promise.reject(new TypeError("Installed process shutdown timeout is invalid."));
  }
  const parserOptions = {
    expectedRole: options.expectedRole,
    expectedReleaseCommit: options.expectedReleaseCommit,
    expectedReleaseId: options.expectedReleaseId,
    startedAtMs: options.startedAtMs,
    now: options.now
  };
  const ready = parseInstalledProcessLogLine(JSON.stringify(options.readyRecord), {
    ...parserOptions,
    expectedEvent: "process.ready"
  });
  if (!ready) return Promise.reject(new Error("Installed process shutdown lacks canonical readiness evidence."));
  if (options.child.exitCode !== null || options.child.signalCode !== null) {
    return Promise.reject(new Error("Installed process exited before verifier SIGTERM."));
  }
  if (typeof options.verifyCleanup !== "function" || typeof options.stderrText !== "function") {
    return Promise.reject(new TypeError("Installed process shutdown verification is incomplete."));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = Buffer.alloc(0);
    let signalSent = false;
    let exitSeen = false;
    let stdoutEnded = false;
    let stopping = null;
    let stopped = null;
    let exitCode = null;
    let signalCode = null;
    let cleanupStarted = false;
    const decoder = new TextDecoder("utf-8", { fatal: true });

    const removeHandlers = () => {
      clearTimeout(timer);
      options.stdout.off("data", onData);
      options.stdout.off("end", onEnd);
      options.stdout.off("error", onStreamError);
      options.child.off("exit", onExit);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      removeHandlers();
      if (error) reject(error);
      else resolve(result);
    };
    const fail = (message) => finish(new Error(message));
    const maybeFinish = () => {
      if (settled || cleanupStarted || !exitSeen || !stdoutEnded) return;
      if (!stopping || !stopped) {
        fail("Installed process shutdown lacks canonical stopping evidence.");
        return;
      }
      cleanupStarted = true;
      removeHandlers();
      Promise.resolve()
        .then(() => assertInstalledStderrSafe(options.stderrText()))
        .then(() => options.verifyCleanup())
        .then(
          () => {
            if (settled) return;
            settled = true;
            resolve(Object.freeze({
              ready,
              stopping,
              stopped,
              exitCode,
              signalCode,
              signalSent,
              timedOut: false,
              usedSigkill: false
            }));
          },
          () => {
            if (settled) return;
            settled = true;
            reject(new Error("Installed process cleanup verification failed."));
          }
        );
    };
    const inspectLine = (bytes) => {
      if (bytes.length > INSTALLED_WORKER_MAX_LINE_BYTES) {
        fail("Installed process lifecycle output is invalid.");
        return;
      }
      let line;
      try { line = decoder.decode(bytes); } catch {
        fail("Installed process lifecycle output is invalid.");
        return;
      }
      const candidate = line.trim();
      if (!candidate.startsWith("{")) return;
      let parsed;
      try { parsed = JSON.parse(candidate); } catch {
        fail("Installed process lifecycle output is invalid.");
        return;
      }
      if (!["process.ready", "process.stopping", "process.stopped"].includes(parsed?.event)) return;
      const record = parseInstalledProcessLogLine(candidate, parserOptions);
      if (!record || record.processInstanceId !== ready.processInstanceId) {
        fail("Installed process lifecycle identity is invalid.");
        return;
      }
      if (!signalSent || record.event === "process.ready") {
        fail("Installed process lifecycle order is invalid.");
        return;
      }
      if (record.event === "process.stopping") {
        if (stopping || stopped || Date.parse(record.timestamp) < Date.parse(ready.timestamp)) {
          fail("Installed process stopping event is invalid or duplicated.");
          return;
        }
        stopping = record;
        return;
      }
      if (!stopping || stopped || Date.parse(record.timestamp) < Date.parse(stopping.timestamp)) {
        fail("Installed process stopped event is invalid or duplicated.");
        return;
      }
      stopped = record;
    };
    const onData = (value) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let offset = 0;
      while (!settled && offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);
        if (pending.length + segment.length > INSTALLED_WORKER_MAX_LINE_BYTES) {
          fail("Installed process lifecycle output is invalid.");
          return;
        }
        if (segment.length > 0) pending = Buffer.concat([pending, segment], pending.length + segment.length);
        if (newline === -1) return;
        const line = pending;
        pending = Buffer.alloc(0);
        inspectLine(line);
        offset = newline + 1;
      }
    };
    const onEnd = () => {
      if (settled) return;
      if (pending.length > 0) {
        const first = pending.subarray(0, 1).toString("utf8");
        if (first === "{") {
          fail("Installed process lifecycle output ended with an incomplete record.");
          return;
        }
        pending = Buffer.alloc(0);
      }
      stdoutEnded = true;
      maybeFinish();
    };
    const onStreamError = () => fail("Installed process lifecycle output is invalid.");
    const onExit = (code, signal) => {
      if (settled) return;
      exitSeen = true;
      exitCode = code;
      signalCode = signal;
      if (!isExpectedSigtermExit(exitCode, signalCode)) {
        fail("Installed process exited with an unexpected status after SIGTERM.");
        return;
      }
      maybeFinish();
    };
    const timer = setTimeout(() => {
      if (!exitSeen) options.child.kill("SIGKILL");
      fail("Installed process shutdown timed out.");
    }, timeoutMs);
    timer.unref?.();
    options.stdout.on("data", onData);
    options.stdout.once("end", onEnd);
    options.stdout.once("error", onStreamError);
    options.child.once("exit", onExit);
    signalSent = true;
    if (!options.child.kill("SIGTERM")) fail("Installed process rejected verifier SIGTERM.");
  });
}

async function main() {
  if (process.platform !== "linux") throw new Error("Installed release process validation requires Linux.");
  if (process.version.replace(/^v/, "") !== APPROVED_NODE_VERSION) throw new Error("Node version is not approved.");
  if (await npmVersion() !== APPROVED_NPM_VERSION) throw new Error("npm version is not approved.");
  const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for Linux release validation.");
  const manifest = JSON.parse(await readFile(path.join(releaseRoot, RELEASE_MANIFEST_FILE), "utf8"));
  if (manifest.build.target !== `${process.platform}-${process.arch}` || manifest.build.sourceTreeDirty !== false) {
    throw new Error("Release is not a clean approved Linux artifact.");
  }
  const deploymentRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-linux-release-"));
  const volumeRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-linux-volume-"));
  let postgresTlsBridge;
  try {
    await Promise.all([
      mkdir(path.join(deploymentRoot, "releases")),
      mkdir(path.join(deploymentRoot, ".deployment")),
      mkdir(path.join(volumeRoot, "jobs"), { mode: 0o750 }),
      mkdir(path.join(volumeRoot, "published"), { mode: 0o750 })
    ]);
    await initializeVolumeMarker({ root: volumeRoot, authorityId: AUTHORITY });
    const basename = `videosave-${manifest.application.version}-${manifest.build.gitCommit.slice(0, 12)}.tar.gz`;
    const installed = await installRelease({
      archive: path.join(path.dirname(releaseRoot), basename),
      checksum: path.join(path.dirname(releaseRoot), `${basename}.sha256`),
      deploymentRoot,
      expectedCommit: manifest.build.gitCommit
    });
    const installedRoot = path.join(deploymentRoot, "releases", installed.releaseId);
    const ffmpeg = await executable("ffmpeg");
    const ffprobe = await executable("ffprobe");
    const workerObservabilityPort = await availablePort();
    if (!workerObservabilityPort) throw new Error("Worker observability loopback port was not allocated.");
    const common = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      CI: "true",
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      POSTGRES_SSL_MODE: "disable",
      POSTGRES_POOL_MAX: "5",
      POSTGRES_CONNECTION_TIMEOUT_MS: "5000",
      POSTGRES_STATEMENT_TIMEOUT_MS: "5000",
      POSTGRES_QUERY_TIMEOUT_MS: "5000",
      POSTGRES_IDLE_TIMEOUT_MS: "1000",
      JOB_REPOSITORY_BACKEND: "postgres",
      MEDIA_STORAGE_BACKEND: "durable-volume",
      MEDIA_STORAGE_ROOT: volumeRoot,
      MEDIA_STORAGE_AUTHORITY_ID: AUTHORITY,
      MEDIA_STORAGE_MAX_JOB_BYTES: "10485760",
      MEDIA_STORAGE_MAX_OUTPUT_BYTES: "5242880",
      MEDIA_STORAGE_LOW_DISK_BYTES: "1048576",
      MEDIA_FINAL_TTL_SECONDS: "60"
    };
    const workerEnvironmentFor = (bridge) => ({
        ...common,
        NODE_ENV: "production",
        APP_PROCESS_ROLE: "worker",
        DATABASE_URL: bridge.databaseUrl,
        POSTGRES_SSL_MODE: "require",
        POSTGRES_CONNECTION_TIMEOUT_MS: "1000",
        NODE_EXTRA_CA_CERTS: bridge.certificateFile,
        OBSERVABILITY_ENABLED: "true",
        OBSERVABILITY_LOG_LEVEL: "info",
        OBSERVABILITY_READINESS_TIMEOUT_MS: "2000",
        OBSERVABILITY_METRICS_MAX_BYTES: String(INSTALLED_METRICS_MAX_BYTES),
        WORKER_OBSERVABILITY_HOST: "127.0.0.1",
        WORKER_OBSERVABILITY_PORT: String(workerObservabilityPort),
        WORKER_CONCURRENCY: "1",
        WORKER_POLL_INTERVAL_MS: "100",
        WORKER_PROGRESS_INTERVAL_MS: "250",
        WORKER_SHUTDOWN_GRACE_MS: "5000",
        WORKER_ATTEMPT_TIMEOUT_MS: "60000",
        JOB_LEASE_DURATION_MS: "15000",
        JOB_LEASE_RENEW_INTERVAL_MS: "1000",
        WORKER_CANCELLATION_POLL_INTERVAL_MS: "1000",
        JOB_RECOVERY_INTERVAL_MS: "5000",
        MAX_FILE_SIZE_MB: "5",
        MAX_VIDEO_DURATION_MINUTES: "1",
        DOWNLOAD_TIMEOUT_SECONDS: "10",
        FFPROBE_TIMEOUT_SECONDS: "10",
        FFMPEG_TIMEOUT_SECONDS: "10",
        FFMPEG_KILL_GRACE_SECONDS: "1",
        FFMPEG_THREADS: "1",
        FFMPEG_PATH: ffmpeg,
        FFPROBE_PATH: ffprobe
      });
    postgresTlsBridge = await createPostgresTlsBridge(databaseUrl, deploymentRoot);
    let workerEnvironment = workerEnvironmentFor(postgresTlsBridge);
    await validateInstalledReleaseReadiness({ installedRoot, common, workerEnvironment });
    await assertLoopbackClosed(workerObservabilityPort, "Migration/readiness");
    for (const host of ["0.0.0.0", "::", "192.0.2.1"]) {
      const rejected = await run(process.execPath, ["worker/main.mjs", "--check"], {
        cwd: installedRoot,
        env: { ...workerEnvironment, WORKER_OBSERVABILITY_HOST: host },
        timeout: 15_000,
        maxBuffer: 128 * 1024
      }).then(() => false, () => true);
      if (!rejected) throw new Error("Installed worker accepted a non-loopback observability host.");
    }

    const port = await availablePort();
    if (!port) throw new Error("Web loopback port was not allocated.");
    const webEnvironment = {
      ...common,
      NODE_ENV: "production",
      APP_PROCESS_ROLE: "web",
      DATABASE_URL: postgresTlsBridge.databaseUrl,
      POSTGRES_SSL_MODE: "require",
      POSTGRES_CONNECTION_TIMEOUT_MS: "1000",
      NODE_EXTRA_CA_CERTS: postgresTlsBridge.certificateFile,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      TRUST_PROXY_MODE: "nginx-single-host",
      OBSERVABILITY_ENABLED: "true",
      OBSERVABILITY_LOG_LEVEL: "info",
      OBSERVABILITY_READINESS_TIMEOUT_MS: "2000",
      OBSERVABILITY_METRICS_MAX_BYTES: String(INSTALLED_METRICS_MAX_BYTES)
    };
    const webStartedAt = Date.now();
    const web = spawn(process.execPath, ["server.js"], {
      cwd: installedRoot,
      env: webEnvironment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const webOutput = captureProcessOutput(web);
    try {
      const webReady = await waitForInstalledProcessReady({
        child: web,
        stdout: web.stdout,
        expectedRole: "web",
        expectedReleaseCommit: manifest.build.gitCommit,
        expectedReleaseId: installed.releaseId,
        startedAtMs: webStartedAt,
        timeoutMs: 30_000
      });
      const deadline = Date.now() + 30_000;
      let healthy = false;
      while (Date.now() < deadline) {
        if (web.exitCode !== null) throw new Error("Installed web exited during boot.");
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: AbortSignal.timeout(1_000)
          });
          if (response.ok) {
            healthy = true;
            break;
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (!healthy) throw new Error("Installed web health check timed out.");
      await verifyInstalledEndpointSet({
        role: "web",
        port,
        databaseUrl,
        volumeRoot
      });
      await postgresTlsBridge.close();
      postgresTlsBridge = undefined;
      await verifyDependencyOutage({ role: "web", port });
      await verifyInstalledProcessShutdown({
        child: web,
        stdout: web.stdout,
        readyRecord: webReady,
        expectedRole: "web",
        expectedReleaseCommit: manifest.build.gitCommit,
        expectedReleaseId: installed.releaseId,
        startedAtMs: webStartedAt,
        timeoutMs: 15_000,
        stderrText: webOutput.stderrText,
        verifyCleanup: () => assertLoopbackClosed(port, "Web")
      });
      validateInstalledStructuredLogs(webOutput.stdoutText(), {
        expectedRole: "web",
        expectedReleaseCommit: manifest.build.gitCommit,
        expectedReleaseId: installed.releaseId,
        startedAtMs: webStartedAt,
        requiredEvents: ["process.starting", "process.ready", "process.stopping", "process.stopped"]
      });
    } finally {
      webOutput.close();
      if (web.exitCode === null && web.signalCode === null) web.kill("SIGKILL");
    }

    postgresTlsBridge = await createPostgresTlsBridge(databaseUrl, deploymentRoot);
    workerEnvironment = workerEnvironmentFor(postgresTlsBridge);
    const workerStartedAt = Date.now();
    const worker = spawn(process.execPath, ["worker/main.mjs"], {
      cwd: installedRoot,
      env: workerEnvironment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const workerOutput = captureProcessOutput(worker);
    try {
      const workerReady = await waitForInstalledWorkerReady({
        child: worker,
        stdout: worker.stdout,
        expectedReleaseCommit: manifest.build.gitCommit,
        expectedReleaseId: installed.releaseId,
        startedAtMs: workerStartedAt,
        timeoutMs: 30_000
      });
      await verifyInstalledEndpointSet({
        role: "worker",
        port: workerObservabilityPort,
        databaseUrl,
        volumeRoot
      });
      await postgresTlsBridge.close();
      postgresTlsBridge = undefined;
      await verifyDependencyOutage({ role: "worker", port: workerObservabilityPort });
      await verifyInstalledProcessShutdown({
        child: worker,
        stdout: worker.stdout,
        readyRecord: workerReady,
        expectedRole: "worker",
        expectedReleaseCommit: manifest.build.gitCommit,
        expectedReleaseId: installed.releaseId,
        startedAtMs: workerStartedAt,
        timeoutMs: 15_000,
        stderrText: workerOutput.stderrText,
        verifyCleanup: () => assertLoopbackClosed(workerObservabilityPort, "Worker observability")
      });
      validateInstalledStructuredLogs(workerOutput.stdoutText(), {
        expectedRole: "worker",
        expectedReleaseCommit: manifest.build.gitCommit,
        expectedReleaseId: installed.releaseId,
        startedAtMs: workerStartedAt,
        requiredEvents: ["process.starting", "process.ready", "process.stopping", "process.stopped"]
      });
    } finally {
      workerOutput.close();
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    }
    console.info("Linux installed release observability validation passed.");
  } finally {
    await postgresTlsBridge?.close().catch(() => undefined);
    await makeWritable(deploymentRoot);
    await Promise.all([
      rm(deploymentRoot, { recursive: true, force: true }),
      rm(volumeRoot, { recursive: true, force: true })
    ]);
  }
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Linux installed release validation failed.");
    process.exitCode = 1;
  });
}
