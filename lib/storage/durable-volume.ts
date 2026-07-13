import "server-only";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  statfs,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import {
  isMediaArtifactId,
  parseMediaStorageKey,
  validateMediaExtension,
  validateMediaWorkspaceInput,
  type MediaAttemptInventoryEntry,
  type MediaAttemptWorkspace,
  type MediaInventoryObject,
  type MediaObjectDescriptor,
  type MediaObjectStorage,
  type MediaStorageHealth,
  type MediaStorageInventory,
  type MediaStorageKey,
  type OpenedMediaObject,
  type PublishedMediaObject
} from "@/lib/storage/media-storage";
import { assertSafePath } from "@/lib/storage/path-safety";

const DIRECTORY_MODE = 0o750;
const FILE_MODE = 0o640;
const CHECKSUM_BUFFER_BYTES = 64 * 1024;
const MAX_SUPPORTED_BYTES = 20 * 1024 * 1024 * 1024;

export class DurableMediaStorageError extends Error {
  constructor(message = "Durable media storage operation failed.") {
    super(message);
    this.name = "DurableMediaStorageError";
  }
}

export type CreateDurableVolumeStorageOptions = Readonly<{
  root: string;
  maxJobBytes: number;
  maxOutputBytes: number;
  lowDiskBytes: number;
}>;

export type DurableVolumeStorage = Readonly<{
  storage: MediaObjectStorage;
  inventory: MediaStorageInventory;
  health: MediaStorageHealth;
}>;

function boundedBytes(name: string, value: number, maximum = MAX_SUPPORTED_BYTES): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} is outside its supported range.`);
  }
  return value;
}

function storageFailure(): DurableMediaStorageError {
  return new DurableMediaStorageError();
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function createDurableVolumeStorage(
  options: CreateDurableVolumeStorageOptions
): DurableVolumeStorage {
  if (typeof options?.root !== "string" || !path.isAbsolute(options.root) || /[\u0000-\u001f\u007f]/.test(options.root)) {
    throw new TypeError("Durable media storage root must be an absolute path.");
  }
  const configuredRoot = path.normalize(options.root);
  const maxJobBytes = boundedBytes("Durable media job byte limit", options.maxJobBytes);
  const maxOutputBytes = boundedBytes("Durable media output byte limit", options.maxOutputBytes, maxJobBytes);
  const lowDiskBytes = boundedBytes("Durable media low-disk threshold", options.lowDiskBytes, 1024 ** 4);
  let canonicalRoot: string | null = null;

  function requireRoot(): string {
    if (!canonicalRoot) throw new DurableMediaStorageError("Durable media storage is not initialized.");
    return canonicalRoot;
  }

  function absoluteForKey(keyValue: MediaStorageKey): string {
    const root = requireRoot();
    const key = parseMediaStorageKey(keyValue);
    return assertSafePath(root, path.join(root, ...key.split("/")));
  }

  async function ensureDirectory(segments: readonly string[]): Promise<string> {
    const root = requireRoot();
    let current = root;
    for (const segment of segments) {
      if (!/^[a-zA-Z0-9._-]+$/.test(segment) || segment === "." || segment === "..") throw storageFailure();
      current = assertSafePath(root, path.join(current, segment));
      try {
        await mkdir(current, { mode: DIRECTORY_MODE });
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
          throw storageFailure();
        }
      }
      const info = await lstat(current).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) throw storageFailure();
      const canonical = await realpath(current).catch(() => null);
      if (!canonical || assertSafePath(root, canonical) !== canonical) throw storageFailure();
    }
    return current;
  }

  async function initialize(): Promise<void> {
    if (canonicalRoot) return;
    try {
      const direct = await lstat(configuredRoot);
      if (!direct.isDirectory() || direct.isSymbolicLink() || (direct.mode & 0o002) !== 0) throw storageFailure();
      if (typeof process.getuid === "function" && direct.uid !== process.getuid()) throw storageFailure();
      await access(configuredRoot, constants.R_OK | constants.W_OK | constants.X_OK);
      const resolved = await realpath(configuredRoot);
      if (!path.isAbsolute(resolved)) throw storageFailure();
      canonicalRoot = resolved;
      await ensureDirectory(["jobs"]);
      await ensureDirectory(["published"]);
    } catch (error) {
      canonicalRoot = null;
      if (error instanceof DurableMediaStorageError) throw error;
      throw storageFailure();
    }
  }

  async function checkHealth(): Promise<void> {
    try {
      const root = requireRoot();
      const direct = await lstat(root);
      if (!direct.isDirectory() || direct.isSymbolicLink()) throw storageFailure();
      const resolved = await realpath(root);
      if (resolved !== root) throw storageFailure();
      await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
      const info = await statfs(root, { bigint: true });
      const available = info.bavail * info.bsize;
      if (available < BigInt(lowDiskBytes)) throw storageFailure();
    } catch (error) {
      if (error instanceof DurableMediaStorageError) throw error;
      throw storageFailure();
    }
  }

  async function assertDiskCapacity(): Promise<void> {
    await checkHealth();
  }

  async function createAttemptWorkspace(inputValue: Parameters<MediaObjectStorage["createAttemptWorkspace"]>[0]): Promise<MediaAttemptWorkspace> {
    const input = validateMediaWorkspaceInput(inputValue);
    await assertDiskCapacity();
    const base = ["jobs", input.jobId, "attempts", input.attemptId] as const;
    await ensureDirectory([...base, "source"]);
    await ensureDirectory([...base, "partial"]);
    await ensureDirectory([...base, "staged"]);
    const sourceKey = parseMediaStorageKey(`${base.join("/")}/source/source.${input.sourceExtension}`);
    const partialKey = parseMediaStorageKey(`${base.join("/")}/partial/output.${input.outputExtension}`);
    const stagedKey = parseMediaStorageKey(`${base.join("/")}/staged/final.${input.outputExtension}`);
    return Object.freeze({
      jobId: input.jobId,
      attemptId: input.attemptId,
      source: Object.freeze({ key: sourceKey, localPath: absoluteForKey(sourceKey) }),
      partial: Object.freeze({ key: partialKey, localPath: absoluteForKey(partialKey) }),
      stagedFinal: Object.freeze({ key: stagedKey, localPath: absoluteForKey(stagedKey) })
    });
  }

  async function jobDirectoryBytes(key: MediaStorageKey): Promise<number> {
    const parts = key.split("/");
    if (parts[0] !== "jobs") return 0;
    const root = requireRoot();
    const jobRoot = assertSafePath(root, path.join(root, "jobs", parts[1]));
    let total = 0;
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const candidate = assertSafePath(jobRoot, path.join(directory, entry.name));
        const info = await lstat(candidate);
        if (info.isSymbolicLink()) throw storageFailure();
        if (info.isDirectory()) await visit(candidate);
        else if (info.isFile()) {
          total += info.size;
          if (total > maxJobBytes) throw storageFailure();
        } else throw storageFailure();
      }
    };
    await visit(jobRoot);
    return total;
  }

  async function inspect(keyValue: MediaStorageKey, maximumBytes: number): Promise<MediaObjectDescriptor> {
    const key = parseMediaStorageKey(keyValue);
    const configuredMaximum = key.includes("/partial/") || key.includes("/staged/") || key.startsWith("published/")
      ? Math.min(maxOutputBytes, maximumBytes)
      : Math.min(maxJobBytes, maximumBytes);
    boundedBytes("Media object byte limit", configuredMaximum, maxJobBytes);
    const candidate = absoluteForKey(key);
    let handle: FileHandle | undefined;
    try {
      const direct = await lstat(candidate);
      if (!direct.isFile() || direct.isSymbolicLink() || direct.size <= 0 || direct.size > configuredMaximum) throw storageFailure();
      const canonical = await realpath(candidate);
      if (assertSafePath(requireRoot(), canonical) !== canonical) throw storageFailure();
      handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== direct.size || opened.dev !== direct.dev || opened.ino !== direct.ino) throw storageFailure();
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(CHECKSUM_BUFFER_BYTES);
      let position = 0;
      while (position < opened.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
        if (bytesRead <= 0) throw storageFailure();
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      await handle.sync();
      if (key.startsWith("jobs/")) await jobDirectoryBytes(key);
      return Object.freeze({
        key,
        sizeBytes: opened.size,
        checksumSha256: hash.digest("hex"),
        modifiedAt: opened.mtime.toISOString()
      });
    } catch (error) {
      if (error instanceof DurableMediaStorageError) throw error;
      throw storageFailure();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async function stageOriginal(
    input: Parameters<MediaObjectStorage["stageOriginal"]>[0]
  ): Promise<MediaObjectDescriptor> {
    const sourceKey = parseMediaStorageKey(input.sourceKey);
    const stagedKey = parseMediaStorageKey(input.stagedKey);
    const sourceParts = sourceKey.split("/");
    const stagedParts = stagedKey.split("/");
    if (
      sourceParts.length !== 6 ||
      stagedParts.length !== 6 ||
      sourceParts[0] !== "jobs" ||
      sourceParts[4] !== "source" ||
      stagedParts[4] !== "staged" ||
      sourceParts[1] !== stagedParts[1] ||
      sourceParts[3] !== stagedParts[3]
    ) {
      throw new TypeError("Original media staging keys are invalid.");
    }
    const source = await inspect(sourceKey, input.maximumBytes);
    const destination = absoluteForKey(stagedKey);
    const destinationDirectory = path.dirname(destination);
    try {
      await link(absoluteForKey(sourceKey), destination);
      await chmod(destination, FILE_MODE);
      const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(destinationDirectory);
    } catch (error) {
      const exists = typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
      if (!exists) throw storageFailure();
    }
    const staged = await inspect(stagedKey, input.maximumBytes);
    if (staged.sizeBytes !== source.sizeBytes || staged.checksumSha256 !== source.checksumSha256) {
      throw storageFailure();
    }
    return staged;
  }

  async function publishImmutable(input: Parameters<MediaObjectStorage["publishImmutable"]>[0]): Promise<PublishedMediaObject> {
    if (!isMediaArtifactId(input.fileId, "final")) throw new TypeError("Published media file ID is invalid.");
    const extension = validateMediaExtension(input.extension);
    const staged = await inspect(input.stagedKey, input.maximumBytes);
    const suffix = input.fileId.slice("file_".length);
    const key = parseMediaStorageKey(`published/${suffix.slice(0, 2)}/${suffix.slice(2, 4)}/${input.fileId}.${extension}`);
    const destination = absoluteForKey(key);
    const destinationDirectory = await ensureDirectory(["published", suffix.slice(0, 2), suffix.slice(2, 4)]);
    try {
      await link(absoluteForKey(staged.key), destination);
      await chmod(destination, FILE_MODE);
      const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(destinationDirectory);
    } catch (error) {
      const exists = typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
      if (!exists) throw storageFailure();
      const existing = await inspect(key, input.maximumBytes);
      if (existing.sizeBytes !== staged.sizeBytes || existing.checksumSha256 !== staged.checksumSha256) {
        throw storageFailure();
      }
    }
    const published = await inspect(key, input.maximumBytes);
    if (published.sizeBytes !== staged.sizeBytes || published.checksumSha256 !== staged.checksumSha256) throw storageFailure();
    return Object.freeze({ ...published, fileId: input.fileId });
  }

  async function openObject(keyValue: MediaStorageKey, expectedSizeBytes: number): Promise<OpenedMediaObject> {
    const key = parseMediaStorageKey(keyValue);
    boundedBytes("Expected media object size", expectedSizeBytes);
    const candidate = absoluteForKey(key);
    let handle: FileHandle | undefined;
    try {
      const direct = await lstat(candidate);
      if (!direct.isFile() || direct.isSymbolicLink() || direct.size !== expectedSizeBytes) throw storageFailure();
      handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== expectedSizeBytes || opened.dev !== direct.dev || opened.ino !== direct.ino) throw storageFailure();
      const stream = createReadStream(candidate, { fd: handle.fd, autoClose: false });
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        stream.destroy();
        await handle?.close().catch(() => undefined);
        handle = undefined;
      };
      stream.once("close", () => { void close(); });
      stream.once("end", () => { void close(); });
      stream.once("error", () => { void close(); });
      return Object.freeze({ sizeBytes: opened.size, stream, close });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof DurableMediaStorageError) throw error;
      throw storageFailure();
    }
  }

  async function statObject(keyValue: MediaStorageKey): Promise<MediaInventoryObject | null> {
    const key = parseMediaStorageKey(keyValue);
    try {
      const candidate = absoluteForKey(key);
      const direct = await lstat(candidate);
      if (!direct.isFile() || direct.isSymbolicLink()) throw storageFailure();
      const canonical = await realpath(candidate);
      if (assertSafePath(requireRoot(), canonical) !== canonical) throw storageFailure();
      return Object.freeze({ key, sizeBytes: direct.size, modifiedAt: direct.mtime.toISOString() });
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof DurableMediaStorageError) throw error;
      throw storageFailure();
    }
  }

  async function removeObject(keyValue: MediaStorageKey): Promise<boolean> {
    const key = parseMediaStorageKey(keyValue);
    const candidate = absoluteForKey(key);
    try {
      const direct = await lstat(candidate);
      if (!direct.isFile() || direct.isSymbolicLink()) throw storageFailure();
      await rm(candidate);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      if (error instanceof DurableMediaStorageError) throw error;
      throw storageFailure();
    }
  }

  async function assertTreeSafe(root: string, directory: string): Promise<void> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw storageFailure();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = assertSafePath(root, path.join(directory, entry.name));
      const child = await lstat(candidate);
      if (child.isSymbolicLink()) throw storageFailure();
      if (child.isDirectory()) await assertTreeSafe(root, candidate);
      else if (!child.isFile()) throw storageFailure();
    }
  }

  async function removeAttemptWorkspace(jobId: string, attemptId: string): Promise<boolean> {
    validateMediaWorkspaceInput({ jobId, attemptId, sourceExtension: "bin", outputExtension: "bin" });
    const root = requireRoot();
    const candidate = assertSafePath(root, path.join(root, "jobs", jobId, "attempts", attemptId));
    try {
      await assertTreeSafe(root, candidate);
      await rm(candidate, { recursive: true });
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      if (error instanceof DurableMediaStorageError) throw error;
      throw storageFailure();
    }
  }

  function boundedLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError("Media inventory limit is invalid.");
    return limit;
  }

  async function directories(directory: string): Promise<readonly string[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (isMissing(error)) return [];
      throw error;
    });
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name).sort();
  }

  async function listPublished(limitValue: number): Promise<readonly MediaInventoryObject[]> {
    const limit = boundedLimit(limitValue);
    const root = requireRoot();
    const publishedRoot = assertSafePath(root, path.join(root, "published"));
    const found: MediaInventoryObject[] = [];
    for (const first of await directories(publishedRoot)) {
      if (!/^[a-f0-9]{2}$/.test(first)) continue;
      for (const second of await directories(path.join(publishedRoot, first))) {
        if (!/^[a-f0-9]{2}$/.test(second)) continue;
        const directory = path.join(publishedRoot, first, second);
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (found.length >= limit) return Object.freeze(found);
          if (!entry.isFile() || entry.isSymbolicLink()) continue;
          try {
            const key = parseMediaStorageKey(`published/${first}/${second}/${entry.name}`);
            const value = await statObject(key);
            if (value) found.push(value);
          } catch {
            // Invalid/untrusted entries are not surfaced as valid inventory objects.
          }
        }
      }
    }
    return Object.freeze(found);
  }

  async function listAttempts(limitValue: number): Promise<readonly MediaAttemptInventoryEntry[]> {
    const limit = boundedLimit(limitValue);
    const root = requireRoot();
    const jobsRoot = assertSafePath(root, path.join(root, "jobs"));
    const found: MediaAttemptInventoryEntry[] = [];
    for (const jobId of await directories(jobsRoot)) {
      const attemptsRoot = path.join(jobsRoot, jobId, "attempts");
      for (const attemptId of await directories(attemptsRoot)) {
        if (found.length >= limit) return Object.freeze(found);
        try {
          validateMediaWorkspaceInput({ jobId, attemptId, sourceExtension: "bin", outputExtension: "bin" });
          const info = await lstat(path.join(attemptsRoot, attemptId));
          found.push(Object.freeze({ jobId, attemptId, modifiedAt: info.mtime.toISOString() }));
        } catch {
          // Invalid directory names are never converted into storage identities.
        }
      }
    }
    return Object.freeze(found);
  }

  const storage: MediaObjectStorage = Object.freeze({
    initialize,
    createAttemptWorkspace,
    inspect,
    stageOriginal,
    publishImmutable,
    open: openObject,
    stat: statObject,
    remove: removeObject,
    removeAttemptWorkspace
  });
  const inventory: MediaStorageInventory = Object.freeze({ listPublished, listAttempts });
  const health: MediaStorageHealth = Object.freeze({ check: checkHealth });
  return Object.freeze({ storage, inventory, health });
}
