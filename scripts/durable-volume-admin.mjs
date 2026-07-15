import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  statfs
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const VOLUME_MARKER_FILENAME = ".videosave-volume";
export const VOLUME_MARKER_VERSION = "v2";
export const VOLUME_AUTHORITY_PATTERN = /^[a-f0-9]{32}$/;
const DEFAULT_MINIMUM_FREE_BYTES = 1024 ** 3;

export class DurableVolumeAdminError extends Error {
  constructor(code) {
    super(code);
    this.name = "DurableVolumeAdminError";
    this.code = code;
  }
}

function fail(code) {
  throw new DurableVolumeAdminError(code);
}

export function markerContent(authorityId) {
  if (!VOLUME_AUTHORITY_PATTERN.test(authorityId ?? "")) fail("invalid-authority");
  return `videosave-media-volume:${VOLUME_MARKER_VERSION}\nauthority:${authorityId}\n`;
}

function safeRootInput(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    !path.isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    path.normalize(value) !== value ||
    value === path.parse(value).root
  ) fail("invalid-root");
  return value;
}

export async function canonicalVolumeRoot(value) {
  const requested = safeRootInput(value);
  try {
    const direct = await lstat(requested);
    if (!direct.isDirectory() || direct.isSymbolicLink()) fail("invalid-root");
    const canonical = await realpath(requested);
    if (canonical !== requested) fail("non-canonical-root");
    return Object.freeze({ root: canonical, info: direct });
  } catch (error) {
    if (error instanceof DurableVolumeAdminError) throw error;
    fail("root-unavailable");
  }
}

async function readMarker(root, authorityId) {
  const target = path.join(root, VOLUME_MARKER_FILENAME);
  let handle;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) {
      fail("marker-invalid");
    }
    const expected = markerContent(authorityId);
    if (info.size !== Buffer.byteLength(expected)) fail("marker-incompatible");
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size !== info.size
    ) fail("marker-invalid");
    const content = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(content, 0, content.length, 0);
    if (bytesRead !== content.length || content.toString("utf8") !== expected) {
      fail("marker-incompatible");
    }
    return opened;
  } catch (error) {
    if (error instanceof DurableVolumeAdminError) throw error;
    fail("marker-missing");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function initializeVolumeMarker({ root: rootValue, authorityId, dryRun = false }) {
  const { root } = await canonicalVolumeRoot(rootValue);
  const content = markerContent(authorityId);
  const target = path.join(root, VOLUME_MARKER_FILENAME);
  const existing = await lstat(target).catch(() => null);
  if (existing) {
    await readMarker(root, authorityId);
    return Object.freeze({ outcome: "already-compatible", changed: false });
  }
  if (dryRun) return Object.freeze({ outcome: "would-initialize", changed: false });

  const temporary = path.join(root, `.videosave-marker-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o640);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o640);
    try {
      await link(temporary, target);
    } catch (error) {
      if (error?.code !== "EEXIST") fail("marker-create-failed");
      await readMarker(root, authorityId);
      return Object.freeze({ outcome: "already-compatible", changed: false });
    }
    await readMarker(root, authorityId);
    return Object.freeze({ outcome: "initialized", changed: true });
  } catch (error) {
    if (error instanceof DurableVolumeAdminError) throw error;
    fail("marker-create-failed");
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(String(value))) fail("invalid-limit");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail("invalid-limit");
  return parsed;
}

async function permissionCheck(root, role) {
  const published = path.join(root, "published");
  const jobs = path.join(root, "jobs");
  const [publishedInfo, jobsInfo] = await Promise.all([
    lstat(published).catch(() => null),
    lstat(jobs).catch(() => null)
  ]);
  if (!publishedInfo?.isDirectory() || publishedInfo.isSymbolicLink()) fail("published-unavailable");
  if (!jobsInfo?.isDirectory() || jobsInfo.isSymbolicLink()) fail("jobs-unavailable");
  if (role === "web") {
    await access(root, constants.R_OK | constants.X_OK).catch(() => fail("web-read-denied"));
    await access(published, constants.R_OK | constants.X_OK).catch(() => fail("web-read-denied"));
    const writable = await access(root, constants.W_OK).then(() => true, () => false);
    if (writable) fail("web-root-writable");
    const jobsAccessible = await access(jobs, constants.R_OK | constants.X_OK).then(() => true, () => false);
    if (jobsAccessible) fail("web-jobs-accessible");
    return;
  }
  if (role !== "worker") fail("invalid-role");
  await access(root, constants.R_OK | constants.W_OK | constants.X_OK)
    .catch(() => fail("worker-write-denied"));
  await Promise.all([
    access(jobs, constants.R_OK | constants.W_OK | constants.X_OK),
    access(published, constants.R_OK | constants.W_OK | constants.X_OK)
  ]).catch(() => fail("worker-write-denied"));
}

async function capacity(root, minimumFreeBytes) {
  try {
    const info = await statfs(root, { bigint: true });
    const availableBytes = info.bavail * info.bsize;
    const availableInodes = info.ffree;
    if (availableBytes < BigInt(minimumFreeBytes)) fail("insufficient-free-space");
    if (availableInodes === 0n) fail("insufficient-free-inodes");
    return Object.freeze({
      availableBytes: availableBytes.toString(),
      availableInodes: availableInodes.toString()
    });
  } catch (error) {
    if (error instanceof DurableVolumeAdminError) throw error;
    fail("filesystem-info-unavailable");
  }
}

export async function checkDurableVolume({
  root: rootValue,
  authorityId,
  role,
  minimumFreeBytes = DEFAULT_MINIMUM_FREE_BYTES
}) {
  const { root } = await canonicalVolumeRoot(rootValue);
  await readMarker(root, authorityId);
  await permissionCheck(root, role);
  const filesystem = await capacity(root, positiveInteger(minimumFreeBytes, DEFAULT_MINIMUM_FREE_BYTES));
  return Object.freeze({ outcome: "ok", role, filesystem });
}

export async function probeDurableVolume({
  root: rootValue,
  authorityId,
  dryRun = false,
  minimumFreeBytes = DEFAULT_MINIMUM_FREE_BYTES
}) {
  const checked = await checkDurableVolume({
    root: rootValue,
    authorityId,
    role: "worker",
    minimumFreeBytes
  });
  if (dryRun) return Object.freeze({ ...checked, outcome: "would-probe", changed: false });
  const { root } = await canonicalVolumeRoot(rootValue);
  const nonce = randomUUID().replaceAll("-", "");
  const jobs = path.join(root, "jobs");
  const published = path.join(root, "published");
  const workspace = path.join(jobs, `job_probe_${nonce}`);
  const attempt = path.join(workspace, "attempts", `attempt_${nonce}`);
  const sourceDirectory = path.join(attempt, "source");
  const partialDirectory = path.join(attempt, "partial");
  const stagedDirectory = path.join(attempt, "staged");
  const publishedFirst = path.join(published, nonce.slice(0, 2));
  const publishedSecond = path.join(publishedFirst, nonce.slice(2, 4));
  const source = path.join(sourceDirectory, "probe-source.bin");
  const partial = path.join(partialDirectory, "probe-partial.bin");
  const staged = path.join(stagedDirectory, "probe-final.bin");
  const linked = path.join(publishedSecond, `file_${nonce}.bin`);
  const renamed = path.join(publishedSecond, `file_${nonce}.renamed`);
  async function writeProbeFile(target, content) {
    const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close().catch(() => undefined);
    }
  }
  let handle;
  try {
    await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
    await mkdir(partialDirectory, { mode: 0o700 });
    await mkdir(stagedDirectory, { mode: 0o700 });
    await mkdir(publishedSecond, { recursive: true, mode: 0o750 });
    await Promise.all([
      writeProbeFile(source, "source-probe\n"),
      writeProbeFile(partial, "partial-probe\n")
    ]);
    handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile("videosave-volume-probe\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const [sourceInfo, partialInfo, stagedInfo, publishedInfo] = await Promise.all([
      stat(sourceDirectory), stat(partialDirectory), stat(stagedDirectory), stat(publishedSecond)
    ]);
    if (
      sourceInfo.dev !== stagedInfo.dev || partialInfo.dev !== stagedInfo.dev ||
      stagedInfo.dev !== publishedInfo.dev
    ) fail("publication-filesystem-mismatch");
    await link(staged, linked);
    await rename(linked, renamed);
    const [left, right] = await Promise.all([stat(staged), stat(renamed)]);
    if (left.dev !== right.dev || left.ino !== right.ino || left.nlink < 2) fail("hardlink-probe-failed");
    return Object.freeze({ ...checked, outcome: "probed", changed: false });
  } catch (error) {
    if (error instanceof DurableVolumeAdminError) throw error;
    fail("write-probe-failed");
  } finally {
    await handle?.close().catch(() => undefined);
    await Promise.all([
      rm(source, { force: true }),
      rm(partial, { force: true }),
      rm(staged, { force: true }),
      rm(linked, { force: true }),
      rm(renamed, { force: true })
    ]).catch(() => undefined);
    await rmdir(sourceDirectory).catch(() => undefined);
    await rmdir(partialDirectory).catch(() => undefined);
    await rmdir(stagedDirectory).catch(() => undefined);
    await rmdir(attempt).catch(() => undefined);
    await rmdir(path.join(workspace, "attempts")).catch(() => undefined);
    await rmdir(workspace).catch(() => undefined);
    await rmdir(publishedSecond).catch(() => undefined);
    await rmdir(publishedFirst).catch(() => undefined);
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["check", "probe", "initialize-marker"]).has(command)) fail("invalid-command");
  const values = new Map();
  let dryRun = false;
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (current === "--dry-run") {
      if (dryRun) fail("invalid-arguments");
      dryRun = true;
      continue;
    }
    if (!new Set(["--root", "--authority-id", "--role", "--minimum-free-bytes"]).has(current)) {
      fail("invalid-arguments");
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--") || values.has(current)) fail("invalid-arguments");
    values.set(current, value);
    index += 1;
  }
  if (!values.has("--root") || !values.has("--authority-id")) fail("invalid-arguments");
  if (command === "check" && !values.has("--role")) fail("invalid-arguments");
  if (command !== "check" && values.has("--role")) fail("invalid-arguments");
  if (command === "initialize-marker" && values.has("--minimum-free-bytes")) fail("invalid-arguments");
  if (command === "check" && dryRun) fail("invalid-arguments");
  return Object.freeze({
    command,
    root: values.get("--root"),
    authorityId: values.get("--authority-id"),
    role: values.get("--role"),
    minimumFreeBytes: values.get("--minimum-free-bytes"),
    dryRun
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const common = {
    root: options.root,
    authorityId: options.authorityId,
    minimumFreeBytes: options.minimumFreeBytes
  };
  const result = options.command === "initialize-marker"
    ? await initializeVolumeMarker({ ...common, dryRun: options.dryRun })
    : options.command === "probe"
      ? await probeDurableVolume({ ...common, dryRun: options.dryRun })
      : await checkDurableVolume({ ...common, role: options.role });
  console.info(`Durable volume ${result.outcome}.`);
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    const code = error instanceof DurableVolumeAdminError ? error.code : "unexpected-failure";
    console.error(`Durable volume operation failed: ${code}.`);
    process.exitCode = 1;
  });
}
