import "server-only";
import type { CoreMetrics } from "@/lib/observability/core-metrics";
import type { OperationalLogger } from "@/lib/observability/logger";
import { classifyError } from "@/lib/observability/redaction";

export type ReadinessResult = Readonly<{
  ready: boolean;
  reasonCategory: "none" | "configuration" | "database" | "storage" | "timeout" | "internal";
}>;

export type ReadinessProbe = Readonly<{
  check(): Promise<ReadinessResult>;
}>;

export function createReadinessProbe(options: Readonly<{
  check: () => Promise<void>;
  timeoutMs: number;
  metrics: CoreMetrics;
  logger: OperationalLogger;
}>): ReadinessProbe {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30_000) {
    throw new TypeError("Readiness timeout is invalid.");
  }
  let inFlight: Promise<ReadinessResult> | null = null;
  let lastReady: boolean | null = null;

  async function execute(dependencyCheck: Promise<void>): Promise<ReadinessResult> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        dependencyCheck,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error("readiness timeout");
            error.name = "TimeoutError";
            reject(error);
          }, options.timeoutMs);
        })
      ]);
      options.metrics.setReadiness(true);
      if (lastReady !== true) {
        options.logger.info("db.connected", { outcome: "success", reasonCode: "none" });
      }
      lastReady = true;
      return Object.freeze({ ready: true, reasonCategory: "none" as const });
    } catch (error) {
      const classified = classifyError(error);
      const reasonCategory = classified.category === "network"
        ? "database"
        : classified.category === "validation"
          ? "configuration"
          : classified.category === "migration"
            ? "configuration"
          : classified.category === "database" || classified.category === "storage" || classified.category === "configuration" || classified.category === "timeout"
            ? classified.category
            : "internal";
      options.metrics.setReadiness(false);
      if (lastReady !== false) {
        options.logger.warn("process.not_ready", {
          outcome: "failure",
          reasonCode: classified.reasonCode === "readiness_timeout" ? "readiness_timeout" : "readiness_failed",
          errorCategory: classified.category
        });
        if (classified.category === "database" || classified.category === "network") {
          options.logger.warn("db.unavailable", {
            outcome: "failure",
            reasonCode: "database_unavailable",
            errorCategory: "database"
          });
        }
        if (classified.category === "migration") {
          options.logger.error("migration.mismatch", {
            outcome: "failure",
            reasonCode: "schema_mismatch",
            errorCategory: "migration"
          });
        }
      }
      lastReady = false;
      return Object.freeze({ ready: false, reasonCategory });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return Object.freeze({
    check() {
      if (!inFlight) {
        const dependencyCheck = Promise.resolve().then(options.check);
        const result = execute(dependencyCheck);
        inFlight = result;
        void dependencyCheck.finally(() => {
          if (inFlight === result) inFlight = null;
        }).catch(() => undefined);
      }
      return inFlight;
    }
  });
}
