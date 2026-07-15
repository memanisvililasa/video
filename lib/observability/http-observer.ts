import "server-only";
import type { NextRequest } from "next/server";
import {
  statusClass,
  type ObservedHttpMethod,
  type ObservedHttpRoute,
  type OperationalEvent,
  type OperationalLogLevel,
  type OperationalOutcome
} from "@/lib/observability/contract";
import type { OperationalLogFields } from "@/lib/observability/logger";
import type { ProcessObservability } from "@/lib/observability/runtime";
import { runWithPublicJobId, runWithRequestContext } from "@/lib/observability/request-context";
import { resolveRequestId, type RequestIdGenerator } from "@/lib/observability/request-id";

export type HttpObservationContext = Readonly<{
  requestId: string;
  log(level: OperationalLogLevel, event: OperationalEvent, fields?: OperationalLogFields): void;
  withPublicJobId<T>(publicJobId: string, operation: () => T): T;
}>;

export type HttpObservability = Readonly<{
  run<T extends Response>(
    request: NextRequest,
    route: ObservedHttpRoute,
    method: ObservedHttpMethod,
    operation: (context: HttpObservationContext) => Promise<T>
  ): Promise<T>;
}>;

export function createHttpObservability(options: Readonly<{
  get: () => Promise<ProcessObservability>;
  requestIdGenerator?: RequestIdGenerator;
  now?: () => number;
}>): HttpObservability {
  const now = options.now ?? (() => performance.now());
  const outcomeForStatus = (code: number): OperationalOutcome =>
    code < 400 ? "success" : code < 500 ? "rejected" : "failure";
  return Object.freeze({
    async run(request, route, method, operation) {
      const runtime = await options.get();
      const { requestId } = resolveRequestId(request.headers, options.requestIdGenerator);
      const startedAt = now();
      runtime.metrics.requestStarted(route);
      let statusCode = 500;
      try {
        return await runWithRequestContext({ requestId, route, method }, async () => {
          const context: HttpObservationContext = Object.freeze({
            requestId,
            log(level, event, fields = {}) {
              runtime.logger.log(level, event, { ...fields, requestId, route, method });
            },
            withPublicJobId(publicJobId, nested) {
              return runWithPublicJobId(publicJobId, nested);
            }
          });
          const response = await operation(context);
          statusCode = response.status;
          return response;
        });
      } finally {
        const elapsedMs = Math.max(0, now() - startedAt);
        const outcome = outcomeForStatus(statusCode);
        runtime.metrics.requestFinished({
          route,
          method,
          outcome,
          statusClass: statusClass(statusCode),
          durationSeconds: elapsedMs / 1_000
        });
        const level = route === "job_status" && outcome === "success" ? "debug" : outcome === "failure" ? "warn" : "info";
        runtime.logger.log(level, "http.request.completed", {
          requestId,
          route,
          method,
          statusCode,
          statusClass: statusClass(statusCode),
          durationMs: elapsedMs,
          outcome,
          reasonCode: outcome === "success" ? "none" : outcome === "rejected" ? "invalid_request" : "internal_error"
        });
      }
    }
  });
}

export const NOOP_HTTP_OBSERVABILITY: HttpObservability = Object.freeze({
  async run(_request, _route, _method, operation) {
    return operation(Object.freeze({
      requestId: "0".repeat(32),
      log() {},
      withPublicJobId<T>(_publicJobId: string, nested: () => T): T { return nested(); }
    }));
  }
});
