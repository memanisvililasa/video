import {
  applyMediaJobMutation,
  cloneMediaJobRecord,
  createMediaJobRecord,
  isMediaJobTerminal
} from "@/lib/jobs/job-record";
import type {
  JobRepository,
  JobRepositoryCancellationResult,
  JobRepositoryCreateResult,
  JobRepositoryUpdateResult
} from "@/lib/jobs/repository";
import type { MediaJobRecord } from "@/lib/jobs/types";

const DEFAULT_TERMINAL_TTL_MS = 60 * 60 * 1000;
const MAX_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_JOB_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export type CreateInMemoryJobRepositoryOptions = Readonly<{
  terminalTtlMs?: number;
  now?: () => number;
}>;

export type InMemoryJobRepository = JobRepository & Readonly<{
  /** @internal Instance-scoped test helper; never part of production wiring. */
  clearForTests: () => void;
}>;

function normalizeTerminalTtl(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_TTL_MS;
  return Math.min(MAX_TERMINAL_TTL_MS, Math.max(0, Math.trunc(value as number)));
}

function validNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) throw new TypeError("Media job clock must return a finite timestamp.");
  return value;
}

function safeJobId(jobId: string): boolean {
  return typeof jobId === "string" && SAFE_JOB_ID.test(jobId);
}

export function createInMemoryJobRepository(
  options: CreateInMemoryJobRepositoryOptions = {}
): InMemoryJobRepository {
  const terminalTtlMs = normalizeTerminalTtl(options.terminalTtlMs);
  const now = options.now ?? Date.now;
  const records = new Map<string, MediaJobRecord>();

  async function create(input: Parameters<JobRepository["create"]>[0]): Promise<JobRepositoryCreateResult> {
    const existing = records.get(input?.jobId);
    if (existing) return Object.freeze({ outcome: "duplicate", record: cloneMediaJobRecord(existing) });

    try {
      const record = createMediaJobRecord(input, validNow(now));
      records.set(record.jobId, record);
      return Object.freeze({ outcome: "created", record: cloneMediaJobRecord(record) });
    } catch (error) {
      if (error instanceof TypeError) return Object.freeze({ outcome: "invalid-state" });
      throw error;
    }
  }

  async function get(jobId: string): Promise<MediaJobRecord | null> {
    if (!safeJobId(jobId)) return null;
    const record = records.get(jobId);
    return record ? cloneMediaJobRecord(record) : null;
  }

  async function list(): Promise<readonly MediaJobRecord[]> {
    return Object.freeze(Array.from(records.values(), cloneMediaJobRecord));
  }

  async function update(
    jobId: string,
    expectedVersion: number,
    mutation: Parameters<JobRepository["update"]>[2]
  ): Promise<JobRepositoryUpdateResult> {
    if (!safeJobId(jobId)) return Object.freeze({ outcome: "not-found" });
    const current = records.get(jobId);
    if (!current) return Object.freeze({ outcome: "not-found" });
    if (!Number.isSafeInteger(expectedVersion) || current.version !== expectedVersion) {
      return Object.freeze({ outcome: "version-conflict", record: cloneMediaJobRecord(current) });
    }

    const applied = applyMediaJobMutation(current, mutation, validNow(now), terminalTtlMs);
    if (!applied.ok) {
      return Object.freeze({ outcome: "invalid-state", record: cloneMediaJobRecord(current) });
    }

    records.set(jobId, applied.record);
    return Object.freeze({ outcome: "updated", record: cloneMediaJobRecord(applied.record) });
  }

  async function requestCancellation(
    jobId: string,
    expectedVersion: number
  ): Promise<JobRepositoryCancellationResult> {
    if (!safeJobId(jobId)) return Object.freeze({ outcome: "not-found" });
    const current = records.get(jobId);
    if (!current) return Object.freeze({ outcome: "not-found" });
    if (!Number.isSafeInteger(expectedVersion) || current.version !== expectedVersion) {
      return Object.freeze({ outcome: "version-conflict", record: cloneMediaJobRecord(current) });
    }

    if (current.status !== "queued" && current.status !== "running") {
      return Object.freeze({ outcome: "unchanged", record: cloneMediaJobRecord(current) });
    }

    const applied = applyMediaJobMutation(current, { type: "cancel" }, validNow(now), terminalTtlMs);
    if (!applied.ok) {
      return Object.freeze({ outcome: "unchanged", record: cloneMediaJobRecord(current) });
    }

    records.set(jobId, applied.record);
    return Object.freeze({ outcome: "updated", record: cloneMediaJobRecord(applied.record) });
  }

  async function cleanupExpired(nowMs = validNow(now)): Promise<number> {
    if (!Number.isFinite(nowMs)) throw new TypeError("Cleanup timestamp must be finite.");
    let removed = 0;

    for (const [jobId, record] of records) {
      if (record.status === "expired") {
        records.delete(jobId);
        removed += 1;
        continue;
      }
      if (!isMediaJobTerminal(record.status) || !record.expiresAt) continue;
      const expiresAt = Date.parse(record.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt > nowMs) continue;

      const applied = applyMediaJobMutation(record, { type: "expire" }, nowMs, terminalTtlMs);
      if (!applied.ok) continue;
      records.set(jobId, applied.record);
      records.delete(jobId);
      removed += 1;
    }

    return removed;
  }

  function clearForTests(): void {
    records.clear();
  }

  return Object.freeze({ create, get, list, update, requestCancellation, cleanupExpired, clearForTests });
}
