import { describe, expect, it, vi } from "vitest";
import type { JobLeaseQueue } from "@/lib/jobs/job-lease-queue";
import type {
  MediaJobLifecycleMaintenance,
  MediaLifecycleElection,
  MediaLifecycleLeadership
} from "@/lib/jobs/lifecycle-maintenance";
import type { MediaStorageHealth } from "@/lib/storage/media-storage";
import type { MediaStorageReconciler } from "@/lib/storage/reconciliation";
import { createMediaLifecycleCoordinator } from "@/lib/worker/lifecycle-coordinator";
import type { WorkerLogger } from "@/lib/worker/logger";

const logger: WorkerLogger = Object.freeze({ info() {}, warn() {}, error() {} });

function dependencies(overrides: { healthy?: boolean; leader?: boolean } = {}) {
  let healthy = overrides.healthy ?? true;
  let released = false;
  const leadership: MediaLifecycleLeadership = {
    verify: vi.fn(async () => !released),
    release: vi.fn(async () => { released = true; })
  };
  const election: MediaLifecycleElection = {
    tryAcquire: vi.fn(async () => overrides.leader === false ? null : leadership)
  };
  const maintenance = {
    expireOverdueActiveJobs: vi.fn(async () => []),
    expireTerminalJobs: vi.fn(async () => []),
    expireReadyJobForMissingArtifact: vi.fn(async () => false),
    failJobForDanglingPublishedArtifact: vi.fn(async () => false),
    deleteRetainedExpiredJobs: vi.fn(async () => 0),
    getCheckpoint: vi.fn(),
    recordCheckpoint: vi.fn(async () => ({
      lastRecoveryAt: "2026-01-01T00:00:00.000Z",
      lastReconciliationAt: "2026-01-01T00:00:00.000Z",
      lastExpirationAt: "2026-01-01T00:00:00.000Z",
      lastFullSweepAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: 1
    }))
  } as unknown as MediaJobLifecycleMaintenance;
  const queue = {
    recoverExpiredLeases: vi.fn(async () => ({ requeued: [], failed: [] }))
  } as unknown as JobLeaseQueue;
  const reconciler = {
    reconcile: vi.fn(async () => ({
      inspectedArtifacts: 0,
      missingArtifacts: 0,
      removedArtifacts: 0,
      removedOrphanObjects: 0,
      removedAttemptWorkspaces: 0,
      protectedActiveAttempts: 0
    })),
    cleanupJobArtifacts: vi.fn()
  } as unknown as MediaStorageReconciler;
  const storageHealth: MediaStorageHealth = {
    check: vi.fn(async () => {
      if (!healthy) throw new Error("unavailable");
    })
  };
  return {
    election,
    leadership,
    maintenance,
    queue,
    reconciler,
    storageHealth,
    setHealthy(value: boolean) { healthy = value; }
  };
}

function coordinator(deps: ReturnType<typeof dependencies>, selectedLogger: WorkerLogger = logger) {
  return createMediaLifecycleCoordinator({
    enabled: true,
    election: deps.election,
    maintenance: deps.maintenance,
    queue: deps.queue,
    reconciler: deps.reconciler,
    storageHealth: deps.storageHealth,
    logger: selectedLogger,
    recoveryIntervalMs: 1_000,
    reconciliationIntervalMs: 1_000,
    storageHealthIntervalMs: 1_000,
    electionRetryIntervalMs: 1_000,
    expirationBatchSize: 10,
    expiredRetentionSeconds: 60,
    random: () => 0.5,
    now: () => Date.UTC(2026, 0, 1)
  });
}

describe("media lifecycle coordinator", () => {
  it("runs bounded startup maintenance only while elected and releases leadership", async () => {
    const deps = dependencies();
    const lifecycle = coordinator(deps);
    await lifecycle.startup();
    expect(deps.queue.recoverExpiredLeases).toHaveBeenCalledTimes(1);
    expect(deps.reconciler.reconcile).toHaveBeenCalledTimes(1);
    expect(deps.maintenance.expireOverdueActiveJobs).toHaveBeenCalledWith(10);
    expect(deps.maintenance.recordCheckpoint).toHaveBeenCalledWith({
      recovery: true,
      reconciliation: true,
      expiration: true,
      fullSweep: true
    });
    expect(lifecycle.canClaim()).toBe(true);
    await lifecycle.stop();
    expect(deps.leadership.release).toHaveBeenCalledTimes(1);
  });

  it("logs sanitised leadership acquisition and release boundaries", async () => {
    const deps = dependencies();
    const events: Array<{ level: string; event: string; fields?: object }> = [];
    const selectedLogger: WorkerLogger = {
      info: (event, fields) => { events.push({ level: "info", event, fields }); },
      warn: (event, fields) => { events.push({ level: "warn", event, fields }); },
      error: (event, fields) => { events.push({ level: "error", event, fields }); }
    };
    const lifecycle = coordinator(deps, selectedLogger);
    await lifecycle.startup();
    await lifecycle.stop();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "info", event: "worker.lifecycle.leadership-acquired" }),
      expect.objectContaining({
        level: "info",
        event: "worker.lifecycle.leadership-lost",
        fields: { reason: "shutdown" }
      })
    ]));
  });

  it("allows a healthy follower to process but never runs destructive maintenance", async () => {
    const deps = dependencies({ leader: false });
    const lifecycle = coordinator(deps);
    await lifecycle.startup();
    expect(lifecycle.canClaim()).toBe(true);
    expect(deps.queue.recoverExpiredLeases).not.toHaveBeenCalled();
    expect(deps.reconciler.reconcile).not.toHaveBeenCalled();
    await lifecycle.stop();
  });

  it("fails startup closed when the durable volume is unhealthy", async () => {
    const deps = dependencies({ healthy: false });
    const lifecycle = coordinator(deps);
    await expect(lifecycle.startup()).rejects.toThrow("storage");
    expect(lifecycle.canClaim()).toBe(false);
    expect(deps.election.tryAcquire).not.toHaveBeenCalled();
    await lifecycle.stop();
  });

  it("blocks claims without bypassing each attempt's DB-loss grace", async () => {
    const deps = dependencies();
    const lifecycle = coordinator(deps);
    await lifecycle.startup();
    const unsafe = vi.fn();
    lifecycle.onUnsafeInfrastructure(unsafe);
    lifecycle.reportDatabaseHealth(false);
    expect(lifecycle.canClaim()).toBe(false);
    expect(unsafe).not.toHaveBeenCalled();
    lifecycle.reportDatabaseHealth(true);
    expect(lifecycle.canClaim()).toBe(true);
    await lifecycle.stop();
  });
});
