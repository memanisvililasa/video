import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupExpiredFiles } from "@/lib/storage/cleanup";
import { createFileRegistry } from "@/lib/storage/file-registry";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "videosave-cleanup-"));
  roots.add(root);
  const registry = createFileRegistry();
  const dependencies = {
    listRegisteredFiles: registry.listRegisteredFiles,
    deleteRegisteredFile: registry.deleteRegisteredFile,
    getStorageRoot: () => root,
    tempFileTtlMinutes: 1
  };
  return { root, registry, dependencies };
}

describe("bounded local storage cleanup", () => {
  it("removes expired registered files and stale job directories idempotently", async () => {
    const { root, registry, dependencies } = await fixture();
    const jobDirectory = path.join(root, "jobs", "job_expired");
    const staleDirectory = path.join(root, "jobs", "job_stale");
    const filePath = path.join(jobDirectory, "final.mp4");
    await mkdir(jobDirectory, { recursive: true });
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(filePath, "media");
    const now = Date.now();
    registry.registerFile({
      id: "file_expired_123",
      jobId: "job_expired",
      path: filePath,
      relativePath: "jobs/job_expired/final.mp4",
      filename: "final.mp4",
      sizeBytes: 5,
      contentType: "video/mp4",
      kind: "final",
      createdAt: new Date(now - 120_000).toISOString(),
      expiresAt: new Date(now - 60_000).toISOString()
    });
    await utimes(jobDirectory, new Date(now - 120_000), new Date(now - 120_000));
    await utimes(staleDirectory, new Date(now - 120_000), new Date(now - 120_000));

    await expect(cleanupExpiredFiles({ now }, dependencies)).resolves.toMatchObject({
      removedFiles: 1,
      removedDirectories: 1,
      removedJobs: 1
    });
    expect(registry.getRegisteredFile("file_expired_123")).toBeNull();
    await expect(cleanupExpiredFiles({ now }, dependencies)).resolves.toEqual({
      removedJobs: 0,
      removedFiles: 0,
      removedDirectories: 0
    });
  });

  it("preserves active jobs even when their artifacts and directory are old", async () => {
    const { root, registry, dependencies } = await fixture();
    const jobDirectory = path.join(root, "jobs", "job_active");
    const filePath = path.join(jobDirectory, "source.mp4");
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(filePath, "media");
    const now = Date.now();
    registry.registerFile({
      id: "source_active_123",
      jobId: "job_active",
      path: filePath,
      relativePath: "jobs/job_active/source.mp4",
      filename: "source.mp4",
      sizeBytes: 5,
      contentType: "video/mp4",
      kind: "source",
      createdAt: new Date(now - 120_000).toISOString(),
      expiresAt: new Date(now - 60_000).toISOString()
    });
    await utimes(jobDirectory, new Date(now - 120_000), new Date(now - 120_000));

    await expect(cleanupExpiredFiles({ now, protectedJobIds: new Set(["job_active"]) }, dependencies))
      .resolves.toEqual({ removedJobs: 0, removedFiles: 0, removedDirectories: 0 });
    expect(await readFile(filePath, "utf8")).toBe("media");
  });

  it("never removes a registered path outside storage or follows a job-root symlink", async () => {
    const { root, registry, dependencies } = await fixture();
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
    roots.add(outside);
    await writeFile(outside, "keep");
    registry.registerFile({
      id: "file_outside_123",
      jobId: "job_outside",
      path: outside,
      relativePath: "../outside.txt",
      filename: "outside.txt",
      sizeBytes: 4,
      contentType: "video/mp4",
      kind: "final",
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString()
    });
    await mkdir(path.join(root, "jobs"), { recursive: true });
    await symlink(path.dirname(outside), path.join(root, "jobs", "job_symlink"));

    await cleanupExpiredFiles({ now: Date.now() }, dependencies);
    expect(await readFile(outside, "utf8")).toBe("keep");
    expect(registry.getRegisteredFile("file_outside_123")).not.toBeNull();
  });
});
