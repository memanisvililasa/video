import { describe, expect, it, vi } from "vitest";
import { createLocalMaintenanceLifecycle } from "@/lib/jobs/local-maintenance";

describe("local maintenance lifecycle", () => {
  it("runs startup maintenance, schedules one unref timer, and clears it on close", async () => {
    const maintenance = vi.fn(async () => undefined);
    const unref = vi.fn();
    let callback: (() => void) | undefined;
    const timer = { unref } as unknown as ReturnType<typeof setInterval>;
    const schedule = vi.fn((handler: () => void) => {
      callback = handler;
      return timer;
    }) as unknown as typeof setInterval;
    const clear = vi.fn() as unknown as typeof clearInterval;
    const lifecycle = createLocalMaintenanceLifecycle({ maintenance, intervalMs: 1_000, schedule, clear });

    await lifecycle.start();
    await lifecycle.start();
    expect(maintenance).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
    callback?.();
    await vi.waitFor(() => expect(maintenance).toHaveBeenCalledTimes(2));
    await lifecycle.close();
    expect(clear).toHaveBeenCalledWith(timer);
  });

  it("never overlaps periodic maintenance and waits for the active sweep during close", async () => {
    let finish!: () => void;
    const maintenance = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    let callback: (() => void) | undefined;
    const schedule = ((handler: () => void) => {
      callback = handler;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    const lifecycle = createLocalMaintenanceLifecycle({ maintenance, intervalMs: 1_000, schedule, clear: vi.fn() });
    const starting = lifecycle.start();
    await vi.waitFor(() => expect(maintenance).toHaveBeenCalledOnce());
    finish();
    await starting;
    callback?.();
    callback?.();
    await vi.waitFor(() => expect(maintenance).toHaveBeenCalledTimes(2));
    const closing = lifecycle.close();
    expect(maintenance).toHaveBeenCalledTimes(2);
    finish();
    await closing;
  });

  it("fails startup closed when the first sweep fails", async () => {
    const lifecycle = createLocalMaintenanceLifecycle({
      maintenance: async () => { throw new Error("maintenance failed"); },
      intervalMs: 1_000,
      schedule: vi.fn() as unknown as typeof setInterval
    });
    await expect(lifecycle.start()).rejects.toThrow("maintenance failed");
  });
});
