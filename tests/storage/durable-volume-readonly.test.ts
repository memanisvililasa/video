import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReadonlyDurableVolumeStorage,
  ReadonlyDurableMediaStorageError
} from "@/lib/storage/durable-volume-readonly";
import {
  DURABLE_VOLUME_MARKER_FILENAME,
  durableVolumeMarkerContent
} from "@/lib/storage/durable-volume-marker";
import { parseMediaStorageKey } from "@/lib/storage/media-storage";
import {
  provisionDurableVolumeTestRoot,
  TEST_DURABLE_VOLUME_AUTHORITY_ID
} from "@/tests/helpers/durable-volume";

const roots: string[] = [];
const fileId = `file_${"a".repeat(32)}`;
const key = parseMediaStorageKey(`published/aa/aa/${fileId}.mp4`);
const markerContent = durableVolumeMarkerContent(TEST_DURABLE_VOLUME_AUTHORITY_ID);

async function createRoot(provision = true): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "videosave-web-volume-"));
  roots.push(root);
  if (provision) await provisionDurableVolumeTestRoot(root, { createPublished: true });
  return root;
}

async function writePublished(root: string, bytes = "published-final"): Promise<string> {
  const directory = path.join(root, "published", "aa", "aa");
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const target = path.join(directory, `${fileId}.mp4`);
  await writeFile(target, bytes, { mode: 0o640 });
  return target;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("read-only durable volume adapter", () => {
  it("validates the marker and streams only an exact published regular file", async () => {
    const root = await createRoot();
    await writePublished(root);
    const before = await readdir(root);
    const storage = createReadonlyDurableVolumeStorage(root, TEST_DURABLE_VOLUME_AUTHORITY_ID);
    await storage.initialize();
    await storage.readiness();
    const opened = await storage.open(key, Buffer.byteLength("published-final"));
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    await opened.close();
    expect(Buffer.concat(chunks).toString()).toBe("published-final");
    expect(await readdir(root)).toEqual(before);
  });

  it("fails closed for missing, malformed, writable, or symlinked markers", async () => {
    const missing = await createRoot(false);
    await mkdir(path.join(missing, "published"));
    await expect(createReadonlyDurableVolumeStorage(missing, TEST_DURABLE_VOLUME_AUTHORITY_ID).initialize())
      .rejects.toBeInstanceOf(ReadonlyDurableMediaStorageError);

    const malformed = await createRoot(false);
    await mkdir(path.join(malformed, "published"));
    await writeFile(path.join(malformed, DURABLE_VOLUME_MARKER_FILENAME), "wrong\n", { mode: 0o600 });
    await expect(createReadonlyDurableVolumeStorage(malformed, TEST_DURABLE_VOLUME_AUTHORITY_ID).initialize())
      .rejects.toBeInstanceOf(ReadonlyDurableMediaStorageError);

    const writable = await createRoot(false);
    await mkdir(path.join(writable, "published"));
    const writableMarker = path.join(writable, DURABLE_VOLUME_MARKER_FILENAME);
    await writeFile(writableMarker, markerContent, { mode: 0o600 });
    await chmod(writableMarker, 0o622);
    await expect(createReadonlyDurableVolumeStorage(writable, TEST_DURABLE_VOLUME_AUTHORITY_ID).initialize())
      .rejects.toBeInstanceOf(ReadonlyDurableMediaStorageError);

    const linked = await createRoot(false);
    await mkdir(path.join(linked, "published"));
    const outside = path.join(linked, "marker-source");
    await writeFile(outside, markerContent, { mode: 0o600 });
    await symlink(outside, path.join(linked, DURABLE_VOLUME_MARKER_FILENAME));
    await expect(createReadonlyDurableVolumeStorage(linked, TEST_DURABLE_VOLUME_AUTHORITY_ID).initialize())
      .rejects.toBeInstanceOf(ReadonlyDurableMediaStorageError);
  });

  it("rejects private keys, size mismatches, symlinks, and non-regular files", async () => {
    const root = await createRoot();
    const target = await writePublished(root);
    const storage = createReadonlyDurableVolumeStorage(root, TEST_DURABLE_VOLUME_AUTHORITY_ID);
    await storage.initialize();
    await expect(storage.open(
      parseMediaStorageKey(`jobs/job_safe/attempts/attempt_${"b".repeat(32)}/source/source.mp4`),
      10
    )).rejects.toThrow(TypeError);
    await expect(storage.open(key, 1)).rejects.toBeInstanceOf(ReadonlyDurableMediaStorageError);

    await rm(target);
    await symlink(path.join(root, DURABLE_VOLUME_MARKER_FILENAME), target);
    await expect(storage.open(key, Buffer.byteLength(markerContent)))
      .rejects.toBeInstanceOf(ReadonlyDurableMediaStorageError);
    await rm(target);
    await mkdir(target);
    await expect(storage.open(key, 1)).rejects.toBeInstanceOf(ReadonlyDurableMediaStorageError);
  });

  it("detects root disappearance after initialization without creating fallback paths", async () => {
    const root = await createRoot();
    await writePublished(root);
    const storage = createReadonlyDurableVolumeStorage(root, TEST_DURABLE_VOLUME_AUTHORITY_ID);
    await storage.initialize();
    await rm(root, { recursive: true });
    await expect(storage.readiness()).rejects.toBeInstanceOf(ReadonlyDurableMediaStorageError);
  });

  it("does not alter marker contents", async () => {
    const root = await createRoot();
    const storage = createReadonlyDurableVolumeStorage(root, TEST_DURABLE_VOLUME_AUTHORITY_ID);
    await storage.initialize();
    expect(await readFile(path.join(root, DURABLE_VOLUME_MARKER_FILENAME), "utf8"))
      .toBe(markerContent);
  });
});
