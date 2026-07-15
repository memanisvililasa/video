import "server-only";
import { constants } from "node:fs";
import { access, statfs } from "node:fs/promises";
import path from "node:path";
import { assertDurableVolumeMarker } from "@/lib/storage/durable-volume-marker";
import type { MetricsCollector } from "@/lib/observability/collectors";
import type { OperationalSignals } from "@/lib/observability/signals";
import { safeSignalMetric } from "@/lib/observability/signals";

function safeFilesystemNumber(value: bigint): number {
  if (value < 0n) throw new TypeError("Filesystem metric is invalid.");
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

export function createStorageMetricsCollector(options: Readonly<{
  root: string;
  authorityId: string;
  signals: OperationalSignals;
  cacheTtlMs?: number;
  now?: () => number;
}>): MetricsCollector {
  if (!path.isAbsolute(options.root) || options.root.length > 1_024 || /[\u0000-\u001f\u007f]/.test(options.root)) {
    throw new TypeError("Storage metrics root is invalid.");
  }
  if (!/^[a-f0-9]{32}$/.test(options.authorityId)) {
    throw new TypeError("Storage metrics authority is invalid.");
  }
  const cacheTtlMs = options.cacheTtlMs ?? 15_000;
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 1_000 || cacheTtlMs > 60_000) {
    throw new TypeError("Storage metrics cache TTL is invalid.");
  }
  const now = options.now ?? Date.now;
  let lastCollectedAt = 0;
  let inFlight: Promise<void> | null = null;

  async function execute(): Promise<void> {
    let readable = false;
    let writable = false;
    let markerValid = false;
    try {
      await access(options.root, constants.R_OK | constants.X_OK);
      readable = true;
      markerValid = await assertDurableVolumeMarker(options.root, options.authorityId).then(() => true, () => false);
      writable = await access(options.root, constants.W_OK).then(() => true, () => false);
      const info = await statfs(options.root, { bigint: true });
      const freeBytes = safeFilesystemNumber(info.bavail * info.bsize);
      const freeInodes = safeFilesystemNumber(info.ffree);
      safeSignalMetric(() => options.signals.metrics.setStorageSnapshot({
        up: readable && markerValid,
        readOnly: readable && !writable,
        markerValid,
        freeBytes,
        freeInodes
      }));
    } catch {
      safeSignalMetric(() => options.signals.metrics.setStorageSnapshot({
        up: false,
        readOnly: readable && !writable,
        markerValid
      }));
    } finally {
      lastCollectedAt = now();
    }
  }

  return Object.freeze({
    name: "storage",
    collect() {
      if (lastCollectedAt > 0 && now() - lastCollectedAt < cacheTtlMs) return Promise.resolve();
      if (!inFlight) inFlight = execute().finally(() => { inFlight = null; });
      return inFlight;
    }
  });
}
