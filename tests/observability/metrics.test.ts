import { describe, expect, it } from "vitest";
import type { ProcessMetadata } from "@/lib/observability/contract";
import { createCoreMetrics } from "@/lib/observability/core-metrics";
import { MetricsRegistry } from "@/lib/observability/metrics";

const metadata: ProcessMetadata = {
  schemaVersion: "1.0",
  service: "videosave",
  processRole: "web",
  processInstanceId: "1".repeat(32),
  releaseCommit: "a".repeat(40),
  releaseId: "videosave-test",
  releaseCategory: "test"
};

describe("bounded metrics registry", () => {
  it("renders deterministic Prometheus text with HELP and TYPE", () => {
    const registry = new MetricsRegistry();
    const counter = registry.registerCounter("example_total", "Example counter.", { outcome: (value) => value === "ok" });
    counter.inc({ outcome: "ok" }, 2);
    const gauge = registry.registerGauge("example_up", "Example gauge.");
    gauge.set(undefined, 1);
    expect(registry.render()).toBe([
      "# HELP example_total Example counter.",
      "# TYPE example_total counter",
      "example_total{outcome=\"ok\"} 2",
      "# HELP example_up Example gauge.",
      "# TYPE example_up gauge",
      "example_up 1",
      ""
    ].join("\n"));
  });

  it("rejects unknown/high-cardinality labels, invalid numbers, and duplicate registration", () => {
    const registry = new MetricsRegistry();
    const counter = registry.registerCounter("requests_total", "Requests.", { route: (value) => value === "fixed" });
    expect(() => counter.inc({ route: "job_0123456789" })).toThrow(/allowlist/);
    expect(() => counter.inc({ route: "fixed", requestId: "a".repeat(32) })).toThrow(/labels/);
    expect(() => counter.inc({ route: "fixed" }, -1)).toThrow(/non-negative/);
    const gauge = registry.registerGauge("finite_value", "Finite.");
    expect(() => gauge.set(undefined, Number.NaN)).toThrow(/finite/);
    expect(() => gauge.set(undefined, Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => registry.registerGauge("requests_total", "Duplicate.")).toThrow(/already/);
  });

  it("renders fixed cumulative histogram buckets", () => {
    const registry = new MetricsRegistry();
    const histogram = registry.registerHistogram("duration_seconds", "Duration.", {}, [0.1, 1]);
    histogram.observe(undefined, 0.05);
    histogram.observe(undefined, 0.5);
    const output = registry.render();
    expect(output).toContain('duration_seconds_bucket{le="0.1"} 1');
    expect(output).toContain('duration_seconds_bucket{le="1"} 2');
    expect(output).toContain('duration_seconds_bucket{le="+Inf"} 2');
    expect(output).toContain("duration_seconds_count 2");
  });

  it("keeps core HTTP labels bounded and decrements in-flight after completion", () => {
    const metrics = createCoreMetrics(metadata, { now: () => 1_000 });
    metrics.requestStarted("job_submit");
    metrics.requestFinished({
      route: "job_submit",
      method: "POST",
      outcome: "success",
      statusClass: "2xx",
      durationSeconds: 0.025
    });
    const output = metrics.registry.render();
    expect(output).toContain('http_in_flight{route="job_submit"} 0');
    expect(output).toContain('http_requests_total{method="POST",outcome="success",route="job_submit"} 1');
    expect(output).not.toContain("requestId");
    expect(output).not.toContain("job_0123456789abcdef");
  });

  it("enforces a bounded response", () => {
    const registry = new MetricsRegistry(4_096);
    for (let index = 0; index < 40; index += 1) {
      const metric = registry.registerGauge(`bounded_metric_${index}`, "x".repeat(200));
      metric.set(undefined, 1);
    }
    expect(() => registry.render()).toThrow(/bound/);
  });
});
