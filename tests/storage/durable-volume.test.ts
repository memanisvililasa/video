import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableVolumeStorage, DurableMediaStorageError } from "@/lib/storage/durable-volume";
import {
  createMediaArtifactId,
  isPublicMediaFileId,
  parseMediaStorageKey
} from "@/lib/storage/media-storage";

const attemptA = `attempt_${"a".repeat(32)}`;
const attemptB = `attempt_${"b".repeat(32)}`;
const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "videosave-durable-storage-"));
  roots.push(root);
  return root;
}

function adapter(root: string) {
  return createDurableVolumeStorage({
    root,
    maxJobBytes: 10 * 1024 * 1024,
    maxOutputBytes: 5 * 1024 * 1024,
    lowDiskBytes: 1024 * 1024
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable volume storage contract", () => {
  it("creates attempt-isolated source, partial and staged targets and validates files", async () => {
    const runtime = adapter(await createRoot());
    await runtime.storage.initialize();
    const workspace = await runtime.storage.createAttemptWorkspace({
      jobId: "job_storage_contract",
      attemptId: attemptA,
      sourceExtension: "mp4",
      outputExtension: "m4a"
    });
    await writeFile(workspace.source.localPath, "source");
    await writeFile(workspace.partial.localPath, "partial");
    await writeFile(workspace.stagedFinal.localPath, "final");
    await expect(runtime.storage.inspect(workspace.source.key, 1024)).resolves.toMatchObject({ sizeBytes: 6 });
    await expect(runtime.storage.inspect(workspace.partial.key, 1024)).resolves.toMatchObject({ sizeBytes: 7 });
    await expect(runtime.storage.inspect(workspace.stagedFinal.key, 1024)).resolves.toMatchObject({
      sizeBytes: 5,
      checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("publishes immutable no-overwrite files visible to another adapter and after restart", async () => {
    const root = await createRoot();
    const first = adapter(root);
    await first.storage.initialize();
    const workspace = await first.storage.createAttemptWorkspace({
      jobId: "job_shared_volume",
      attemptId: attemptA,
      sourceExtension: "mp4",
      outputExtension: "mp4"
    });
    await writeFile(workspace.stagedFinal.localPath, "durable-final");
    const fileId = createMediaArtifactId("final");
    const published = await first.storage.publishImmutable({
      stagedKey: workspace.stagedFinal.key,
      fileId,
      extension: "mp4",
      maximumBytes: 1024
    });
    await expect(first.storage.publishImmutable({
      stagedKey: workspace.stagedFinal.key,
      fileId,
      extension: "mp4",
      maximumBytes: 1024
    })).resolves.toEqual(published);

    const second = adapter(root);
    await second.storage.initialize();
    const opened = await second.storage.open(published.key, published.sizeBytes);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    await opened.close();
    expect(Buffer.concat(chunks).toString()).toBe("durable-final");
    expect(await second.inventory.listPublished(10)).toEqual([
      expect.objectContaining({ key: published.key, sizeBytes: published.sizeBytes })
    ]);
  });

  it("stages original bytes only within the same server-owned attempt", async () => {
    const runtime = adapter(await createRoot());
    await runtime.storage.initialize();
    const first = await runtime.storage.createAttemptWorkspace({
      jobId: "job_original_stage",
      attemptId: attemptA,
      sourceExtension: "mp4",
      outputExtension: "mp4"
    });
    const second = await runtime.storage.createAttemptWorkspace({
      jobId: "job_original_stage",
      attemptId: attemptB,
      sourceExtension: "mp4",
      outputExtension: "mp4"
    });
    await writeFile(first.source.localPath, "original");
    await expect(runtime.storage.stageOriginal({
      sourceKey: first.source.key,
      stagedKey: first.stagedFinal.key,
      maximumBytes: 1024
    })).resolves.toMatchObject({ sizeBytes: 8 });
    await expect(runtime.storage.stageOriginal({
      sourceKey: first.source.key,
      stagedKey: second.stagedFinal.key,
      maximumBytes: 1024
    })).rejects.toThrow(TypeError);
  });

  it("rejects a different duplicate publication instead of overwriting final bytes", async () => {
    const runtime = adapter(await createRoot());
    await runtime.storage.initialize();
    const first = await runtime.storage.createAttemptWorkspace({
      jobId: "job_no_overwrite",
      attemptId: attemptA,
      sourceExtension: "mp4",
      outputExtension: "mp4"
    });
    const second = await runtime.storage.createAttemptWorkspace({
      jobId: "job_no_overwrite",
      attemptId: attemptB,
      sourceExtension: "mp4",
      outputExtension: "mp4"
    });
    await writeFile(first.stagedFinal.localPath, "first");
    await writeFile(second.stagedFinal.localPath, "second");
    const fileId = createMediaArtifactId("final");
    await runtime.storage.publishImmutable({ stagedKey: first.stagedFinal.key, fileId, extension: "mp4", maximumBytes: 1024 });
    await expect(runtime.storage.publishImmutable({
      stagedKey: second.stagedFinal.key,
      fileId,
      extension: "mp4",
      maximumBytes: 1024
    })).rejects.toBeInstanceOf(DurableMediaStorageError);
  });

  it("rejects traversal, absolute keys and unsafe identifiers before filesystem access", () => {
    for (const value of ["/etc/passwd", "jobs/../secret", "published/aa/bb/../../secret", "file_deadbeef"]) {
      expect(() => parseMediaStorageKey(value)).toThrow(TypeError);
    }
    expect(isPublicMediaFileId(createMediaArtifactId("final"))).toBe(true);
    expect(isPublicMediaFileId(createMediaArtifactId("source"))).toBe(false);
    const ids = new Set(Array.from({ length: 32 }, () => createMediaArtifactId("final")));
    expect(ids.size).toBe(32);
  });

  it("rejects symlink roots and symlink/non-regular/empty artifact files", async () => {
    const realRoot = await createRoot();
    const linkedRoot = `${realRoot}-link`;
    roots.push(linkedRoot);
    await symlink(realRoot, linkedRoot);
    await expect(adapter(linkedRoot).storage.initialize()).rejects.toBeInstanceOf(DurableMediaStorageError);

    const runtime = adapter(realRoot);
    await runtime.storage.initialize();
    const workspace = await runtime.storage.createAttemptWorkspace({
      jobId: "job_bad_files",
      attemptId: attemptA,
      sourceExtension: "mp4",
      outputExtension: "mp4"
    });
    await writeFile(workspace.source.localPath, "source");
    await symlink(workspace.source.localPath, workspace.stagedFinal.localPath);
    await expect(runtime.storage.inspect(workspace.stagedFinal.key, 1024)).rejects.toBeInstanceOf(DurableMediaStorageError);
    await rm(workspace.stagedFinal.localPath);
    await mkdir(workspace.stagedFinal.localPath);
    await expect(runtime.storage.inspect(workspace.stagedFinal.key, 1024)).rejects.toBeInstanceOf(DurableMediaStorageError);
    await rm(workspace.stagedFinal.localPath, { recursive: true });
    await writeFile(workspace.stagedFinal.localPath, "");
    await expect(runtime.storage.inspect(workspace.stagedFinal.key, 1024)).rejects.toBeInstanceOf(DurableMediaStorageError);
  });

  it("rejects a symlinked job directory before creating an attempt", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const runtime = adapter(root);
    await runtime.storage.initialize();
    await symlink(outside, path.join(root, "jobs", "job_symlink_escape"));
    await expect(runtime.storage.createAttemptWorkspace({
      jobId: "job_symlink_escape",
      attemptId: attemptA,
      sourceExtension: "mp4",
      outputExtension: "mp4"
    })).rejects.toBeInstanceOf(DurableMediaStorageError);
  });

  it("enforces object and per-job byte limits", async () => {
    const runtime = adapter(await createRoot());
    await runtime.storage.initialize();
    const workspace = await runtime.storage.createAttemptWorkspace({
      jobId: "job_size_limit",
      attemptId: attemptA,
      sourceExtension: "mp4",
      outputExtension: "mp4"
    });
    await writeFile(workspace.stagedFinal.localPath, "12345");
    await expect(runtime.storage.inspect(workspace.stagedFinal.key, 4)).rejects.toBeInstanceOf(DurableMediaStorageError);
  });

  it("fails the explicit health probe when the mounted root disappears", async () => {
    const root = await createRoot();
    const runtime = adapter(root);
    await runtime.storage.initialize();
    await expect(runtime.health.check()).resolves.toBeUndefined();
    await rm(root, { recursive: true });
    await expect(runtime.health.check()).rejects.toBeInstanceOf(DurableMediaStorageError);
  });

  it("removes only the named attempt workspace idempotently", async () => {
    const runtime = adapter(await createRoot());
    await runtime.storage.initialize();
    const workspace = await runtime.storage.createAttemptWorkspace({
      jobId: "job_cleanup_attempt",
      attemptId: attemptA,
      sourceExtension: "mp4",
      outputExtension: "mp4"
    });
    await writeFile(workspace.source.localPath, "source");
    await expect(runtime.storage.removeAttemptWorkspace(workspace.jobId, workspace.attemptId)).resolves.toBe(true);
    await expect(runtime.storage.removeAttemptWorkspace(workspace.jobId, workspace.attemptId)).resolves.toBe(false);
    await expect(readFile(workspace.source.localPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
