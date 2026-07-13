import { describe, expect, it, vi } from "vitest";
import type { OwnedJobLeaseSession } from "@/lib/worker/lease-session";
import { createWorkerProgressReporter } from "@/lib/worker/progress";

describe("worker progress reporter", () => {
  it("coalesces progress, remains monotonic on retries and never writes 100", async () => {
    vi.useFakeTimers();
    const writes: number[] = [];
    const session = {
      signal: new AbortController().signal,
      terminal: () => false,
      updateProgress: async (value: number) => { writes.push(value); }
    } as unknown as OwnedJobLeaseSession;
    const progress = createWorkerProgressReporter({ session, initialProgress: 55, intervalMs: 1000 });
    progress.report(20);
    progress.report(56.2);
    progress.report(70.9);
    progress.report(100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([99]);
    await progress.stop();
    vi.useRealTimers();
  });
});
