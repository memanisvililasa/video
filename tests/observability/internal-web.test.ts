import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWebObservability: vi.fn(),
  getWebReadinessProbe: vi.fn()
}));

vi.mock("@/lib/observability/web", () => mocks);

import { handleInternalWebRequest, isInternalWebRequest } from "@/lib/observability/internal-web";

const production = Object.freeze({
  NODE_ENV: "production",
  APP_PROCESS_ROLE: "web",
  HOSTNAME: "127.0.0.1",
  PORT: "3000"
});

function request(path: string, init: Readonly<{ method?: string; headers?: HeadersInit }> = {}): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000${path}`, {
    method: init.method,
    headers: { host: "127.0.0.1:3000", ...Object.fromEntries(new Headers(init.headers)) }
  });
}

describe("internal web observability boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWebReadinessProbe.mockResolvedValue({ check: vi.fn().mockResolvedValue({ ready: true, reasonCategory: "none" }) });
    mocks.getWebObservability.mockResolvedValue({
      collectMetrics: vi.fn().mockResolvedValue(undefined),
      metrics: { registry: { render: () => "# HELP process_up Process.\n# TYPE process_up gauge\nprocess_up 1\n" } }
    });
  });

  it("keeps liveness dependency-independent and bounded", async () => {
    const response = await handleInternalWebRequest(request("/internal/observability/live"), "live", production);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "live" });
    expect(mocks.getWebReadinessProbe).not.toHaveBeenCalled();
    expect(mocks.getWebObservability).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects public Host tricks and malformed duplicate-like hosts", async () => {
    for (const host of ["video.example", "video.example,127.0.0.1:3000", "127.0.0.1:3000,video.example"] ) {
      const candidate = new NextRequest("http://127.0.0.1:3000/internal/observability/live", { headers: { host } });
      expect(isInternalWebRequest(candidate, production)).toBe(false);
      expect((await handleInternalWebRequest(candidate, "live", production)).status).toBe(404);
    }
  });

  it("reports sanitized fail-closed readiness and Prometheus content type", async () => {
    mocks.getWebReadinessProbe.mockResolvedValueOnce({
      check: vi.fn().mockResolvedValue({ ready: false, reasonCategory: "database" })
    });
    const unavailable = await handleInternalWebRequest(request("/internal/observability/ready"), "ready", production);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: "not_ready", reason: "database" });
    const metrics = await handleInternalWebRequest(request("/internal/observability/metrics"), "metrics", production);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("version=0.0.4");
    expect(await metrics.text()).toContain("process_up 1");
  });

  it("allows only GET/HEAD and rejects bodies without mutation", async () => {
    const method = await handleInternalWebRequest(request("/internal/observability/live", { method: "POST" }), "live", production);
    expect(method.status).toBe(405);
    const body = await handleInternalWebRequest(request("/internal/observability/live", {
      method: "HEAD",
      headers: { "content-length": "1" }
    }), "live", production);
    expect(body.status).toBe(400);
    expect(await body.text()).toBe("");
  });
});
