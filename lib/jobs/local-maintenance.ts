export type LocalMaintenanceLifecycle = Readonly<{
  start(): Promise<void>;
  close(): Promise<void>;
}>;

export type CreateLocalMaintenanceLifecycleOptions = Readonly<{
  maintenance: () => Promise<void>;
  intervalMs: number;
  schedule?: typeof setInterval;
  clear?: typeof clearInterval;
}>;

export function createLocalMaintenanceLifecycle(
  options: CreateLocalMaintenanceLifecycleOptions
): LocalMaintenanceLifecycle {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1_000) {
    throw new TypeError("Local maintenance interval must be at least one second.");
  }
  const schedule = options.schedule ?? setInterval;
  const clear = options.clear ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let started = false;
  let closed = false;

  function run(): Promise<void> {
    if (closed) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(options.maintenance)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  async function start(): Promise<void> {
    if (closed) throw new Error("Local maintenance lifecycle is closed.");
    if (started) return;
    started = true;
    await run();
    timer = schedule(() => {
      void run().catch(() => undefined);
    }, options.intervalMs);
    timer.unref?.();
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (timer) clear(timer);
    timer = null;
    await inFlight?.catch(() => undefined);
  }

  return Object.freeze({ start, close });
}
