import "server-only";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { assertSafePath } from "@/lib/storage/path-safety";

export const DURABLE_VOLUME_MARKER_FILENAME = ".videosave-volume";
export const DURABLE_VOLUME_MARKER_VERSION = "v2";
export const DURABLE_VOLUME_MARKER_PREFIX = `videosave-media-volume:${DURABLE_VOLUME_MARKER_VERSION}\n`;
export const DURABLE_VOLUME_AUTHORITY_ID_PATTERN = /^[a-f0-9]{32}$/;

export function durableVolumeMarkerContent(authorityId: string): string {
  if (!DURABLE_VOLUME_AUTHORITY_ID_PATTERN.test(authorityId)) {
    throw new TypeError("Durable media volume authority is invalid.");
  }
  return `${DURABLE_VOLUME_MARKER_PREFIX}authority:${authorityId}\n`;
}

export class DurableVolumeMarkerError extends Error {
  constructor() {
    super("Durable media volume identity is invalid.");
    this.name = "DurableVolumeMarkerError";
  }
}

/** Read-only validation. Provisioning the marker is deliberately out of scope. */
export async function assertDurableVolumeMarker(
  configuredRoot: string,
  expectedAuthorityId: string
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    const expectedContent = durableVolumeMarkerContent(expectedAuthorityId);
    if (!path.isAbsolute(configuredRoot)) throw new DurableVolumeMarkerError();
    const rootInfo = await lstat(configuredRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new DurableVolumeMarkerError();
    const canonicalRoot = await realpath(configuredRoot);
    const markerPath = assertSafePath(
      canonicalRoot,
      path.join(/* turbopackIgnore: true */ canonicalRoot, DURABLE_VOLUME_MARKER_FILENAME)
    );
    const direct = await lstat(markerPath);
    if (
      !direct.isFile() ||
      direct.isSymbolicLink() ||
      direct.size !== Buffer.byteLength(expectedContent) ||
      (direct.mode & 0o022) !== 0
    ) {
      throw new DurableVolumeMarkerError();
    }
    const resolved = await realpath(markerPath);
    if (assertSafePath(canonicalRoot, resolved) !== resolved) {
      throw new DurableVolumeMarkerError();
    }
    handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== direct.dev ||
      opened.ino !== direct.ino ||
      opened.size !== direct.size
    ) {
      throw new DurableVolumeMarkerError();
    }
    const bytes = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length || bytes.toString("utf8") !== expectedContent) {
      throw new DurableVolumeMarkerError();
    }
  } catch (error) {
    if (error instanceof DurableVolumeMarkerError) throw error;
    throw new DurableVolumeMarkerError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
