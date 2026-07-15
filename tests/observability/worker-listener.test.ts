import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { parseWorkerObservabilityConfig } from "@/lib/config/env";
import { createProcessObservability } from "@/lib/observability/runtime";
import { createWorkerObservabilityListener } from "@/lib/observability/worker-listener";

async function get(port: number, path: string, options: { method?: string; host?: string; contentLength?: string; oversizedHeader?: boolean } = {}) {
  return new Promise<{ status: number; body: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: options.method ?? "GET",
      headers: {
        Host: options.host ?? `127.0.0.1:${port}`,
        ...(options.contentLength ? { "Content-Length": options.contentLength } : {}),
        ...(options.oversizedHeader ? { "X-Oversized": "x".repeat(9 * 1024) } : {})
      },
      timeout: 2_000
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }));
    });
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.end();
  });
}

describe("worker loopback observability listener", () => {
  it("serves dependency-free liveness, readiness, and core metrics then closes cleanly", async () => {
    const observability = await createProcessObservability(
      { NODE_ENV: "test" },
      "worker",
      { metadata: { processInstanceId: () => "1".repeat(32) }, logger: { sink() {} } }
    );
    const readinessCheck = vi.fn().mockResolvedValue({ ready: false, reasonCategory: "database" });
    const listener = createWorkerObservabilityListener({
      config: parseWorkerObservabilityConfig({ NODE_ENV: "test" }),
      observability,
      readiness: { check: readinessCheck }
    });
    const address = await listener.start();
    expect(address.host).toBe("127.0.0.1");
    expect(address.port).toBeGreaterThan(0);

    const live = await get(address.port, "/internal/observability/live");
    expect(live.status).toBe(200);
    expect(JSON.parse(live.body)).toEqual({ status: "live" });
    expect(readinessCheck).not.toHaveBeenCalled();

    const ready = await get(address.port, "/internal/observability/ready");
    expect(ready.status).toBe(503);
    expect(JSON.parse(ready.body)).toEqual({ status: "not_ready", reason: "database" });
    const metrics = await get(address.port, "/internal/observability/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.headers["content-type"]).toContain("version=0.0.4");
    expect(metrics.body).toContain("process_up 1");

    expect((await get(address.port, "/unknown")).status).toBe(404);
    expect((await get(address.port, "/internal/observability/live", { method: "POST" })).status).toBe(405);
    expect((await get(address.port, "/internal/observability/live", { contentLength: "1" })).status).toBe(400);
    expect((await get(address.port, "/internal/observability/live", { host: "public.example" })).status).toBe(404);
    expect((await get(address.port, "/internal/observability/live?probe=1")).status).toBe(404);
    expect((await get(address.port, "/internal/observability/live", { oversizedHeader: true })).status).toBe(431);

    await listener.close();
    expect(listener.address()).toBeNull();
    await expect(get(address.port, "/internal/observability/live")).rejects.toBeDefined();
  });
});
