import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileRegistry,
  deleteRegisteredFile,
  registerFile
} from "@/lib/storage/file-registry";
import { createJobArtifactLifecycle } from "@/lib/storage/job-artifacts";
import { getPreparedFile } from "@/lib/storage/local-storage";
import type { StoredFile } from "@/lib/storage/types";

let temporaryRoot: string;
let storageRoot: string;
let jobDirectory: string;
let nextFileId: number;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-artifacts-"));
  storageRoot = path.join(temporaryRoot, "storage");
  jobDirectory = path.join(storageRoot, "jobs", "job_test");
  await mkdir(jobDirectory, { recursive: true });
  nextFileId = 1;
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function createHarness() {
  const registry = createFileRegistry();
  const lifecycle = createJobArtifactLifecycle(
    { jobId: "job_test", maxFileSizeBytes: 1024 },
    {
      ensureJobDirectory: async () => jobDirectory,
      getStorageRoot: () => storageRoot,
      getRelativeStoragePath: (candidate) => path.relative(storageRoot, candidate),
      registerFile: registry.registerFile,
      deleteRegisteredFile: registry.deleteRegisteredFile,
      createFileId: () => `file_${nextFileId++}`,
      createSourceId: () => `source_${nextFileId++}`,
      getExpiresAt: () => "2026-01-01T01:00:00.000Z",
      now: () => Date.UTC(2026, 0, 1)
    }
  );
  return { registry, lifecycle };
}

async function registerSource(lifecyclePromise: ReturnType<typeof createJobArtifactLifecycle>) {
  const lifecycle = await lifecyclePromise;
  const sourcePath = path.join(lifecycle.jobDirectory, "source.mp4");
  await writeFile(sourcePath, "source");
  const source = await lifecycle.registerSource({
    path: sourcePath,
    filename: "Public video.mp4",
    contentType: "video/mp4",
    sizeBytes: 6
  });
  return { lifecycle, source, sourcePath };
}

describe("job artifact lifecycle", () => {
  it("publishes original bytes under a separate final path and retains only final", async () => {
    const harness = createHarness();
    const { lifecycle, source, sourcePath } = await registerSource(harness.lifecycle);
    const plan = lifecycle.prepareFinal("original", source);
    await lifecycle.publishOriginal(source, plan);
    const stored = await lifecycle.registerFinal(plan, 6);
    await lifecycle.completeSuccess();

    expect(plan.path).toBe(path.join(await realpath(jobDirectory), "final.mp4"));
    expect(await readFile(plan.path, "utf8")).toBe("source");
    expect(await exists(sourcePath)).toBe(false);
    expect(harness.registry.getRegisteredFile(source.registryId)).toBeNull();
    expect(harness.registry.getRegisteredFile(stored.id)).toMatchObject({ kind: "final", path: plan.path });
  });

  it("registers source as internal and final as public-kind storage entries", async () => {
    const harness = createHarness();
    const { lifecycle, source } = await registerSource(harness.lifecycle);
    expect(harness.registry.getRegisteredFile(source.registryId)).toMatchObject({ kind: "source" });

    const plan = lifecycle.prepareFinal("compatible-mp4", source);
    await writeFile(plan.path, "output");
    const stored = await lifecycle.registerFinal(plan, 6);
    expect(stored).toMatchObject({
      kind: "final",
      filename: "Public video.mp4",
      contentType: "video/mp4"
    });
  });

  it("uses only fixed final extensions for processing presets", async () => {
    const presets = [
      ["remux-to-mp4", "final.mp4", "video/mp4"],
      ["compatible-mp4", "final.mp4", "video/mp4"],
      ["audio-only", "final.m4a", "audio/mp4"]
    ] as const;

    for (const [preset, filename, mimeType] of presets) {
      await rm(jobDirectory, { recursive: true, force: true });
      await mkdir(jobDirectory, { recursive: true });
      const harness = createHarness();
      const { lifecycle, source } = await registerSource(harness.lifecycle);
      const plan = lifecycle.prepareFinal(preset, source);
      expect(path.basename(plan.path)).toBe(filename);
      expect(plan.mimeType).toBe(mimeType);
    }
  });

  it("rolls back registered source, final and exact owned paths idempotently", async () => {
    const harness = createHarness();
    const { lifecycle, source, sourcePath } = await registerSource(harness.lifecycle);
    const plan = lifecycle.prepareFinal("remux-to-mp4", source);
    await writeFile(plan.path, "output");
    const stored = await lifecycle.registerFinal(plan, 6);

    await lifecycle.discard();
    await lifecycle.discard();
    expect(await exists(sourcePath)).toBe(false);
    expect(await exists(plan.path)).toBe(false);
    expect(harness.registry.getRegisteredFile(source.registryId)).toBeNull();
    expect(harness.registry.getRegisteredFile(stored.id)).toBeNull();
  });

  it("does not remove an unknown neighboring file during rollback", async () => {
    const harness = createHarness();
    const { lifecycle, source } = await registerSource(harness.lifecycle);
    lifecycle.prepareFinal("audio-only", source);
    const neighbor = path.join(jobDirectory, "neighbor.txt");
    await writeFile(neighbor, "keep");

    await lifecycle.discard();
    expect(await readFile(neighbor, "utf8")).toBe("keep");
    expect(await exists(jobDirectory)).toBe(true);
  });

  it("rejects source paths that are not the server-generated source filename", async () => {
    const harness = createHarness();
    const lifecycle = await harness.lifecycle;
    const unsafePath = path.join(jobDirectory, "user-name.mp4");
    await writeFile(unsafePath, "source");

    await expect(lifecycle.registerSource({
      path: unsafePath,
      filename: "video.mp4",
      contentType: "video/mp4",
      sizeBytes: 6
    })).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
  });

  it("removes an owned server-generated source after registration validation fails", async () => {
    const harness = createHarness();
    const lifecycle = await harness.lifecycle;
    const sourcePath = path.join(await realpath(jobDirectory), "source.mp4");
    await writeFile(sourcePath, "source");

    await expect(lifecycle.registerSource({
      path: sourcePath,
      filename: "video.mp4",
      contentType: "video/mp4",
      sizeBytes: 999
    })).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    await lifecycle.discard();

    expect(await exists(sourcePath)).toBe(false);
  });

  it("does not overwrite a duplicate registry ID", () => {
    const registry = createFileRegistry();
    const file: StoredFile = {
      id: "file_duplicate",
      jobId: "job_test",
      path: path.join(jobDirectory, "final.mp4"),
      relativePath: "jobs/job_test/final.mp4",
      filename: "video.mp4",
      sizeBytes: 6,
      contentType: "video/mp4",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
      kind: "final"
    };
    registry.registerFile(file);
    expect(() => registry.registerFile(file)).toThrow();
  });

  it("never exposes a source registry entry through public prepared-file lookup", async () => {
    const sourcePath = path.join(jobDirectory, "source.mp4");
    await writeFile(sourcePath, "source");
    const sourceId = `source_public_lookup_${Date.now()}`;
    registerFile({
      id: sourceId,
      jobId: "job_test",
      path: sourcePath,
      relativePath: "jobs/job_test/source.mp4",
      filename: "source.mp4",
      sizeBytes: 6,
      contentType: "video/mp4",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      kind: "source"
    });
    try {
      await expect(getPreparedFile(sourceId)).resolves.toBeNull();
    } finally {
      deleteRegisteredFile(sourceId);
    }
  });
});
