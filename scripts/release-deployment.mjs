import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import {
  RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_MANIFEST_FILE,
  normalizeReleasePath,
  sha256File,
  stableJson,
  verifyReleaseRoot
} from "./release-contract.mjs";

const TAR_BLOCK = 512;
const MAX_ARCHIVE_FILE_BYTES = 32 * 1024 * 1024 * 1024;
const RELEASE_ID = /^videosave-[A-Za-z0-9][A-Za-z0-9._-]{0,63}-[a-f0-9]{12}$/;

export class ReleaseDeploymentError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReleaseDeploymentError";
    this.code = code;
  }
}

function fail(code) {
  throw new ReleaseDeploymentError(code);
}

function safeAbsolute(value, code) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) fail(code);
  return value;
}

async function regularFile(value, code) {
  const requested = safeAbsolute(value, code);
  const info = await lstat(requested).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) fail(code);
  const canonical = await realpath(requested).catch(() => null);
  if (canonical !== requested) fail(code);
  return requested;
}

async function canonicalDirectory(value, code) {
  const requested = safeAbsolute(value, code);
  const info = await lstat(requested).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) fail(code);
  const canonical = await realpath(requested).catch(() => null);
  if (canonical !== requested) fail(code);
  return canonical;
}

async function deploymentLayout(rootValue) {
  const root = await canonicalDirectory(rootValue, "deployment-root-invalid");
  const releases = await canonicalDirectory(path.join(root, "releases"), "releases-root-invalid");
  if (path.dirname(releases) !== root) fail("releases-root-invalid");
  return Object.freeze({ root, releases, current: path.join(root, "current") });
}

function parseOctal(buffer, start, length) {
  const encoded = buffer.subarray(start, start + length).toString("ascii").replace(/[\0 ]+$/g, "");
  if (!/^[0-7]+$/.test(encoded)) fail("archive-header-invalid");
  const value = Number.parseInt(encoded, 8);
  if (!Number.isSafeInteger(value)) fail("archive-header-invalid");
  return value;
}

function verifyHeaderChecksum(header) {
  const expected = parseOctal(header, 148, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (actual !== expected) fail("archive-header-checksum-invalid");
}

function archivePath(header) {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
  try {
    return normalizeReleasePath(prefix ? `${prefix}/${name}` : name);
  } catch {
    fail("archive-path-invalid");
  }
}

function contained(root, relative) {
  const target = path.join(root, ...relative.split("/"));
  const resolved = path.resolve(target);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) fail("archive-path-invalid");
  return resolved;
}

async function extractVerifiedUstarGzip(archive, destination) {
  const seen = new Set();
  let buffer = Buffer.alloc(0);
  let current = null;
  let padding = 0;
  let terminalBlocks = 0;
  const stream = createReadStream(archive).pipe(createGunzip());
  try {
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (current) {
          if (current.remaining > 0) {
            if (buffer.length === 0) break;
            const consumed = Math.min(buffer.length, current.remaining);
            const slice = buffer.subarray(0, consumed);
            await current.handle.write(slice, 0, slice.length, current.position);
            current.hash.update(slice);
            current.position += consumed;
            current.remaining -= consumed;
            buffer = buffer.subarray(consumed);
            if (current.remaining > 0) break;
          }
          await current.handle.sync();
          await current.handle.close();
          await chmod(current.target, 0o444);
          padding = (TAR_BLOCK - (current.size % TAR_BLOCK)) % TAR_BLOCK;
          current = null;
        }
        if (padding > 0) {
          if (buffer.length < padding) break;
          if (!buffer.subarray(0, padding).equals(Buffer.alloc(padding))) fail("archive-padding-invalid");
          buffer = buffer.subarray(padding);
          padding = 0;
        }
        if (buffer.length < TAR_BLOCK) break;
        const header = buffer.subarray(0, TAR_BLOCK);
        buffer = buffer.subarray(TAR_BLOCK);
        if (header.equals(Buffer.alloc(TAR_BLOCK))) {
          terminalBlocks += 1;
          if (terminalBlocks > 2) fail("archive-terminator-invalid");
          continue;
        }
        if (terminalBlocks > 0) fail("archive-terminator-invalid");
        verifyHeaderChecksum(header);
        if (header[156] !== 0 && header[156] !== "0".charCodeAt(0)) fail("archive-entry-type-forbidden");
        const relative = archivePath(header);
        if (seen.has(relative)) fail("archive-entry-duplicate");
        seen.add(relative);
        const size = parseOctal(header, 124, 12);
        if (size < 0 || size > MAX_ARCHIVE_FILE_BYTES) fail("archive-file-size-invalid");
        const target = contained(destination, relative);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
        const handle = await open(target, "wx", 0o600).catch(() => fail("archive-extraction-failed"));
        current = {
          relative,
          target,
          size,
          remaining: size,
          position: 0,
          handle,
          hash: createHash("sha256")
        };
      }
    }
  } catch (error) {
    await current?.handle.close().catch(() => undefined);
    if (error instanceof ReleaseDeploymentError) throw error;
    fail("archive-extraction-failed");
  }
  if (current || padding !== 0 || terminalBlocks !== 2 || buffer.length !== 0 || seen.size === 0) {
    fail("archive-incomplete");
  }
}

async function verifyArchiveChecksum(archiveValue, checksumValue) {
  const archive = await regularFile(archiveValue, "archive-invalid");
  const checksum = await regularFile(checksumValue, "archive-checksum-file-invalid");
  const content = await readFile(checksum, "utf8").catch(() => fail("archive-checksum-file-invalid"));
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz)\n$/.exec(content);
  if (!match || match[2] !== path.basename(archive)) fail("archive-checksum-file-invalid");
  if (await sha256File(archive) !== match[1]) fail("archive-checksum-mismatch");
  return archive;
}

function releaseId(manifest) {
  const version = manifest?.application?.version;
  const commit = manifest?.build?.gitCommit;
  if (
    typeof version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version) ||
    !/^[a-f0-9]{40}$/.test(commit ?? "")
  ) fail("release-identity-invalid");
  const id = `videosave-${version}-${commit.slice(0, 12)}`;
  if (!RELEASE_ID.test(id)) fail("release-identity-invalid");
  return id;
}

async function makeReadonly(root) {
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) fail("installed-release-symlink");
      if (info.isDirectory()) await visit(target);
      else if (info.isFile()) await chmod(target, 0o444);
      else fail("installed-release-entry-invalid");
    }
    await chmod(directory, 0o555);
  }
  await visit(root);
}

async function assertReadonly(root) {
  async function visit(directory) {
    const info = await lstat(directory);
    if ((info.mode & 0o222) !== 0) fail("installed-release-writable");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const child = await lstat(target);
      if (child.isSymbolicLink()) fail("installed-release-symlink");
      if (child.isDirectory()) await visit(target);
      else if (!child.isFile() || (child.mode & 0o222) !== 0) fail("installed-release-writable");
    }
  }
  await visit(root);
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function installRelease({
  archive: archiveValue,
  checksum: checksumValue,
  deploymentRoot,
  dryRun = false
}) {
  const archive = await verifyArchiveChecksum(archiveValue, checksumValue);
  const layout = await deploymentLayout(deploymentRoot);
  const staging = dryRun
    ? await realpath(await mkdtemp(path.join(os.tmpdir(), "videosave-release-dry-run-")))
    : path.join(layout.releases, `.install-${randomUUID()}`);
  if (!dryRun) await mkdir(staging, { mode: 0o700 });
  try {
    await extractVerifiedUstarGzip(archive, staging);
    const { manifest } = await verifyReleaseRoot(staging);
    if (manifest.build.sourceTreeDirty !== false) fail("dirty-release-forbidden");
    const id = releaseId(manifest);
    const target = contained(layout.releases, id);
    if (await lstat(target).then(() => true, () => false)) fail("release-already-installed");
    if (dryRun) return Object.freeze({ outcome: "would-install", releaseId: id, changed: false });
    await makeReadonly(staging);
    await assertReadonly(staging);
    await rename(staging, target).catch((error) => {
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") fail("release-already-installed");
      fail("release-install-rename-failed");
    });
    await syncDirectory(layout.releases);
    return Object.freeze({ outcome: "installed", releaseId: id, changed: true });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function inspectInstalledRelease({ deploymentRoot, releaseId: requestedId }) {
  if (!RELEASE_ID.test(requestedId ?? "")) fail("release-id-invalid");
  const layout = await deploymentLayout(deploymentRoot);
  const target = contained(layout.releases, requestedId);
  const canonical = await canonicalDirectory(target, "installed-release-invalid");
  if (path.dirname(canonical) !== layout.releases) fail("installed-release-invalid");
  const { manifest } = await verifyReleaseRoot(canonical);
  if (releaseId(manifest) !== requestedId || manifest.build.sourceTreeDirty !== false) {
    fail("installed-release-invalid");
  }
  await assertReadonly(canonical);
  return Object.freeze({ releaseId: requestedId, manifest });
}

async function currentRelease(layout) {
  const info = await lstat(layout.current).catch(() => null);
  if (!info) return null;
  if (!info.isSymbolicLink()) fail("current-not-symlink");
  const raw = await readlink(layout.current);
  const resolved = path.resolve(layout.root, raw);
  if (path.dirname(resolved) !== layout.releases) fail("current-symlink-escape");
  const id = path.basename(resolved);
  if (!RELEASE_ID.test(id)) fail("current-symlink-invalid");
  const canonical = await realpath(layout.current).catch(() => null);
  if (canonical !== resolved) fail("current-symlink-invalid");
  return id;
}

export async function promoteRelease({
  deploymentRoot,
  releaseId: requestedId,
  confirm = false,
  dryRun = false
}) {
  const inspected = await inspectInstalledRelease({ deploymentRoot, releaseId: requestedId });
  const layout = await deploymentLayout(deploymentRoot);
  const previousReleaseId = await currentRelease(layout);
  if (!confirm && !dryRun) fail("promotion-confirmation-required");
  if (previousReleaseId === inspected.releaseId) {
    return Object.freeze({
      outcome: "already-current",
      previousReleaseId,
      currentReleaseId: inspected.releaseId,
      changed: false
    });
  }
  if (dryRun) {
    return Object.freeze({
      outcome: "would-promote",
      previousReleaseId,
      currentReleaseId: inspected.releaseId,
      changed: false
    });
  }
  const temporary = path.join(layout.root, `.current-${randomUUID()}`);
  try {
    await symlink(path.join("releases", inspected.releaseId), temporary);
    await rename(temporary, layout.current);
    await syncDirectory(layout.root);
  } catch (error) {
    if (error instanceof ReleaseDeploymentError) throw error;
    fail("promotion-failed");
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return Object.freeze({
    outcome: "promoted",
    previousReleaseId,
    currentReleaseId: inspected.releaseId,
    changed: true
  });
}

function compatibilityProjection(manifest) {
  return Object.freeze({
    manifestSchema: manifest.schemaVersion,
    migrations: manifest.migrations,
    runtimeAuthority: manifest.runtimeAuthority,
    storageMarkerVersion: manifest.storageMarkerVersion,
    roles: Object.freeze({
      web: manifest.entrypoints?.web,
      worker: manifest.entrypoints?.worker,
      migration: manifest.entrypoints?.migration
    })
  });
}

export async function checkRollbackCompatibility({ deploymentRoot, fromReleaseId, toReleaseId }) {
  let from;
  let to;
  try {
    from = await inspectInstalledRelease({ deploymentRoot, releaseId: fromReleaseId });
  } catch {
    return Object.freeze({
      outcome: "blocked",
      fromReleaseId,
      toReleaseId,
      reasons: Object.freeze(["current-release-invalid"])
    });
  }
  try {
    to = await inspectInstalledRelease({ deploymentRoot, releaseId: toReleaseId });
  } catch {
    return Object.freeze({
      outcome: "blocked",
      fromReleaseId,
      toReleaseId,
      reasons: Object.freeze(["target-release-invalid"])
    });
  }
  const fromContract = compatibilityProjection(from.manifest);
  const toContract = compatibilityProjection(to.manifest);
  const reasons = [];
  if (fromContract.manifestSchema !== RELEASE_MANIFEST_SCHEMA_VERSION || toContract.manifestSchema !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    reasons.push("manifest-schema");
  }
  if (fromContract.runtimeAuthority !== "postgres-durable" || toContract.runtimeAuthority !== "postgres-durable") {
    reasons.push("runtime-authority");
  }
  if (fromContract.storageMarkerVersion !== toContract.storageMarkerVersion) reasons.push("storage-marker");
  if (stableJson(fromContract.migrations) !== stableJson(toContract.migrations)) reasons.push("migration-catalog");
  if (stableJson(fromContract.roles) !== stableJson(toContract.roles)) reasons.push("runtime-role-entrypoints");
  return Object.freeze({
    outcome: reasons.length === 0 ? "compatible" : "blocked",
    fromReleaseId,
    toReleaseId,
    reasons: Object.freeze(reasons)
  });
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["install", "inspect", "promote", "rollback-check"]).has(command)) fail("command-invalid");
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (current === "--dry-run" || current === "--confirm") {
      if (flags.has(current)) fail("arguments-invalid");
      flags.add(current);
      continue;
    }
    if (!new Set([
      "--archive", "--checksum", "--root", "--release-id", "--from", "--to"
    ]).has(current)) fail("arguments-invalid");
    const value = rest[index + 1];
    if (!value || value.startsWith("--") || values.has(current)) fail("arguments-invalid");
    values.set(current, value);
    index += 1;
  }
  if (!values.has("--root")) fail("arguments-invalid");
  return Object.freeze({ command, values, flags });
}

async function main() {
  const { command, values, flags } = parseCli(process.argv.slice(2));
  const deploymentRoot = values.get("--root");
  let result;
  if (command === "install") {
    if (!values.has("--archive") || !values.has("--checksum")) fail("arguments-invalid");
    result = await installRelease({
      archive: values.get("--archive"),
      checksum: values.get("--checksum"),
      deploymentRoot,
      dryRun: flags.has("--dry-run")
    });
  } else if (command === "inspect") {
    result = await inspectInstalledRelease({ deploymentRoot, releaseId: values.get("--release-id") });
    result = { outcome: "verified", releaseId: result.releaseId };
  } else if (command === "promote") {
    result = await promoteRelease({
      deploymentRoot,
      releaseId: values.get("--release-id"),
      confirm: flags.has("--confirm"),
      dryRun: flags.has("--dry-run")
    });
  } else {
    result = await checkRollbackCompatibility({
      deploymentRoot,
      fromReleaseId: values.get("--from"),
      toReleaseId: values.get("--to")
    });
    if (result.outcome === "blocked") process.exitCode = 2;
  }
  const summary = Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== "manifest" && key !== "reasons")
  );
  console.info(stableJson(summary).trim());
  if (result.reasons?.length) console.info(`Compatibility blockers: ${result.reasons.join(",")}.`);
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    const code = error instanceof ReleaseDeploymentError ? error.code : "unexpected-failure";
    console.error(`Release deployment operation failed: ${code}.`);
    process.exitCode = 1;
  });
}
