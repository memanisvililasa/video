import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { createLocalJobExecutionQueue } from "@/lib/jobs/execution-queue";
import { API_ERROR_CODES } from "@/lib/types";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flush(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

describe("local job execution queue adapter", () => {
  it("starts executions in FIFO order with bounded concurrency", async () => {
    const queue = createLocalJobExecutionQueue({ maxConcurrentJobs: 1, maxQueuedJobs: 3 });
    const starts: string[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

    for (let index = 0; index < gates.length; index += 1) {
      queue.enqueue({
        jobId: `job_fifo_${index}`,
        async execute() {
          starts.push(`job_fifo_${index}`);
          await gates[index].promise;
        }
      });
    }

    await flush();
    expect(starts).toEqual(["job_fifo_0"]);
    expect(queue.getStats()).toMatchObject({ runningJobs: 1, queuedJobs: 2 });
    gates[0].resolve();
    await flush();
    expect(starts).toEqual(["job_fifo_0", "job_fifo_1"]);
    gates[1].resolve();
    await flush();
    expect(starts).toEqual(["job_fifo_0", "job_fifo_1", "job_fifo_2"]);
    gates[2].resolve();
    await flush();
  });

  it("removes a queued execution without running its handler", async () => {
    const queue = createLocalJobExecutionQueue({ maxConcurrentJobs: 1 });
    const running = deferred<void>();
    const queuedHandler = vi.fn();
    const discard = vi.fn();
    queue.enqueue({ jobId: "job_running", execute: () => running.promise });
    queue.enqueue({
      jobId: "job_queued",
      execute: queuedHandler,
      onCancelledBeforeStart: discard
    });
    await flush();

    expect(await queue.cancel("job_queued")).toBe("queued");
    expect(queuedHandler).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
    running.resolve();
    await flush();
  });

  it("aborts a running execution and waits for settlement", async () => {
    const queue = createLocalJobExecutionQueue();
    let signal: AbortSignal | undefined;
    queue.enqueue({
      jobId: "job_abort",
      execute(receivedSignal) {
        signal = receivedSignal;
        return new Promise<void>((resolve) => {
          receivedSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    });
    await flush();

    expect(await queue.cancel("job_abort")).toBe("running");
    expect(signal?.aborted).toBe(true);
    expect(queue.getStats()).toMatchObject({ runningJobs: 0, queuedJobs: 0, totalExecutions: 0 });
  });

  it("continues after one execution rejects without an unhandled rejection", async () => {
    const queue = createLocalJobExecutionQueue({ maxConcurrentJobs: 1 });
    const second = vi.fn();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      queue.enqueue({ jobId: "job_failure", execute: () => Promise.reject(new Error("handled")) });
      queue.enqueue({ jobId: "job_after_failure", execute: second });
      await flush(30);
      expect(second).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("enforces waiting capacity and reports a safe queue-full error", async () => {
    const queue = createLocalJobExecutionQueue({ maxConcurrentJobs: 1, maxQueuedJobs: 1 });
    const running = deferred<void>();
    queue.enqueue({ jobId: "job_capacity_running", execute: () => running.promise });
    await flush();
    queue.enqueue({ jobId: "job_capacity_queued", execute: () => undefined });

    expect(() =>
      queue.enqueue({ jobId: "job_capacity_overflow", execute: () => undefined })
    ).toThrowError(new AppError(API_ERROR_CODES.QUEUE_FULL));
    running.resolve();
    await flush();
  });

  it("contains only scheduling operations and keeps isolated instances independent", async () => {
    const first = createLocalJobExecutionQueue();
    const second = createLocalJobExecutionQueue();
    const gate = deferred<void>();
    first.enqueue({ jobId: "job_isolated", execute: () => gate.promise });
    await flush();

    expect(first).not.toHaveProperty("getJob");
    expect(first).not.toHaveProperty("listJobs");
    expect(first).not.toHaveProperty("updateProgress");
    expect(first.getStats().totalExecutions).toBe(1);
    expect(second.getStats().totalExecutions).toBe(0);
    expect(await second.cancel("job_isolated")).toBe("not-found");
    gate.resolve();
    await flush();
  });
});
