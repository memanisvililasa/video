import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const COMMIT = /^[a-f0-9]{40}$/;
const LEVELS = new Set(["debug", "info", "warn", "error"]);
const EVENTS = new Set([
  "process.starting",
  "process.ready",
  "process.not_ready",
  "process.stopping",
  "process.stopped",
  "config.invalid",
  "db.connected",
  "db.unavailable",
  "migration.status",
  "migration.mismatch"
]);
const REASON_CODES = new Set([
  "none",
  "invalid_configuration",
  "database_unavailable",
  "schema_mismatch",
  "internal_error"
]);
const SAFE_METADATA_KEYS = new Set(["command", "total", "applied", "pending"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

async function releaseMetadata(nodeEnv) {
  if (nodeEnv !== "production") {
    return { releaseCommit: "0".repeat(40), releaseId: `videosave-${nodeEnv === "test" ? "test" : "local"}` };
  }
  let manifest;
  try {
    const raw = await readFile(new URL("../release-manifest.json", import.meta.url), "utf8");
    if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error();
    manifest = JSON.parse(raw);
  } catch {
    throw new TypeError("Production release metadata is unavailable.");
  }
  const commit = manifest?.build?.gitCommit;
  const version = manifest?.application?.version;
  if (manifest?.schemaVersion !== 1 || manifest?.application?.name !== "videosave" ||
      typeof commit !== "string" || !COMMIT.test(commit) ||
      typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) {
    throw new TypeError("Production release metadata is incompatible.");
  }
  return { releaseCommit: commit, releaseId: `videosave-${version}-${commit.slice(0, 12)}` };
}

function safeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output = {};
  for (const key of Object.keys(value).sort().slice(0, 16)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    const item = value[key];
    if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
    else if (typeof item === "boolean" || item === null) output[key] = item;
    else if (typeof item === "string" && /^[a-zA-Z0-9_.-]{1,64}$/.test(item)) output[key] = item;
  }
  return output;
}

export async function createMigrationOperationalLogger(source = process.env) {
  const level = source.OBSERVABILITY_LOG_LEVEL?.trim().toLowerCase() || "info";
  if (!LEVELS.has(level)) throw new TypeError("OBSERVABILITY_LOG_LEVEL is invalid.");
  const release = await releaseMetadata(source.NODE_ENV?.trim());
  const threshold = ["debug", "info", "warn", "error"].indexOf(level);
  const base = Object.freeze({
    schemaVersion: "1.0",
    service: "videosave",
    processRole: "migration",
    processInstanceId: randomBytes(16).toString("hex"),
    ...release
  });
  function write(logLevel, event, fields = {}) {
    try {
      if (!LEVELS.has(logLevel) || ["debug", "info", "warn", "error"].indexOf(logLevel) < threshold) return;
      const record = {
        schemaVersion: base.schemaVersion,
        timestamp: new Date().toISOString(),
        level: logLevel,
        event: EVENTS.has(event) ? event : "config.invalid",
        service: base.service,
        processRole: base.processRole,
        processInstanceId: base.processInstanceId,
        releaseCommit: base.releaseCommit,
        releaseId: base.releaseId,
        outcome: ["success", "failure", "rejected"].includes(fields.outcome) ? fields.outcome : "success",
        reasonCode: typeof fields.reasonCode === "string" && REASON_CODES.has(fields.reasonCode)
          ? fields.reasonCode : "none",
        ...(fields.metadata ? { metadata: safeMetadata(fields.metadata) } : {})
      };
      const line = JSON.stringify(record).replace(CONTROL, " ");
      (logLevel === "warn" || logLevel === "error" ? process.stderr : process.stdout).write(`${line}\n`);
    } catch {}
  }
  return Object.freeze({
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  });
}
