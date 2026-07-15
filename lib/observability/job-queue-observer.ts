import "server-only";
import type {
  JobLeaseQueue,
  JobLeaseRef
} from "@/lib/jobs/job-lease-queue";
import { classifyError } from "@/lib/observability/redaction";
import type { OperationalSignals } from "@/lib/observability/signals";
import { jobErrorCategory, safeSignalMetric } from "@/lib/observability/signals";

export function observeJobLeaseQueue(
  queue: JobLeaseQueue,
  signals: OperationalSignals,
  now: () => number = Date.now
): JobLeaseQueue {
  async function databaseBoundary<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const classified = classifyError(error);
      safeSignalMetric(() => signals.metrics.databaseQueryFailure(
        classified.category === "timeout" ? "timeout" : "database"
      ));
      signals.emit("warn", "db.query.failed", {
        outcome: "failure",
        reasonCode: classified.category === "timeout" ? "readiness_timeout" : "database_unavailable",
        errorCategory: classified.category === "timeout" ? "timeout" : "database"
      });
      throw error;
    }
  }

  function leaseLost(lease: JobLeaseRef): void {
    signals.emit("warn", "job.lease_lost", {
      outcome: "failure",
      reasonCode: "lease_lost",
      errorCategory: "database",
      publicJobId: lease.jobId
    });
  }

  return Object.freeze({
    async enqueue(input: Parameters<JobLeaseQueue["enqueue"]>[0]) {
      const result = await databaseBoundary(() => queue.enqueue(input));
      if (result.outcome === "created") {
        const preset = signals.preset(result.record.processingPreset);
        signals.emit("info", "job.queued", {
          outcome: "success",
          reasonCode: "none",
          publicJobId: result.record.jobId,
          preset
        });
        safeSignalMetric(() => signals.metrics.jobSubmitted(preset));
      }
      return result;
    },
    async claimNext(workerId: Parameters<JobLeaseQueue["claimNext"]>[0]) {
      const result = await databaseBoundary(() => queue.claimNext(workerId));
      safeSignalMetric(() => signals.metrics.setWorkerHeartbeat(now() / 1_000));
      if (result.outcome === "claimed") {
        signals.emit("info", "job.claimed", {
          outcome: "success",
          reasonCode: "none",
          publicJobId: result.job.record.jobId,
          attempt: result.job.record.retryCount + 1,
          preset: signals.preset(result.job.record.processingPreset),
          stage: "queued"
        });
      }
      return result;
    },
    async requestCancellation(jobId: Parameters<JobLeaseQueue["requestCancellation"]>[0]) {
      const result = await databaseBoundary(() => queue.requestCancellation(jobId));
      if (result.outcome === "cancelled") {
        const preset = signals.preset(result.record.processingPreset);
        signals.emit("info", "job.cancelled", {
          outcome: "cancelled",
          reasonCode: "cancelled",
          errorCategory: "cancellation",
          publicJobId: result.record.jobId,
          preset
        });
        safeSignalMetric(() => signals.metrics.jobCancelled(preset));
      }
      return result;
    },
    async observeOwnedState(lease: Parameters<JobLeaseQueue["observeOwnedState"]>[0]) {
      const result = await databaseBoundary(() => queue.observeOwnedState(lease));
      safeSignalMetric(() => signals.metrics.setWorkerHeartbeat(now() / 1_000));
      if (result.outcome === "ownership-lost" || result.outcome === "not-found") leaseLost(lease);
      return result;
    },
    async renewLease(lease: Parameters<JobLeaseQueue["renewLease"]>[0]) {
      const result = await databaseBoundary(() => queue.renewLease(lease));
      if (result.outcome === "updated") {
        safeSignalMetric(() => signals.metrics.setWorkerHeartbeat(now() / 1_000));
      }
      if (result.outcome === "ownership-lost" || result.outcome === "not-found") leaseLost(lease);
      return result;
    },
    setSourceMetadataOwned(
      lease: Parameters<JobLeaseQueue["setSourceMetadataOwned"]>[0],
      metadata: Parameters<JobLeaseQueue["setSourceMetadataOwned"]>[1]
    ) {
      return databaseBoundary(() => queue.setSourceMetadataOwned(lease, metadata));
    },
    async updateProgressOwned(
      lease: Parameters<JobLeaseQueue["updateProgressOwned"]>[0],
      progress: Parameters<JobLeaseQueue["updateProgressOwned"]>[1]
    ) {
      const result = await databaseBoundary(() => queue.updateProgressOwned(lease, progress));
      if (result.outcome === "updated") {
        signals.emit("debug", "job.progress", {
          outcome: "success",
          reasonCode: "none",
          publicJobId: result.record.jobId,
          attempt: result.record.retryCount + 1,
          preset: signals.preset(result.record.processingPreset),
          metadata: { progress: Math.round(result.record.progress) }
        });
      }
      return result;
    },
    async completeOwned(
      lease: Parameters<JobLeaseQueue["completeOwned"]>[0],
      completion: Parameters<JobLeaseQueue["completeOwned"]>[1]
    ) {
      const result = await databaseBoundary(() => queue.completeOwned(lease, completion));
      if (result.outcome === "completed") {
        const preset = signals.preset(result.record.processingPreset);
        const duration = signals.jobDurationSeconds(result.record, now());
        if (result.record.status === "failed") {
          const category = jobErrorCategory(result.record.canonicalError?.code);
          signals.emit("warn", "job.failed", {
            outcome: "failure",
            reasonCode: "internal_error",
            errorCategory: category,
            publicJobId: result.record.jobId,
            attempt: result.record.retryCount + 1,
            preset,
            durationMs: duration * 1_000
          });
          safeSignalMetric(() => signals.metrics.jobFailed(preset, category, duration));
        } else if (result.record.status === "cancelled") {
          signals.emit("info", "job.cancelled", {
            outcome: "cancelled",
            reasonCode: "cancelled",
            errorCategory: "cancellation",
            publicJobId: result.record.jobId,
            preset
          });
          safeSignalMetric(() => signals.metrics.jobCancelled(preset));
        }
      }
      return result;
    },
    async recoverExpiredLeases() {
      const result = await databaseBoundary(() => queue.recoverExpiredLeases());
      for (const record of result.requeued) {
        signals.emit("info", "job.retry_scheduled", {
          outcome: "success",
          reasonCode: "retry_scheduled",
          errorCategory: "internal",
          publicJobId: record.jobId,
          attempt: record.retryCount + 1,
          preset: signals.preset(record.processingPreset)
        });
      }
      for (const record of result.failed) {
        const category = jobErrorCategory(record.canonicalError?.code);
        signals.emit("error", "job.retry_exhausted", {
          outcome: "failure",
          reasonCode: "retry_exhausted",
          errorCategory: category,
          publicJobId: record.jobId,
          attempt: record.retryCount + 1,
          preset: signals.preset(record.processingPreset)
        });
      }
      safeSignalMetric(() => signals.metrics.jobRetried("internal", result.requeued.length));
      for (const record of result.failed) {
        safeSignalMetric(() => signals.metrics.retryExhausted(jobErrorCategory(record.canonicalError?.code)));
      }
      return result;
    }
  });
}
