import { describe, expect, it, vi } from "vitest";
import { createInMemoryJobRepository } from "@/lib/jobs/in-memory-job-repository";
import {
  cancelJob,
  createMediaJobQueue,
  enqueueMediaJob,
  getJob,
  mediaJobQueue,
  mediaJobRuntime
} from "@/lib/jobs/queue";
import type { JobRepository } from "@/lib/jobs/repository";
import type { MediaJobResult } from "@/lib/jobs/types";

function result(suffix: string): MediaJobResult {
  const fileId = `file_${suffix}`;
  return {
    fileId,
    downloadUrl: `/api/file/${fileId}`,
    filename: `${suffix}.mp4`,
    sizeBytes: 1024,
    mimeType: "video/mp4",
    expiresAt: "2026-01-01T01:00:00.000Z",
    processingPreset: "original",
    media: {
      durationSeconds: 1,
      formatName: "mp4",
      hasVideo: true,
      hasAudio: true
    }
  };
}

async function settle(
  runtime: ReturnType<typeof createMediaJobQueue>,
  jobId: string,
  rounds = 40
) {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    const snapshot = await runtime.getJob(jobId);
    if (snapshot.status !== "queued" && snapshot.status !== "running") return snapshot;
  }
  return runtime.getJob(jobId);
}

function observableRepository(backing: JobRepository) {
  const repository: JobRepository = {
    create: vi.fn(backing.create),
    get: vi.fn(backing.get),
    list: vi.fn(backing.list),
    update: vi.fn(backing.update),
    requestCancellation: vi.fn(backing.requestCancellation),
    cleanupExpired: vi.fn(backing.cleanupExpired)
  };
  return { repository, backing };
}

describe("media job runtime composition", () => {
  it("keeps the compatibility exports on one shared default repository", async () => {
    expect(mediaJobQueue).toBe(mediaJobRuntime);
    expect(mediaJobQueue.jobRepository).toBe(mediaJobRuntime.jobRepository);
    expect(mediaJobQueue.executionQueue).toBe(mediaJobRuntime.executionQueue);

    const enqueued = await enqueueMediaJob({
      processingPreset: "original",
      handler: () => result("shared_default")
    });
    const snapshot = await settle(mediaJobRuntime, enqueued.jobId);

    expect(await getJob(enqueued.jobId)).toEqual(snapshot);
    expect(await cancelJob(enqueued.jobId)).toEqual(snapshot);
  });

  it("creates isolated runtimes unless dependencies are explicitly shared", async () => {
    const first = createMediaJobQueue({ createJobId: () => "job_same_id" });
    const second = createMediaJobQueue({ createJobId: () => "job_same_id" });
    const waitForAbort = (_context: unknown, signal: AbortSignal) =>
      new Promise<MediaJobResult>((resolve) => {
        signal.addEventListener("abort", () => resolve(result("isolated")), { once: true });
      });

    const firstJob = await first.enqueue({ processingPreset: "original", handler: waitForAbort });
    const secondJob = await second.enqueue({ processingPreset: "original", handler: waitForAbort });
    expect(firstJob.jobId).toBe(secondJob.jobId);
    expect(first.jobRepository).not.toBe(second.jobRepository);
    expect(first.executionQueue).not.toBe(second.executionQueue);

    await first.cancelJob(firstJob.jobId);
    expect((await first.getJob(firstJob.jobId)).status).toBe("cancelled");
    expect((await second.getJob(secondJob.jobId)).status).not.toBe("cancelled");
    await second.cancelJob(secondJob.jobId);
  });

  it("creates each job once and uses the same repository for state, cancellation and cleanup", async () => {
    const backing = createInMemoryJobRepository({ terminalTtlMs: 0 });
    const observed = observableRepository(backing);
    const runtime = createMediaJobQueue({
      jobRepository: observed.repository,
      createJobId: () => "job_observed"
    });
    const enqueued = await runtime.enqueue({
      processingPreset: "original",
      handler: (_context, signal) =>
        new Promise<MediaJobResult>((resolve) => {
          signal.addEventListener("abort", () => resolve(result("observed")), { once: true });
        })
    });

    expect(observed.repository.create).toHaveBeenCalledTimes(1);
    await runtime.cancelJob(enqueued.jobId);
    expect(observed.repository.requestCancellation).toHaveBeenCalled();
    expect(await backing.get(enqueued.jobId)).toMatchObject({
      status: "cancelled",
      cancellationRequestedAt: expect.any(String)
    });
    await runtime.cleanupExpiredJobs(Date.now() + 60_000);
    expect(observed.repository.cleanupExpired).toHaveBeenCalledTimes(2);
    expect(await backing.get(enqueued.jobId)).toBeNull();
  });

  it("routes progress and completion through repository mutations", async () => {
    const backing = createInMemoryJobRepository();
    const observed = observableRepository(backing);
    const runtime = createMediaJobQueue({
      jobRepository: observed.repository,
      createJobId: () => "job_repository_writes"
    });
    const enqueued = await runtime.enqueue({
      processingPreset: "original",
      handler(_context, _signal, updateProgress) {
        updateProgress(45);
        return result("repository_writes");
      }
    });
    expect((await settle(runtime, enqueued.jobId)).status).toBe("ready");

    const mutations = vi.mocked(observed.repository.update).mock.calls.map((call) => call[2].type);
    expect(mutations).toEqual(expect.arrayContaining(["start", "progress", "complete"]));
    expect(runtime.executionQueue).not.toHaveProperty("getJob");
    expect(runtime.executionQueue).not.toHaveProperty("listJobs");
  });
});
