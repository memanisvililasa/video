import "server-only";
import {
  HTTP_METHODS,
  HTTP_ROUTES,
  OUTCOMES,
  PROCESS_ROLES,
  type HttpStatusClass,
  type ObservedHttpMethod,
  type ObservedHttpRoute,
  type OperationalOutcome,
  type ProcessMetadata
} from "@/lib/observability/contract";
import { MetricsRegistry } from "@/lib/observability/metrics";

const DURATION_BUCKETS_SECONDS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
const allow = (values: readonly string[]) => (value: string): boolean => values.includes(value);

export type CoreMetrics = Readonly<{
  registry: MetricsRegistry;
  setProcessUp(up: boolean): void;
  setReadiness(ready: boolean): void;
  requestStarted(route: ObservedHttpRoute): void;
  requestFinished(input: Readonly<{
    route: ObservedHttpRoute;
    method: ObservedHttpMethod;
    outcome: OperationalOutcome;
    statusClass: HttpStatusClass;
    durationSeconds: number;
  }>): void;
}>;

export function createCoreMetrics(
  metadata: ProcessMetadata,
  options: Readonly<{ maxResponseBytes?: number; now?: () => number }> = {}
): CoreMetrics {
  const registry = new MetricsRegistry(options.maxResponseBytes);
  const role = { role: metadata.processRole };
  const routeLabels = { route: allow(HTTP_ROUTES) };
  const routeMethodLabels = { route: allow(HTTP_ROUTES), method: allow(HTTP_METHODS) };
  const processStart = registry.registerGauge("process_start_time_seconds", "Process start time as Unix seconds.");
  const processUp = registry.registerGauge("process_up", "Whether the process runtime is up.");
  const readiness = registry.registerGauge("readiness_status", "Whether the process dependency readiness check succeeds.", {
    role: allow(PROCESS_ROLES)
  });
  const build = registry.registerGauge("build_info", "Bounded build category information.", {
    role: allow(PROCESS_ROLES),
    releaseCategory: allow(["local", "test", "production"])
  });
  const requests = registry.registerCounter("http_requests_total", "Completed HTTP requests.", {
    ...routeMethodLabels,
    outcome: allow(OUTCOMES)
  });
  const duration = registry.registerHistogram(
    "http_request_duration_seconds",
    "HTTP handler duration in seconds.",
    routeMethodLabels,
    DURATION_BUCKETS_SECONDS
  );
  const inFlight = registry.registerGauge("http_in_flight", "HTTP handlers currently in flight.", routeLabels);
  const responses = registry.registerCounter("http_responses_total", "HTTP responses by bounded status class.", {
    ...routeMethodLabels,
    statusClass: allow(["1xx", "2xx", "3xx", "4xx", "5xx"])
  });

  processStart.set(undefined, (options.now ?? (() => Date.now()))() / 1_000);
  processUp.set(undefined, 1);
  readiness.set(role, 0);
  build.set({ role: metadata.processRole, releaseCategory: metadata.releaseCategory }, 1);

  return Object.freeze({
    registry,
    setProcessUp(up) { try { processUp.set(undefined, up ? 1 : 0); } catch {} },
    setReadiness(ready) { try { readiness.set(role, ready ? 1 : 0); } catch {} },
    requestStarted(route) { try { inFlight.inc({ route }); } catch {} },
    requestFinished(input) {
      try {
        const routeMethod = { route: input.route, method: input.method };
        inFlight.dec({ route: input.route });
        requests.inc({ ...routeMethod, outcome: input.outcome });
        responses.inc({ ...routeMethod, statusClass: input.statusClass });
        duration.observe(routeMethod, input.durationSeconds);
      } catch {
        // Metrics must never become request authority.
      }
    }
  });
}
