export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startWebProcessObservability } = await import("@/lib/observability/web");
  await startWebProcessObservability();
}
