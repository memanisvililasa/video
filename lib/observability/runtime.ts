import "server-only";
import { parseObservabilityConfig, type ObservabilityConfig } from "@/lib/config/env";
import {
  createMetricsCollectorCoordinator,
  type MetricsCollector
} from "@/lib/observability/collectors";
import type { ObservedProcessRole, ProcessMetadata } from "@/lib/observability/contract";
import { createCoreMetrics, type CoreMetrics } from "@/lib/observability/core-metrics";
import {
  createOperationalLogger,
  type CreateOperationalLoggerOptions,
  type OperationalLogger
} from "@/lib/observability/logger";
import { createProcessMetadata, type CreateProcessMetadataOptions } from "@/lib/observability/metadata";
import { registerOperationalMetrics, type OperationalMetrics } from "@/lib/observability/operational-metrics";
import { createOperationalSignals, type OperationalSignals } from "@/lib/observability/signals";

export type ProcessObservability = Readonly<{
  config: ObservabilityConfig;
  metadata: ProcessMetadata;
  logger: OperationalLogger;
  metrics: CoreMetrics;
  operationalMetrics: OperationalMetrics;
  signals: OperationalSignals;
  addCollector(collector: MetricsCollector): () => void;
  collectMetrics(): Promise<void>;
  close(): void;
}>;

export type CreateProcessObservabilityOptions = Readonly<{
  metadata?: Omit<CreateProcessMetadataOptions, "source" | "role">;
  logger?: Omit<CreateOperationalLoggerOptions, "metadata" | "level">;
  now?: () => number;
}>;

export async function createProcessObservability(
  source: Readonly<Record<string, string | undefined>>,
  role: ObservedProcessRole,
  options: CreateProcessObservabilityOptions = {}
): Promise<ProcessObservability> {
  const config = parseObservabilityConfig(source);
  const metadata = await createProcessMetadata({ ...options.metadata, source, role });
  const logger = createOperationalLogger({
    ...options.logger,
    metadata,
    level: config.logLevel
  });
  const metrics = createCoreMetrics(metadata, {
    maxResponseBytes: config.metricsResponseMaxBytes,
    now: options.now
  });
  const operationalMetrics = registerOperationalMetrics(metrics, metadata.processRole);
  const signals = createOperationalSignals(logger, operationalMetrics);
  const collectors = createMetricsCollectorCoordinator({
    timeoutMs: Math.min(config.readinessTimeoutMs, 2_000)
  });
  let closed = false;
  return Object.freeze({
    config,
    metadata,
    logger,
    metrics,
    operationalMetrics,
    signals,
    addCollector: collectors.add,
    collectMetrics: collectors.collect,
    close() {
      if (closed) return;
      closed = true;
      collectors.close();
      metrics.setProcessUp(false);
    }
  });
}

export function installProcessLifecycleLogging(
  observability: ProcessObservability,
  target: NodeJS.Process = process
): () => void {
  let stopping = false;
  let stopped = false;
  const startedAt = performance.now();
  observability.logger.info("process.starting", { outcome: "success", reasonCode: "none" });

  const onSignal = (): void => {
    if (stopping) return;
    stopping = true;
    observability.logger.info("process.stopping", { outcome: "success", reasonCode: "none" });
  };
  const onExit = (): void => {
    if (stopped) return;
    stopped = true;
    observability.close();
    observability.logger.info("process.stopped", { outcome: "success", reasonCode: "none" });
  };
  target.on("SIGTERM", onSignal);
  target.on("SIGINT", onSignal);
  target.on("exit", onExit);
  observability.logger.info("process.ready", {
    outcome: "success",
    reasonCode: "none",
    durationMs: performance.now() - startedAt
  });

  return () => {
    target.off("SIGTERM", onSignal);
    target.off("SIGINT", onSignal);
    target.off("exit", onExit);
  };
}
