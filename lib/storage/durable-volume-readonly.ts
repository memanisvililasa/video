import "server-only";
import { constants, createReadStream } from "node:fs";
import {
  access,
  lstat,
  open,
  realpath,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import { assertDurableVolumeMarker } from "@/lib/storage/durable-volume-marker";
import {
  parseMediaStorageKey,
  type MediaStorageKey,
  type OpenedMediaObject
} from "@/lib/storage/media-storage";
import { assertSafePath } from "@/lib/storage/path-safety";

const MAX_SUPPORTED_BYTES = 20 * 1024 * 1024 * 1024;

export class ReadonlyDurableMediaStorageError extends Error {
  constructor(message = "Durable media storage operation failed.") {
    super(message);
    this.name = "ReadonlyDurableMediaStorageError";
  }
}

export type ReadonlyMediaObjectStorage = Readonly<{
  initialize(): Promise<void>;
  readiness(): Promise<void>;
  open(key: MediaStorageKey, expectedSizeBytes: number): Promise<OpenedMediaObject>;
}>;

function storageFailure(): ReadonlyDurableMediaStorageError {
  return new ReadonlyDurableMediaStorageError();
}

function validateExpectedSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SUPPORTED_BYTES) {
    throw new TypeError("Expected media object size is invalid.");
  }
  return value;
}

/** A web-only adapter: it never creates, chmods, publishes, removes, or cleans. */
export function createReadonlyDurableVolumeStorage(
  rootValue: string,
  authorityId: string
): ReadonlyMediaObjectStorage {
  if (
    typeof rootValue !== "string" ||
    !path.isAbsolute(rootValue) ||
    rootValue.length > 1_024 ||
    /[\u0000-\u001f\u007f]/.test(rootValue)
  ) {
    throw new TypeError("Durable media storage root must be an absolute path.");
  }
  const configuredRoot = path.normalize(rootValue);
  if (!/^[a-f0-9]{32}$/.test(authorityId)) {
    throw new TypeError("Durable media volume authority is invalid.");
  }
  let canonicalRoot: string | null = null;

  function requireRoot(): string {
    if (!canonicalRoot) throw new ReadonlyDurableMediaStorageError("Durable media storage is not initialized.");
    return canonicalRoot;
  }

  async function assertDirectory(candidate: string, root?: string): Promise<string> {
    const info = await lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o002) !== 0) throw storageFailure();
    await access(candidate, constants.R_OK | constants.X_OK);
    const resolved = await realpath(candidate);
    if (root && assertSafePath(root, resolved) !== resolved) {
      throw storageFailure();
    }
    return resolved;
  }

  async function validateRoot(): Promise<string> {
    try {
      const resolved = await assertDirectory(configuredRoot);
      await assertDurableVolumeMarker(resolved, authorityId);
      await assertDirectory(
        assertSafePath(resolved, path.join(/* turbopackIgnore: true */ resolved, "published")),
        resolved
      );
      return resolved;
    } catch (error) {
      if (error instanceof ReadonlyDurableMediaStorageError) throw error;
      throw storageFailure();
    }
  }

  async function initialize(): Promise<void> {
    if (canonicalRoot) return;
    try {
      canonicalRoot = await validateRoot();
    } catch (error) {
      canonicalRoot = null;
      throw error;
    }
  }

  async function readiness(): Promise<void> {
    const resolved = await validateRoot();
    if (canonicalRoot && canonicalRoot !== resolved) throw storageFailure();
    canonicalRoot = resolved;
  }

  async function openPublished(
    keyValue: MediaStorageKey,
    expectedSizeValue: number
  ): Promise<OpenedMediaObject> {
    const key = parseMediaStorageKey(keyValue);
    if (!key.startsWith("published/")) throw new TypeError("Only published media can be opened.");
    const expectedSizeBytes = validateExpectedSize(expectedSizeValue);
    const root = requireRoot();
    const segments = key.split("/");
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = assertSafePath(root, path.join(/* turbopackIgnore: true */ current, segment));
      await assertDirectory(current, root).catch(() => { throw storageFailure(); });
    }
    const candidate = assertSafePath(root, path.join(/* turbopackIgnore: true */ root, ...segments));
    let handle: FileHandle | undefined;
    try {
      const direct = await lstat(candidate);
      if (!direct.isFile() || direct.isSymbolicLink() || direct.size !== expectedSizeBytes) {
        throw storageFailure();
      }
      const resolved = await realpath(candidate);
      if (assertSafePath(root, resolved) !== resolved) throw storageFailure();
      handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.size !== expectedSizeBytes ||
        opened.dev !== direct.dev ||
        opened.ino !== direct.ino
      ) {
        throw storageFailure();
      }
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
      if (error instanceof TypeError || error instanceof ReadonlyDurableMediaStorageError) throw error;
      throw storageFailure();
    }
  }

  return Object.freeze({ initialize, readiness, open: openPublished });
}
