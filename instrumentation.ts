export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startWebProcessObservability } = await import("@/lib/observability/web");
  await startWebProcessObservability();
  const { parseApplicationProcessRole } = await import("@/lib/config/env");
  if (parseApplicationProcessRole(process.env) === "local") {
    const { resolveWebApiRuntime } = await import("@/lib/web/runtime-resolver");
    await resolveWebApiRuntime();
  }
}
