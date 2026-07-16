import "server-only";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  OBSERVABILITY_SCHEMA_VERSION,
  PROCESS_ROLES,
  type ObservedProcessRole,
  type ProcessMetadata
} from "@/lib/observability/contract";

const RELEASE_COMMIT = /^[a-f0-9]{40}$/;
const RELEASE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PROCESS_INSTANCE_ID = /^[a-f0-9]{32}$/;
const MAX_MANIFEST_BYTES = 256 * 1024;

type ReleaseManifest = Readonly<{
  schemaVersion?: unknown;
  application?: { name?: unknown; version?: unknown };
  build?: { gitCommit?: unknown };
}>;

export type CreateProcessMetadataOptions = Readonly<{
  source?: Readonly<Record<string, string | undefined>>;
  role?: ObservedProcessRole;
  cwd?: string;
  readManifest?: (filename: string) => Promise<string>;
  processInstanceId?: () => string;
}>;

function parseRole(source: Readonly<Record<string, string | undefined>>, explicit?: ObservedProcessRole): ObservedProcessRole {
  const value = explicit ?? source.APP_PROCESS_ROLE?.trim() ?? "local";
  if (!(PROCESS_ROLES as readonly string[]).includes(value)) throw new TypeError("Process role metadata is invalid.");
  return value as ObservedProcessRole;
}

async function defaultReadManifest(filename: string): Promise<string> {
  return readFile(filename, { encoding: "utf8", flag: "r" });
}

function localMetadata(
  role: ObservedProcessRole,
  category: "local" | "test",
  instanceId: string
): ProcessMetadata {
  return Object.freeze({
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    service: "videosave" as const,
    processRole: role,
    processInstanceId: instanceId,
    releaseCommit: "0".repeat(40),
    releaseId: `videosave-${category}`,
    releaseCategory: category
  });
}

export async function createProcessMetadata(
  options: CreateProcessMetadataOptions = {}
): Promise<ProcessMetadata> {
  const source = options.source ?? process.env;
  const role = parseRole(source, options.role);
  const instanceId = (options.processInstanceId ?? (() => randomBytes(16).toString("hex")))();
  if (!PROCESS_INSTANCE_ID.test(instanceId)) throw new TypeError("Process instance metadata is invalid.");

  const nodeEnv = source.NODE_ENV?.trim();
  if (nodeEnv !== "production") return localMetadata(role, nodeEnv === "test" ? "test" : "local", instanceId);
  if (role === "local") throw new TypeError("Production process metadata cannot use the local role.");

  const filename = path.join(options.cwd ?? process.cwd(), "release-manifest.json");
  let raw: string;
  try {
    raw = await (options.readManifest ?? defaultReadManifest)(filename);
  } catch {
    throw new TypeError("Production release metadata is unavailable.");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) {
    throw new TypeError("Production release metadata is oversized.");
  }
  let manifest: ReleaseManifest;
  try {
    manifest = JSON.parse(raw) as ReleaseManifest;
  } catch {
    throw new TypeError("Production release metadata is invalid.");
  }
  const commit = manifest.build?.gitCommit;
  const version = manifest.application?.version;
  if (
    manifest.schemaVersion !== 2 ||
    manifest.application?.name !== "videosave" ||
    typeof commit !== "string" ||
    !RELEASE_COMMIT.test(commit) ||
    typeof version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)
  ) {
    throw new TypeError("Production release metadata is incompatible.");
  }
  const releaseId = `videosave-${version}-${commit.slice(0, 12)}`;
  if (!RELEASE_ID.test(releaseId)) throw new TypeError("Production release ID is invalid.");
  return Object.freeze({
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    service: "videosave" as const,
    processRole: role,
    processInstanceId: instanceId,
    releaseCommit: commit,
    releaseId,
    releaseCategory: "production" as const
  });
}
