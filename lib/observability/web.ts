import "server-only";
import { parseApplicationProcessRole } from "@/lib/config/env";
import { createHttpObservability } from "@/lib/observability/http-observer";
import { createReadinessProbe, type ReadinessProbe } from "@/lib/observability/readiness-probe";
import {
  createProcessObservability,
  installProcessLifecycleLogging,
  type ProcessObservability
} from "@/lib/observability/runtime";
import { resolveWebApiRuntime } from "@/lib/web/runtime-resolver";

let processRuntime: Promise<ProcessObservability> | null = null;
let processProbe: Promise<ReadinessProbe> | null = null;
let removeLifecycleHooks: (() => void) | null = null;

export function getWebObservability(
  source: Readonly<Record<string, string | undefined>> = process.env
): Promise<ProcessObservability> {
  if (!processRuntime) {
    processRuntime = Promise.resolve().then(() => {
      const role = parseApplicationProcessRole(source);
      if (role !== "web" && role !== "local") throw new TypeError("Web observability requires the web or local role.");
      return createProcessObservability(source, role);
    });
  }
  return processRuntime;
}

export async function getWebReadinessProbe(): Promise<ReadinessProbe> {
  if (!processProbe) {
    processProbe = getWebObservability().then((observability) => createReadinessProbe({
      check: async () => (await resolveWebApiRuntime()).readiness(),
      timeoutMs: observability.config.readinessTimeoutMs,
      metrics: observability.metrics,
      logger: observability.logger
    }));
  }
  return processProbe;
}

export async function startWebProcessObservability(): Promise<void> {
  const runtime = await getWebObservability();
  if (!removeLifecycleHooks) removeLifecycleHooks = installProcessLifecycleLogging(runtime);
}

export async function closeWebProcessObservability(): Promise<void> {
  removeLifecycleHooks?.();
  removeLifecycleHooks = null;
  const pending = processRuntime;
  processRuntime = null;
  processProbe = null;
  const runtime = await pending?.catch(() => null);
  runtime?.close();
}

export const webHttpObservability = createHttpObservability({ get: () => getWebObservability() });
