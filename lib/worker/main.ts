import "server-only";
import { parseWorkerObservabilityConfig } from "@/lib/config/env";
import { createReadinessProbe } from "@/lib/observability/readiness-probe";
import { createProcessObservability, type ProcessObservability } from "@/lib/observability/runtime";
import {
  createWorkerObservabilityListener,
  type WorkerObservabilityListener
} from "@/lib/observability/worker-listener";
import { classifyError } from "@/lib/observability/redaction";
import { createProductionMediaWorkerRuntime } from "@/lib/worker/composition";

export async function runMediaWorkerMain(
  argv: readonly string[] = process.argv.slice(2),
  source: Readonly<Record<string, string | undefined>> = process.env
): Promise<number> {
  if (argv.length > 1 || (argv[0] !== undefined && argv[0] !== "--check")) {
    console.error("Media worker startup failed: unsupported arguments.");
    return 1;
  }
  const checkOnly = argv[0] === "--check";
  let observability: ProcessObservability | null = null;
  let listener: WorkerObservabilityListener | null = null;
  let listenerBound = false;
  let runtime: ReturnType<typeof createProductionMediaWorkerRuntime> | null = null;
  let fatal = false;
  let signalCount = 0;
  let stoppingLogged = false;
  const startedAt = performance.now();
  try {
    observability = await createProcessObservability(source, "worker");
    observability.logger.info("process.starting", { outcome: "success", reasonCode: "none" });
    const listenerConfig = parseWorkerObservabilityConfig(source);
    runtime = createProductionMediaWorkerRuntime(source, { observability });
    const readiness = createReadinessProbe({
      check: runtime.readiness,
      timeoutMs: observability.config.readinessTimeoutMs,
      metrics: observability.metrics,
      logger: observability.logger
    });
    if (!checkOnly) {
      listener = createWorkerObservabilityListener({
        config: listenerConfig,
        observability,
        readiness
      });
      await listener.start();
      listenerBound = true;
    }
    const readinessResult = await readiness.check();
    if (!readinessResult.ready) throw new Error("Worker readiness failed.");
    if (checkOnly) {
      observability.logger.info("process.ready", {
        outcome: "success",
        reasonCode: "none",
        durationMs: performance.now() - startedAt
      });
      return 0;
    }

    await runtime.startup();

    const requestShutdown = (reason: string, force = false): void => {
      if (!runtime) return;
      if (!stoppingLogged) {
        stoppingLogged = true;
        observability?.logger.info("process.stopping", {
          outcome: "success",
          reasonCode: reason === "unhandled" ? "internal_error" : "none",
          metadata: { force }
        });
      }
      void listener?.close().catch(() => { fatal = true; });
      void runtime.shutdown({ force }).catch(() => {
        fatal = true;
      });
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      signalCount += 1;
      requestShutdown(signal.toLowerCase(), signalCount > 1);
    };
    const onUnhandled = (): void => {
      fatal = true;
      requestShutdown("unhandled", true);
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUnhandled);
    observability.logger.info("process.ready", {
      outcome: "success",
      reasonCode: "none",
      durationMs: performance.now() - startedAt
    });
    try {
      await runtime.run();
    } catch {
      fatal = true;
      await runtime.shutdown({ force: true });
    } finally {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      process.off("unhandledRejection", onUnhandled);
      process.off("uncaughtException", onUnhandled);
    }
    return fatal ? 1 : 0;
  } catch (error) {
    const classified = classifyError(error);
    observability?.logger.error(error instanceof TypeError ? "config.invalid" : "process.not_ready", {
      outcome: "failure",
      reasonCode: error instanceof TypeError
        ? "invalid_configuration"
        : listener && !listenerBound
          ? "listener_unavailable"
          : classified.reasonCode,
      errorCategory: classified.category === "validation" ? "configuration" : classified.category
    });
    console.error("Media worker startup failed.");
    return 1;
  } finally {
    if (observability && !stoppingLogged) {
      stoppingLogged = true;
      observability.logger.info("process.stopping", { outcome: "success", reasonCode: "none" });
    }
    await listener?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    if (observability) {
      observability.close();
      observability.logger.info("process.stopped", {
        outcome: fatal ? "failure" : "success",
        reasonCode: fatal ? "internal_error" : "none"
      });
    }
  }
}
