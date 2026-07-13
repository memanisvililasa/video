import { describe, expect, it } from "vitest";
import type { ClaimedMediaJob, JobLeaseQueue, JobLeaseRef, OwnedJobUpdateResult } from "@/lib/jobs/job-lease-queue";
import type { MediaArtifactRepository, FinalPublicationCoordinator } from "@/lib/storage/media-artifact-repository";
import { createOwnedJobLeaseSession } from "@/lib/worker/lease-session";

function claimed(): ClaimedMediaJob {
  const workerId = `worker_${"a".repeat(32)}`;
  const attemptId = `attempt_${"b".repeat(32)}`;
  return {
    record: {
      jobId: "job_serial_lease",
      status: "running",
      processingPreset: "original",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      expiresAt: null,
      cancellationRequestedAt: null,
      progress: 0,
      sourceMetadata: null,
      finalMetadata: null,
      canonicalError: null,
      retryCount: 0,
      leaseOwner: workerId,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      version: 2
    },
    workItem: { sourceUrl: "https://media.example.test/video.mp4", formatId: "direct-source", processingPreset: "original" },
    lease: { jobId: "job_serial_lease", workerId, attemptId, version: 2, leaseExpiresAt: "2099-01-01T00:00:00.000Z" }
  };
}

describe("owned worker lease session", () => {
  it("serializes heartbeat and progress so the worker never conflicts with its own version", async () => {
    let expectedVersion = 2;
    let active = 0;
    let maximum = 0;
    const mutate = async (lease: JobLeaseRef): Promise<OwnedJobUpdateResult> => {
      expect(lease.version).toBe(expectedVersion);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      expectedVersion += 1;
      const next = { ...lease, version: expectedVersion };
      return { outcome: "updated", record: { ...claimed().record, version: expectedVersion }, lease: next };
    };
    const queue = {
      renewLease: mutate,
      updateProgressOwned: mutate
    } as unknown as JobLeaseQueue;
    const session = createOwnedJobLeaseSession({
      job: claimed(),
      queue,
      artifacts: {} as MediaArtifactRepository,
      publication: {} as FinalPublicationCoordinator
    });
    await Promise.all([session.renew(), session.updateProgress(10)]);
    expect(maximum).toBe(1);
    expect(session.currentLease().version).toBe(4);
  });
});
