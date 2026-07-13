import { describe, expect, it } from "vitest";
import { API_ERROR_MESSAGES } from "@/lib/errors";
import type { JobRepository } from "@/lib/jobs/repository";
import type { MediaJobResult } from "@/lib/jobs/types";
import { API_ERROR_CODES } from "@/lib/types";

export type JobRepositoryContractHarness = Readonly<{
  repository: JobRepository;
  now: () => number;
  advanceBy: (milliseconds: number) => void;
}>;

export type JobRepositoryContractFactory = () => JobRepositoryContractHarness;

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
      durationSeconds: 12,
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      hasVideo: true,
      hasAudio: true,
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      audioCodec: "aac"
    }
  };
}

async function createRunning(repository: JobRepository, jobId: string) {
  const created = await repository.create({ jobId, processingPreset: "original" });
  expect(created.outcome).toBe("created");
  if (created.outcome !== "created") throw new Error("Expected created job.");
  const started = await repository.update(jobId, created.record.version, { type: "start" });
  expect(started.outcome).toBe("updated");
  if (started.outcome !== "updated") throw new Error("Expected running job.");
  return started.record;
}

export function runJobRepositoryContract(
  name: string,
  createHarness: JobRepositoryContractFactory
): void {
  describe(`${name} JobRepository contract`, () => {
    it("creates and gets a serializable record with persistence defaults", async () => {
      const harness = createHarness();
      const created = await harness.repository.create({
        jobId: "job_create",
        processingPreset: "compatible-mp4"
      });

      expect(created).toMatchObject({
        outcome: "created",
        record: {
          jobId: "job_create",
          status: "queued",
          progress: 0,
          processingPreset: "compatible-mp4",
          createdAt: new Date(harness.now()).toISOString(),
          startedAt: null,
          completedAt: null,
          expiresAt: null,
          cancellationRequestedAt: null,
          sourceMetadata: null,
          finalMetadata: null,
          canonicalError: null,
          retryCount: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          version: 1
        }
      });
      expect(await harness.repository.get("job_create")).toEqual(
        created.outcome === "created" ? created.record : null
      );
      expect(JSON.stringify(created)).not.toContain("AbortController");
    });

    it("rejects duplicate creation and returns null for an unknown job", async () => {
      const { repository } = createHarness();
      const first = await repository.create({ jobId: "job_duplicate", processingPreset: "original" });
      const duplicate = await repository.create({
        jobId: "job_duplicate",
        processingPreset: "audio-only"
      });

      expect(first.outcome).toBe("created");
      expect(duplicate).toMatchObject({ outcome: "duplicate", record: { processingPreset: "original" } });
      expect(await repository.get("job_unknown")).toBeNull();
    });

    it("uses optimistic versions, increments on success and reports conflicts", async () => {
      const { repository } = createHarness();
      const created = await repository.create({ jobId: "job_version", processingPreset: "original" });
      if (created.outcome !== "created") throw new Error("Expected created job.");

      const started = await repository.update("job_version", created.record.version, { type: "start" });
      expect(started).toMatchObject({ outcome: "updated", record: { status: "running", version: 2 } });
      const conflict = await repository.update("job_version", created.record.version, {
        type: "progress",
        progress: 10
      });
      expect(conflict).toMatchObject({ outcome: "version-conflict", record: { version: 2 } });
    });

    it("allows only one concurrent write with the same expected version", async () => {
      const { repository } = createHarness();
      const running = await createRunning(repository, "job_concurrent");
      const writes = await Promise.all([
        repository.update(running.jobId, running.version, { type: "progress", progress: 10 }),
        repository.update(running.jobId, running.version, { type: "progress", progress: 20 })
      ]);

      expect(writes.filter((write) => write.outcome === "updated")).toHaveLength(1);
      expect(writes.filter((write) => write.outcome === "version-conflict")).toHaveLength(1);
    });

    it("supports queued to running and generates lifecycle timestamps internally", async () => {
      const harness = createHarness();
      const created = await harness.repository.create({
        jobId: "job_timestamps",
        processingPreset: "original",
        createdAt: "/private/not-accepted"
      } as never);
      if (created.outcome !== "created") throw new Error("Expected created job.");
      expect(created.record.createdAt).toBe(new Date(harness.now()).toISOString());
      expect(created.record.completedAt).toBeNull();

      harness.advanceBy(500);
      const started = await harness.repository.update(created.record.jobId, created.record.version, {
        type: "start"
      });
      expect(started).toMatchObject({
        outcome: "updated",
        record: { status: "running", startedAt: new Date(harness.now()).toISOString(), completedAt: null }
      });
    });

    it("accepts monotonic running progress", async () => {
      const { repository } = createHarness();
      const running = await createRunning(repository, "job_progress");
      const first = await repository.update(running.jobId, running.version, {
        type: "progress",
        progress: 25.5
      });
      if (first.outcome !== "updated") throw new Error("Expected progress update.");
      const second = await repository.update(running.jobId, first.record.version, {
        type: "progress",
        progress: 75
      });
      expect(second).toMatchObject({ outcome: "updated", record: { progress: 75 } });
    });

    it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])(
      "rejects invalid progress %s",
      async (progress) => {
        const { repository } = createHarness();
        const running = await createRunning(repository, `job_progress_${String(progress).replaceAll("-", "n")}`);
        const update = await repository.update(running.jobId, running.version, {
          type: "progress",
          progress
        });
        expect(update).toMatchObject({ outcome: "invalid-state", record: { progress: 0 } });
      }
    );

    it("rejects progress decreases", async () => {
      const { repository } = createHarness();
      const running = await createRunning(repository, "job_progress_decrease");
      const increased = await repository.update(running.jobId, running.version, {
        type: "progress",
        progress: 80
      });
      if (increased.outcome !== "updated") throw new Error("Expected progress update.");
      const decreased = await repository.update(running.jobId, increased.record.version, {
        type: "progress",
        progress: 79
      });
      expect(decreased).toMatchObject({ outcome: "invalid-state", record: { progress: 80 } });
    });

    it("completes running jobs idempotently with progress 100", async () => {
      const { repository } = createHarness();
      const running = await createRunning(repository, "job_ready");
      const completed = await repository.update(running.jobId, running.version, {
        type: "complete",
        result: result("ready")
      });
      expect(completed).toMatchObject({
        outcome: "updated",
        record: { status: "ready", progress: 100, completedAt: expect.any(String) }
      });
      if (completed.outcome !== "updated") throw new Error("Expected completed job.");
      const duplicate = await repository.update(completed.record.jobId, completed.record.version, {
        type: "complete",
        result: result("duplicate")
      });
      expect(duplicate).toMatchObject({
        outcome: "invalid-state",
        record: { finalMetadata: { fileId: "file_ready" } }
      });
    });

    it("fails running jobs with only a canonical safe error", async () => {
      const { repository } = createHarness();
      const running = await createRunning(repository, "job_failed");
      const failed = await repository.update(running.jobId, running.version, {
        type: "fail",
        errorCode: API_ERROR_CODES.PROCESSING_FAILED,
        stack: "secret stack",
        path: "/private/input.mp4",
        stderr: "secret stderr"
      } as never);

      expect(failed).toMatchObject({
        outcome: "updated",
        record: {
          status: "failed",
          canonicalError: {
            code: API_ERROR_CODES.PROCESSING_FAILED,
            message: API_ERROR_MESSAGES.PROCESSING_FAILED
          }
        }
      });
      expect(JSON.stringify(failed)).not.toMatch(/secret stack|private\/input|secret stderr/);
    });

    it("cancels queued and running jobs idempotently", async () => {
      const queuedHarness = createHarness();
      const queued = await queuedHarness.repository.create({
        jobId: "job_cancel_queued",
        processingPreset: "original"
      });
      if (queued.outcome !== "created") throw new Error("Expected queued job.");
      const queuedCancelled = await queuedHarness.repository.requestCancellation(
        queued.record.jobId,
        queued.record.version
      );
      expect(queuedCancelled).toMatchObject({
        outcome: "updated",
        record: { status: "cancelled", cancellationRequestedAt: expect.any(String) }
      });
      if (queuedCancelled.outcome !== "updated") throw new Error("Expected cancellation.");
      expect(
        await queuedHarness.repository.requestCancellation(
          queued.record.jobId,
          queuedCancelled.record.version
        )
      ).toMatchObject({ outcome: "unchanged", record: { status: "cancelled" } });

      const runningHarness = createHarness();
      const running = await createRunning(runningHarness.repository, "job_cancel_running");
      expect(
        await runningHarness.repository.requestCancellation(running.jobId, running.version)
      ).toMatchObject({ outcome: "updated", record: { status: "cancelled" } });
    });

    it("keeps terminal records immutable and blocks cancelled to ready", async () => {
      const { repository } = createHarness();
      const running = await createRunning(repository, "job_terminal_cancelled");
      const cancelled = await repository.requestCancellation(running.jobId, running.version);
      if (cancelled.outcome !== "updated") throw new Error("Expected cancellation.");
      const completion = await repository.update(cancelled.record.jobId, cancelled.record.version, {
        type: "complete",
        result: result("forbidden")
      });
      expect(completion).toMatchObject({ outcome: "invalid-state", record: { status: "cancelled" } });
      expect(await repository.get(cancelled.record.jobId)).toEqual(cancelled.record);
    });

    it("blocks failed and expired records from returning to running", async () => {
      const { repository } = createHarness();
      const failedRunning = await createRunning(repository, "job_failed_restart");
      const failed = await repository.update(failedRunning.jobId, failedRunning.version, {
        type: "fail",
        errorCode: API_ERROR_CODES.INTERNAL_ERROR
      });
      if (failed.outcome !== "updated") throw new Error("Expected failed job.");
      expect(await repository.update(failed.record.jobId, failed.record.version, { type: "start" })).toMatchObject({
        outcome: "invalid-state",
        record: { status: "failed" }
      });

      const expiringRunning = await createRunning(repository, "job_expired_restart");
      const ready = await repository.update(expiringRunning.jobId, expiringRunning.version, {
        type: "complete",
        result: result("expired")
      });
      if (ready.outcome !== "updated") throw new Error("Expected ready job.");
      const expired = await repository.update(ready.record.jobId, ready.record.version, { type: "expire" });
      if (expired.outcome !== "updated") throw new Error("Expected expired job.");
      expect(await repository.update(expired.record.jobId, expired.record.version, { type: "start" })).toMatchObject({
        outcome: "invalid-state",
        record: { status: "expired" }
      });
    });

    it("returns frozen deep copies and prevents nested metadata leakage", async () => {
      const { repository } = createHarness();
      const running = await createRunning(repository, "job_copy");
      const sourceInput = {
        sourceId: "source_job_copy",
        filename: "source.mp4",
        sizeBytes: 1024,
        contentType: "video/mp4"
      };
      const source = await repository.update(running.jobId, running.version, {
        type: "set-source-metadata",
        sourceMetadata: sourceInput
      });
      if (source.outcome !== "updated") throw new Error("Expected source metadata.");
      const output = result("copy");
      const completed = await repository.update(source.record.jobId, source.record.version, {
        type: "complete",
        result: output
      });
      if (completed.outcome !== "updated") throw new Error("Expected completed job.");

      sourceInput.filename = "mutated.mp4";
      (output.media as { formatName: string }).formatName = "mutated";
      const first = await repository.get(completed.record.jobId);
      if (!first) throw new Error("Expected stored job.");
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.sourceMetadata)).toBe(true);
      expect(Object.isFrozen(first.finalMetadata?.media)).toBe(true);
      expect(first.sourceMetadata?.filename).toBe("source.mp4");
      expect(first.finalMetadata?.media.formatName).not.toBe("mutated");
      expect(() => {
        (first.finalMetadata?.media as { formatName: string }).formatName = "leak";
      }).toThrow();
      expect((await repository.get(completed.record.jobId))?.finalMetadata?.media.formatName).not.toBe(
        "leak"
      );
    });

    it("rejects invalid creation input without persisting a partial record", async () => {
      const { repository } = createHarness();
      await expect(
        repository.create({ jobId: "../../unsafe", processingPreset: "original" })
      ).resolves.toEqual({ outcome: "invalid-state" });
      await expect(
        repository.create({ jobId: "job_bad_preset", processingPreset: "unknown" } as never)
      ).resolves.toEqual({ outcome: "invalid-state" });
      expect(await repository.list()).toEqual([]);
    });

    it("returns an immutable list containing independent record copies", async () => {
      const { repository } = createHarness();
      await repository.create({ jobId: "job_list_copy", processingPreset: "original" });
      const listed = await repository.list();
      expect(Object.isFrozen(listed)).toBe(true);
      expect(Object.isFrozen(listed[0])).toBe(true);
      expect(() => (listed as unknown as unknown[]).pop()).toThrow();
      expect(await repository.get("job_list_copy")).toEqual(listed[0]);
    });

    it("validates and timestamps source metadata once", async () => {
      const harness = createHarness();
      const running = await createRunning(harness.repository, "job_source_metadata");
      harness.advanceBy(250);
      const source = await harness.repository.update(running.jobId, running.version, {
        type: "set-source-metadata",
        sourceMetadata: {
          sourceId: "source_metadata",
          filename: "source.mp4",
          sizeBytes: 100,
          contentType: "video/mp4"
        }
      });
      expect(source).toMatchObject({
        outcome: "updated",
        record: {
          sourceMetadata: { registeredAt: new Date(harness.now()).toISOString() },
          version: running.version + 1
        }
      });
      if (source.outcome !== "updated") throw new Error("Expected source metadata.");
      await expect(
        harness.repository.update(source.record.jobId, source.record.version, {
          type: "set-source-metadata",
          sourceMetadata: {
            sourceId: "source_second",
            filename: "second.mp4",
            sizeBytes: 100,
            contentType: "video/mp4"
          }
        })
      ).resolves.toMatchObject({ outcome: "invalid-state", record: { version: source.record.version } });
    });

    it("reports cancellation not-found and version-conflict without changing state", async () => {
      const { repository } = createHarness();
      await expect(repository.requestCancellation("job_missing", 1)).resolves.toEqual({
        outcome: "not-found"
      });
      const created = await repository.create({
        jobId: "job_cancel_conflict",
        processingPreset: "original"
      });
      if (created.outcome !== "created") throw new Error("Expected queued job.");
      await expect(
        repository.requestCancellation(created.record.jobId, created.record.version + 1)
      ).resolves.toMatchObject({
        outcome: "version-conflict",
        record: { status: "queued", version: created.record.version }
      });
      expect((await repository.get(created.record.jobId))?.status).toBe("queued");
    });

    it("transitions each terminal outcome to expired without changing its canonical payload", async () => {
      const { repository } = createHarness();

      const readyRunning = await createRunning(repository, "job_expire_ready");
      const ready = await repository.update(readyRunning.jobId, readyRunning.version, {
        type: "complete",
        result: result("expire_ready")
      });
      if (ready.outcome !== "updated") throw new Error("Expected ready job.");
      const expiredReady = await repository.update(ready.record.jobId, ready.record.version, {
        type: "expire"
      });
      expect(expiredReady).toMatchObject({
        outcome: "updated",
        record: { status: "expired", finalMetadata: { fileId: "file_expire_ready" } }
      });

      const failedRunning = await createRunning(repository, "job_expire_failed");
      const failed = await repository.update(failedRunning.jobId, failedRunning.version, {
        type: "fail",
        errorCode: API_ERROR_CODES.PROCESSING_FAILED
      });
      if (failed.outcome !== "updated") throw new Error("Expected failed job.");
      await expect(
        repository.update(failed.record.jobId, failed.record.version, { type: "expire" })
      ).resolves.toMatchObject({
        outcome: "updated",
        record: { status: "expired", canonicalError: { code: API_ERROR_CODES.PROCESSING_FAILED } }
      });

      const cancelled = await repository.create({
        jobId: "job_expire_cancelled",
        processingPreset: "original"
      });
      if (cancelled.outcome !== "created") throw new Error("Expected queued job.");
      const cancelledTerminal = await repository.requestCancellation(
        cancelled.record.jobId,
        cancelled.record.version
      );
      if (cancelledTerminal.outcome !== "updated") throw new Error("Expected cancelled job.");
      await expect(
        repository.update(cancelledTerminal.record.jobId, cancelledTerminal.record.version, {
          type: "expire"
        })
      ).resolves.toMatchObject({
        outcome: "updated",
        record: { status: "expired", canonicalError: { code: API_ERROR_CODES.JOB_CANCELLED } }
      });
    });

    it("cleanup removes only expired terminal records and never active jobs", async () => {
      const harness = createHarness();
      await harness.repository.create({ jobId: "job_cleanup_queued", processingPreset: "original" });
      await createRunning(harness.repository, "job_cleanup_running");
      const terminalRunning = await createRunning(harness.repository, "job_cleanup_terminal");
      const terminal = await harness.repository.update(terminalRunning.jobId, terminalRunning.version, {
        type: "complete",
        result: result("cleanup")
      });
      if (terminal.outcome !== "updated") throw new Error("Expected ready job.");

      harness.advanceBy(60_001);
      expect(await harness.repository.cleanupExpired(harness.now())).toBe(1);
      expect(await harness.repository.get(terminal.record.jobId)).toBeNull();
      expect((await harness.repository.get("job_cleanup_queued"))?.status).toBe("queued");
      expect((await harness.repository.get("job_cleanup_running"))?.status).toBe("running");
    });

    it("cleanup deletes records already transitioned to expired", async () => {
      const { repository } = createHarness();
      const running = await createRunning(repository, "job_cleanup_expired");
      const ready = await repository.update(running.jobId, running.version, {
        type: "complete",
        result: result("cleanup_expired")
      });
      if (ready.outcome !== "updated") throw new Error("Expected ready job.");
      const expired = await repository.update(ready.record.jobId, ready.record.version, {
        type: "expire"
      });
      if (expired.outcome !== "updated") throw new Error("Expected expired job.");
      expect(await repository.cleanupExpired()).toBe(1);
      expect(await repository.get(expired.record.jobId)).toBeNull();
    });
  });
}
