import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createHttpObservability } from "@/lib/observability/http-observer";
import type { OperationalLogRecord } from "@/lib/observability/logger";
import { currentRequestContext } from "@/lib/observability/request-context";
import { createProcessObservability } from "@/lib/observability/runtime";

async function harness() {
  const records: OperationalLogRecord[] = [];
  const runtime = await createProcessObservability(
    { NODE_ENV: "test", OBSERVABILITY_LOG_LEVEL: "debug" },
    "web",
    {
      metadata: { processInstanceId: () => "1".repeat(32) },
      logger: { sink(record) { records.push(record); } },
      now: () => 1_000
    }
  );
  let clock = 0;
  const observer = createHttpObservability({ get: async () => runtime, now: () => ++clock });
  return { runtime, observer, records };
}

describe("HTTP request observation", () => {
  it("correlates a canonical request ID without using it as a metric label", async () => {
    const { runtime, observer, records } = await harness();
    const requestId = "a".repeat(32);
    const response = await observer.run(
      new NextRequest("http://localhost/api/download?secret=value", {
        method: "POST",
        headers: { "x-request-id": requestId }
      }),
      "job_submit",
      "POST",
      async (context) => {
        expect(context.requestId).toBe(requestId);
        expect(currentRequestContext()).toMatchObject({ requestId, route: "job_submit", method: "POST" });
        context.log("info", "job.submit.accepted", {
          publicJobId: "job_0123456789abcdef",
          outcome: "success",
          reasonCode: "none"
        });
        return new Response(null, { status: 202 });
      }
    );
    expect(response.status).toBe(202);
    expect(currentRequestContext()).toBeUndefined();
    expect(records.map((record) => record.event)).toEqual(["job.submit.accepted", "http.request.completed"]);
    expect(records.every((record) => record.requestId === requestId)).toBe(true);
    const metrics = runtime.metrics.registry.render();
    expect(metrics).not.toContain(requestId);
    expect(metrics).not.toContain("secret=value");
  });

  it("isolates concurrent requests and clears in-flight after an exception", async () => {
    const { runtime, observer, records } = await harness();
    const seen = await Promise.all([
      observer.run(
        new NextRequest("http://localhost/api/jobs/job_1", { headers: { "x-request-id": "1".repeat(32) } }),
        "job_status",
        "GET",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return new Response(null, { status: 200, headers: { "x-test-context": currentRequestContext()?.requestId ?? "" } });
        }
      ),
      observer.run(
        new NextRequest("http://localhost/api/jobs/job_2", { headers: { "x-request-id": "2".repeat(32) } }),
        "job_status",
        "GET",
        async () => new Response(null, { status: 404, headers: { "x-test-context": currentRequestContext()?.requestId ?? "" } })
      )
    ]);
    expect(seen.map((response) => response.headers.get("x-test-context"))).toEqual(["1".repeat(32), "2".repeat(32)]);

    await expect(observer.run(
      new NextRequest("http://localhost/api/download", { method: "POST" }),
      "job_submit",
      "POST",
      async () => { throw new Error("private failure"); }
    )).rejects.toThrow("private failure");
    const metrics = runtime.metrics.registry.render();
    expect(metrics).toContain('http_in_flight{route="job_submit"} 0');
    expect(JSON.stringify(records)).not.toContain("private failure");
  });
});
