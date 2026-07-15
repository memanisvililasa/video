import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_MIGRATION_CATALOG } from "../scripts/postgres-migration-catalog.mjs";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const APPROVED_NODE_VERSION = "24.18.0";
export const APPROVED_NPM_VERSION = "11.6.0";
export const RELEASE_ROOT_DIRECTORY = ".release-dist/release";
export const RELEASE_CHECKSUMS_FILE = "checksums.sha256";
export const RELEASE_MANIFEST_FILE = "release-manifest.json";
export const REQUIRED_MIGRATIONS = Object.freeze(POSTGRES_MIGRATION_CATALOG.map(({ version, file }) =>
  Object.freeze({ version, file })
));
export const REQUIRED_RUNTIME_PACKAGES = Object.freeze(["next", "pg", "react", "react-dom"]);
export const RELEASE_ENTRYPOINTS = Object.freeze({
  web: "server.js",
  webReadiness: "checks/web-readiness.mjs",
  cutoverReadiness: "checks/cutover-readiness.mjs",
  worker: "worker/main.mjs",
  workerReadiness: "worker/main.mjs --check",
  migration: "scripts/postgres-migrations.mjs",
  productionSmoke: "smoke/production-smoke.mjs",
  releaseVerify: "tools/verify-release.mjs"
});

const ALLOWED_TOP_LEVEL = new Set([
  ".next",
  "checks",
  "db",
  "node_modules",
  "public",
  "scripts",
  "smoke",
  "tools",
  "worker",
  RELEASE_CHECKSUMS_FILE,
  RELEASE_MANIFEST_FILE,
  "package.json",
  "server.js"
]);
const FORBIDDEN_TOP_LEVEL = new Set([
  ".git",
  "app",
  "components",
  "coverage",
  "lib",
  "playwright-report",
  "storage",
  "test-results",
  "tests"
]);
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /postgres(?:ql)?:\/\/[^<\s:@/]+:[^<\s@/]+@/i
]);
const LOCAL_PATH_PATTERNS = Object.freeze([
  /\/Users\/[A-Za-z0-9._-]+\//,
  /\/home\/runner\/work\//,
  /[A-Za-z]:\\Users\\[^\\]+\\/
]);
const TEXT_FILE = /\.(?:c?js|mjs|json|css|html|sql|txt|md|xml|map)$/i;
const MAX_SCANNED_TEXT_BYTES = 2 * 1024 * 1024;
const HASH_LINE = /^([a-f0-9]{64})  ([!-~]+)$/;
const MIGRATION_CATALOG_MODULE = fileURLToPath(new URL("../scripts/postgres-migration-catalog.mjs", import.meta.url));

export class ReleaseContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseContractError";
  }
}

function releaseError(message) {
  return new ReleaseContractError(message);
}

export function normalizeReleasePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw releaseError("Release path is invalid.");
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized === "." ||
    normalized === ".." ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw releaseError("Release path escapes its root.");
  }
  return normalized;
}

export function stableJson(value) {
  function normalize(input) {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input).sort().map((key) => [key, normalize(input[key])])
      );
    }
    return input;
  }
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function assertReleaseToolchain(input) {
  if (input.nodeVersion !== APPROVED_NODE_VERSION) {
    throw releaseError(
      `Release builds require Node.js ${APPROVED_NODE_VERSION}; found ${input.nodeVersion || "unknown"}.`
    );
  }
  if (input.npmVersion !== APPROVED_NPM_VERSION) {
    throw releaseError(
      `Release builds require npm ${APPROVED_NPM_VERSION}; found ${input.npmVersion || "unknown"}.`
    );
  }
}

export async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export async function listReleaseFiles(root) {
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) throw releaseError("Release root is unavailable.");
  const rootInfo = await lstat(rootReal);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw releaseError("Release root must be a regular directory.");
  }
  const files = [];
  async function walk(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = normalizeReleasePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw releaseError(`Release symlink is forbidden: ${relative}`);
      if (info.isDirectory()) {
        await walk(absolute, relative);
      } else if (info.isFile()) {
        if ((info.mode & 0o111) !== 0) {
          throw releaseError(`Unexpected executable file: ${relative}`);
        }
        files.push(Object.freeze({ relative, absolute, size: info.size }));
      } else {
        throw releaseError(`Unsupported release entry: ${relative}`);
      }
    }
  }
  await walk(rootReal);
  return Object.freeze(files);
}

export async function hashReleaseFiles(root, options = {}) {
  const excluded = new Set(options.exclude ?? []);
  const files = await listReleaseFiles(root);
  const records = [];
  for (const file of files) {
    if (excluded.has(file.relative)) continue;
    records.push(Object.freeze({
      path: file.relative,
      size: file.size,
      sha256: await sha256File(file.absolute)
    }));
  }
  return Object.freeze(records);
}

export function canonicalTreeHash(records, predicate = () => true) {
  const hash = createHash("sha256");
  for (const record of records.filter(predicate).sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    hash.update(record.path);
    hash.update("\0");
    hash.update(String(record.size));
    hash.update("\0");
    hash.update(record.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function formatChecksums(records) {
  return `${records
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path, "en"))
    .map((record) => `${record.sha256}  ${record.path}`)
    .join("\n")}\n`;
}

export function parseChecksums(value) {
  if (typeof value !== "string" || !value.endsWith("\n")) {
    throw releaseError("Release checksums format is invalid.");
  }
  const records = [];
  const seen = new Set();
  for (const line of value.slice(0, -1).split("\n")) {
    const match = HASH_LINE.exec(line);
    if (!match) throw releaseError("Release checksums format is invalid.");
    const relative = normalizeReleasePath(match[2]);
    if (seen.has(relative)) throw releaseError("Release checksums contain duplicates.");
    seen.add(relative);
    records.push(Object.freeze({ path: relative, sha256: match[1] }));
  }
  const sorted = records.slice().sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (records.some((record, index) => record.path !== sorted[index].path)) {
    throw releaseError("Release checksums are not sorted.");
  }
  return Object.freeze(records);
}

async function scanTextFile(file, builderRoot) {
  if (file.size > MAX_SCANNED_TEXT_BYTES || !TEXT_FILE.test(file.relative)) return;
  const bytes = await readFile(file.absolute);
  if (bytes.includes(0)) return;
  const content = bytes.toString("utf8");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    throw releaseError(`Potential credential material is forbidden: ${file.relative}`);
  }
  if (!file.relative.startsWith("node_modules/") && LOCAL_PATH_PATTERNS.some((pattern) => pattern.test(content))) {
    throw releaseError(`Local build path is forbidden: ${file.relative}`);
  }
  if (builderRoot && !file.relative.startsWith("node_modules/") && content.includes(builderRoot)) {
    throw releaseError(`Builder root leaked into release: ${file.relative}`);
  }
}

function validateReleasePath(relative) {
  const parts = relative.split("/");
  const top = parts[0];
  if (!ALLOWED_TOP_LEVEL.has(top) || FORBIDDEN_TOP_LEVEL.has(top)) {
    throw releaseError(`Unexpected release path: ${relative}`);
  }
  if (
    relative === ".env" ||
    relative.startsWith(".env.") ||
    parts.includes(".git") ||
    parts.includes("coverage") ||
    parts.includes("screenshots") ||
    parts.includes("browser-attachments") ||
    parts.includes("test-results") ||
    parts.includes("pg_wal") ||
    parts.includes("PG_VERSION") ||
    relative.startsWith(".next/cache/") ||
    /(?:^|\/)tests?(?:\/|$)/i.test(relative) ||
    /(?:^|\/)fixtures?(?:\/|$)/i.test(relative) ||
    /\.(?:map|log|mp4|mov|webm|m4a|part|tmp)$/i.test(relative)
  ) {
    throw releaseError(`Forbidden release content: ${relative}`);
  }
}

function assertNoLocalPackageDependencies(value, relative) {
  for (const group of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    const dependencies = value?.[group];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const specifier of Object.values(dependencies)) {
      if (typeof specifier === "string" && /^(?:file|link|workspace):/i.test(specifier)) {
        throw releaseError(`Local package dependency is forbidden: ${relative}`);
      }
    }
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw releaseError("Release manifest schema is unsupported.");
  }
  if (manifest.application?.name !== "videosave" || typeof manifest.application?.version !== "string") {
    throw releaseError("Release application metadata is invalid.");
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.build?.gitCommit ?? "")) {
    throw releaseError("Release Git commit is invalid.");
  }
  if (
    !/^[a-f0-9]{40}$/.test(manifest.build?.gitTree ?? "") ||
    manifest.build?.nodeVersion !== APPROVED_NODE_VERSION ||
    manifest.build?.npmVersion !== APPROVED_NPM_VERSION ||
    !Number.isSafeInteger(manifest.build?.sourceDateEpoch) ||
    manifest.build.sourceDateEpoch < 0 ||
    manifest.build?.timestamp !== new Date(manifest.build.sourceDateEpoch * 1_000).toISOString() ||
    !/^[a-z0-9_-]+-[a-z0-9_-]+$/i.test(manifest.build?.target ?? "") ||
    typeof manifest.build?.sourceTreeDirty !== "boolean"
  ) {
    throw releaseError("Release toolchain metadata is invalid.");
  }
  if (manifest.runtimeAuthority !== "postgres-durable" || manifest.storageMarkerVersion !== "v2") {
    throw releaseError("Release runtime authority is invalid.");
  }
  if (stableJson(manifest.entrypoints) !== stableJson(RELEASE_ENTRYPOINTS)) {
    throw releaseError("Release entrypoints do not match the contract.");
  }
  if (!Array.isArray(manifest.migrations) || manifest.migrations.length !== REQUIRED_MIGRATIONS.length) {
    throw releaseError("Release migration catalog is invalid.");
  }
  for (const [index, expected] of REQUIRED_MIGRATIONS.entries()) {
    const migration = manifest.migrations[index];
    if (
      migration?.version !== expected.version ||
      migration?.file !== expected.file ||
      !/^[a-f0-9]{64}$/.test(migration?.sha256 ?? "")
    ) {
      throw releaseError("Release migration catalog is invalid.");
    }
  }
  if (
    !/^[a-f0-9]{64}$/.test(manifest.artifacts?.webSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(manifest.artifacts?.workerSha256 ?? "")
  ) {
    throw releaseError("Release artifact hashes are invalid.");
  }
  return manifest;
}

function webArtifactPath(input) {
  const relative = typeof input === "string" ? input : input.path;
  return (
    relative === "server.js" ||
    relative === "package.json" ||
    relative.startsWith(".next/") ||
    relative.startsWith("node_modules/") ||
    relative.startsWith("public/")
  );
}

export async function verifyReleaseRoot(root, options = {}) {
  const files = await listReleaseFiles(root);
  const paths = new Set(files.map((file) => file.relative));
  for (const file of files) {
    validateReleasePath(file.relative);
    await scanTextFile(file, options.builderRoot);
    if (path.basename(file.relative) === "package.json") {
      let metadata;
      try {
        metadata = JSON.parse(await readFile(file.absolute, "utf8"));
      } catch {
        throw releaseError(`Package metadata is invalid: ${file.relative}`);
      }
      assertNoLocalPackageDependencies(metadata, file.relative);
    }
  }
  for (const entrypoint of [
    RELEASE_ENTRYPOINTS.web,
    RELEASE_ENTRYPOINTS.webReadiness,
    RELEASE_ENTRYPOINTS.cutoverReadiness,
    RELEASE_ENTRYPOINTS.worker,
    RELEASE_ENTRYPOINTS.migration,
    RELEASE_ENTRYPOINTS.productionSmoke,
    RELEASE_ENTRYPOINTS.releaseVerify,
    "scripts/postgres-migration-catalog.mjs",
    "tools/release-contract.mjs",
    RELEASE_MANIFEST_FILE,
    RELEASE_CHECKSUMS_FILE,
    ".next/BUILD_ID",
    ...REQUIRED_RUNTIME_PACKAGES.map((name) => `node_modules/${name}/package.json`)
  ]) {
    if (!paths.has(entrypoint)) throw releaseError(`Required release file is missing: ${entrypoint}`);
  }
  if (![...paths].some((relative) => relative.startsWith(".next/static/"))) {
    throw releaseError("Next.js static assets are missing.");
  }

  const manifest = validateManifest(JSON.parse(await readFile(path.join(root, RELEASE_MANIFEST_FILE), "utf8")));
  const currentTarget = options.expectedTarget ?? `${process.platform}-${process.arch}`;
  if (!/^[a-z0-9_-]+-[a-z0-9_-]+$/i.test(currentTarget)) {
    throw releaseError("Expected release target is invalid.");
  }
  if (manifest.build.target !== currentTarget) {
    throw releaseError(`Release target does not match this runtime: expected ${currentTarget}.`);
  }
  const runtimePackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const buildId = (await readFile(path.join(root, ".next/BUILD_ID"), "utf8")).trim();
  if (buildId !== manifest.build.gitCommit) throw releaseError("Next.js build ID does not match the release commit.");
  const dependencyNames = Object.keys(runtimePackage.dependencies ?? {}).sort();
  if (
    runtimePackage.name !== manifest.application.name ||
    runtimePackage.version !== manifest.application.version ||
    runtimePackage.private !== true ||
    runtimePackage.packageManager !== `npm@${APPROVED_NPM_VERSION}` ||
    runtimePackage.engines?.node !== APPROVED_NODE_VERSION ||
    runtimePackage.engines?.npm !== APPROVED_NPM_VERSION ||
    stableJson(dependencyNames) !== stableJson([...REQUIRED_RUNTIME_PACKAGES].sort()) ||
    runtimePackage.scripts !== undefined ||
    runtimePackage.devDependencies !== undefined
  ) {
    throw releaseError("Release runtime package metadata is invalid.");
  }
  const expectedChecksums = parseChecksums(await readFile(path.join(root, RELEASE_CHECKSUMS_FILE), "utf8"));
  const actual = await hashReleaseFiles(root, { exclude: [RELEASE_CHECKSUMS_FILE] });
  const actualByPath = new Map(actual.map((record) => [record.path, record]));
  if (expectedChecksums.length !== actual.length) throw releaseError("Release checksum coverage is incomplete.");
  for (const expected of expectedChecksums) {
    const record = actualByPath.get(expected.path);
    if (!record || record.sha256 !== expected.sha256) {
      throw releaseError(`Release checksum mismatch: ${expected.path}`);
    }
  }

  const migrationByFile = new Map(manifest.migrations.map((migration) => [migration.file, migration]));
  const catalogRecord = actualByPath.get("scripts/postgres-migration-catalog.mjs");
  if (!catalogRecord || catalogRecord.sha256 !== await sha256File(MIGRATION_CATALOG_MODULE)) {
    throw releaseError("Migration catalog module does not match the release verifier.");
  }
  for (const expected of REQUIRED_MIGRATIONS) {
    const relative = `db/migrations/${expected.file}`;
    const record = actualByPath.get(relative);
    const catalog = POSTGRES_MIGRATION_CATALOG.find((migration) =>
      migration.version === expected.version && migration.file === expected.file
    );
    if (
      !record || !catalog || record.sha256 !== catalog.checksum ||
      migrationByFile.get(expected.file)?.sha256 !== record.sha256
    ) {
      throw releaseError(`Migration checksum mismatch: ${expected.version}`);
    }
  }
  const worker = actualByPath.get(RELEASE_ENTRYPOINTS.worker);
  if (!worker || worker.sha256 !== manifest.artifacts.workerSha256) {
    throw releaseError("Worker artifact hash does not match the manifest.");
  }

  for (const file of files.filter((candidate) => candidate.relative.startsWith(".next/static/"))) {
    if (file.size > MAX_SCANNED_TEXT_BYTES) continue;
    const content = await readFile(file.absolute, "utf8");
    if (/createProductionMediaWorkerRuntime|lib\/worker|node_modules\/pg|DATABASE_URL/.test(content)) {
      throw releaseError(`Server-only module leaked into client assets: ${file.relative}`);
    }
  }
  if (canonicalTreeHash(actual, webArtifactPath) !== manifest.artifacts.webSha256) {
    throw releaseError("Web artifact hash does not match the manifest.");
  }
  return Object.freeze({ manifest, files: Object.freeze(files.map((file) => file.relative)) });
}

export async function releaseDirectorySize(root) {
  const files = await listReleaseFiles(root);
  return files.reduce((total, file) => total + file.size, 0);
}

export async function assertRegularFile(filename) {
  const info = await stat(filename).catch(() => null);
  if (!info?.isFile()) throw releaseError(`Required source artifact is missing: ${filename}`);
}
