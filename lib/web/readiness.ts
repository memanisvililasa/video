import "server-only";
import { createProductionWebRuntime } from "@/lib/web/production-runtime";

export async function runProductionWebReadiness(
  source: Readonly<Record<string, string | undefined>>,
  options: Readonly<{ postgresSchema?: string }> = {}
): Promise<void> {
  const runtime = createProductionWebRuntime(source, {
    postgresSchema: options.postgresSchema
  });
  try {
    if (runtime.role !== "web" || runtime.authority !== "postgres") {
      throw new Error("Production web runtime authority is invalid.");
    }
    await runtime.readiness();
  } finally {
    await runtime.close().catch(() => undefined);
  }
}
