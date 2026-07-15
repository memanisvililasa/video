import "server-only";

export type MetricsCollector = Readonly<{
  name: string;
  collect(): Promise<void>;
}>;

export type MetricsCollectorCoordinator = Readonly<{
  add(collector: MetricsCollector): () => void;
  collect(): Promise<void>;
  close(): void;
}>;

const COLLECTOR_NAME = /^[a-z][a-z0-9_-]{0,47}$/;

export function createMetricsCollectorCoordinator(options: Readonly<{
  timeoutMs?: number;
  maximumCollectors?: number;
}> = {}): MetricsCollectorCoordinator {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const maximumCollectors = options.maximumCollectors ?? 8;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new TypeError("Metrics collection timeout is invalid.");
  }
  if (!Number.isSafeInteger(maximumCollectors) || maximumCollectors < 1 || maximumCollectors > 16) {
    throw new TypeError("Metrics collector limit is invalid.");
  }
  const collectors = new Map<string, MetricsCollector>();
  let inFlight: Promise<void> | null = null;
  let closed = false;

  function add(collector: MetricsCollector): () => void {
    if (closed) throw new TypeError("Metrics collectors are closed.");
    if (!collector || !COLLECTOR_NAME.test(collector.name) || typeof collector.collect !== "function") {
      throw new TypeError("Metrics collector is invalid.");
    }
    if (collectors.size >= maximumCollectors || collectors.has(collector.name)) {
      throw new TypeError("Metrics collector registration is invalid.");
    }
    collectors.set(collector.name, collector);
    return () => { collectors.delete(collector.name); };
  }

  async function execute(): Promise<void> {
    const tasks = [...collectors.values()].map(async (collector) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          Promise.resolve().then(() => collector.collect()),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })
        ]);
      } catch {
        // Each collector publishes its own bounded failure gauges.
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    await Promise.all(tasks);
  }

  return Object.freeze({
    add,
    collect() {
      if (closed) return Promise.resolve();
      if (!inFlight) {
        inFlight = execute().finally(() => { inFlight = null; });
      }
      return inFlight;
    },
    close() {
      closed = true;
      collectors.clear();
    }
  });
}
