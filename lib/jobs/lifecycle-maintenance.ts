import "server-only";
import type { MediaJobRecord } from "@/lib/jobs/types";

export type MediaLifecycleCheckpoint = Readonly<{
  lastRecoveryAt: string | null;
  lastReconciliationAt: string | null;
  lastExpirationAt: string | null;
  lastFullSweepAt: string | null;
  updatedAt: string;
  version: number;
}>;

export type MediaLifecycleCheckpointUpdate = Readonly<{
  recovery?: boolean;
  reconciliation?: boolean;
  expiration?: boolean;
  fullSweep?: boolean;
}>;

export interface MediaJobLifecycleMaintenance {
  expireOverdueActiveJobs(limit: number): Promise<readonly MediaJobRecord[]>;
  expireTerminalJobs(limit: number): Promise<readonly MediaJobRecord[]>;
  expireReadyJobForMissingArtifact(artifactId: string, expectedVersion: number): Promise<boolean>;
  failJobForDanglingPublishedArtifact(artifactId: string, expectedVersion: number): Promise<boolean>;
  deleteRetainedExpiredJobs(limit: number, retentionSeconds: number): Promise<number>;
  getCheckpoint(): Promise<MediaLifecycleCheckpoint>;
  recordCheckpoint(update: MediaLifecycleCheckpointUpdate): Promise<MediaLifecycleCheckpoint>;
}

export interface MediaLifecycleLeadership {
  verify(): Promise<boolean>;
  release(): Promise<void>;
}

export interface MediaLifecycleElection {
  tryAcquire(): Promise<MediaLifecycleLeadership | null>;
}
