import "server-only";
import {
  WorkerDatabaseTransportError,
  type OwnedJobLeaseSession
} from "@/lib/worker/lease-session";

export type WorkerProgressReporter = Readonly<{
  report(value: number): void;
  flush(value?: number): Promise<void>;
  stop(options?: Readonly<{ flush?: boolean }>): Promise<void>;
}>;

export function createWorkerProgressReporter(options: Readonly<{
  session: OwnedJobLeaseSession;
  initialProgress: number;
  intervalMs: number;
}>): WorkerProgressReporter {
  if (!Number.isFinite(options.initialProgress) || options.initialProgress < 0 || options.initialProgress > 100) {
    throw new TypeError("Worker initial progress is invalid.");
  }
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
    throw new TypeError("Worker progress interval is invalid.");
  }
  let lastWritten = Math.floor(options.initialProgress);
  let desired = lastWritten;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let flushTail: Promise<void> = Promise.resolve();

  function normalize(value: number): number | null {
    if (!Number.isFinite(value)) return null;
    return Math.min(99, Math.max(lastWritten, Math.floor(value)));
  }

  function schedule(): void {
    if (stopped || timer || desired <= lastWritten) return;
    timer = setTimeout(() => {
      timer = null;
      void flush().catch(() => undefined);
    }, options.intervalMs);
  }

  function report(value: number): void {
    if (stopped) return;
    const normalized = normalize(value);
    if (normalized === null || normalized <= desired) return;
    desired = normalized;
    schedule();
  }

  function flush(value?: number): Promise<void> {
    if (value !== undefined) {
      const normalized = normalize(value);
      if (normalized !== null && normalized > desired) desired = normalized;
    }
    if (timer) clearTimeout(timer);
    timer = null;
    const next = flushTail.then(async () => {
      if (desired <= lastWritten || options.session.signal.aborted || options.session.terminal()) return;
      const target = desired;
      try {
        await options.session.updateProgress(target);
        lastWritten = target;
      } catch (error) {
        if (!(error instanceof WorkerDatabaseTransportError)) throw error;
        // Keep the high-water mark coalesced in memory. Heartbeat owns the
        // bounded DB-loss budget and will either recover or abort the attempt.
      }
      if (desired > lastWritten) schedule();
    });
    flushTail = next.catch(() => undefined);
    return next;
  }

  async function stop(stopOptions: Readonly<{ flush?: boolean }> = {}): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopOptions.flush && !options.session.signal.aborted && !options.session.terminal()) {
      await flush().catch(() => undefined);
    }
    stopped = true;
    await flushTail;
  }

  return Object.freeze({ report, flush, stop });
}
