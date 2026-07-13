import "server-only";
import { createProductionMediaWorkerRuntime } from "@/lib/worker/composition";
import { createStructuredWorkerLogger } from "@/lib/worker/logger";

export async function runMediaWorkerMain(
  argv: readonly string[] = process.argv.slice(2),
  source: Readonly<Record<string, string | undefined>> = process.env
): Promise<number> {
  if (argv.length > 1 || (argv[0] !== undefined && argv[0] !== "--check")) {
    console.error("Media worker startup failed: unsupported arguments.");
    return 1;
  }
  const checkOnly = argv[0] === "--check";
  const logger = createStructuredWorkerLogger();
  let runtime: ReturnType<typeof createProductionMediaWorkerRuntime> | null = null;
  let fatal = false;
  let signalCount = 0;
  try {
    runtime = createProductionMediaWorkerRuntime(source, { logger });
    await runtime.readiness();
    if (checkOnly) {
      logger.info("worker.readiness.ok");
      return 0;
    }

    await runtime.startup();

    const requestShutdown = (reason: string, force = false): void => {
      if (!runtime) return;
      logger.warn("worker.shutdown.requested", { reason, force });
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
    logger.info("worker.ready", { concurrency: runtime.config.workerConcurrency });
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
  } catch {
    console.error("Media worker startup failed.");
    return 1;
  } finally {
    await runtime?.close().catch(() => undefined);
  }
}
