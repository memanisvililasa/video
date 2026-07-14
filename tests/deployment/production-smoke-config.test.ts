import { describe, expect, it, vi } from "vitest";
import {
  runControlledEgressSmoke,
  validateControlledEgressConfig
} from "@/lib/smoke/production-smoke";

const valid = {
  baseUrl: "http://127.0.0.1:3000",
  sourceUrl: "https://fixture.example.invalid/small.mp4",
  allowedHostname: "fixture.example.invalid",
  timeoutMs: 30_000,
  maxBytes: 1_048_576
};

describe("controlled-egress smoke configuration", () => {
  it("accepts only an explicit HTTPS source on the exact allowlisted hostname", () => {
    expect(validateControlledEgressConfig(valid)).toEqual(valid);
  });

  it.each([
    { sourceUrl: "http://fixture.example.invalid/small.mp4" },
    { sourceUrl: "https://user:secret@fixture.example.invalid/small.mp4" },
    { sourceUrl: "https://other.example.invalid/small.mp4" },
    { sourceUrl: "https://fixture.example.invalid/small.mp4?token=secret" },
    { sourceUrl: "https://fixture.example.invalid/small.mp4#fragment" },
    { sourceUrl: "https://fixture.example.invalid:8443/small.mp4" },
    { sourceUrl: "https://fixture.example.invalid/file.txt" },
    { allowedHostname: "*.example.invalid" },
    { baseUrl: "file:///tmp/origin" }
  ])("rejects unsafe configuration %#", (override) => {
    expect(() => validateControlledEgressConfig({ ...valid, ...override })).toThrow(TypeError);
  });

  it("validates configuration without any network request", () => {
    const network = vi.fn();
    expect(validateControlledEgressConfig({ ...valid, fetchImplementation: network } as never))
      .toMatchObject({ allowedHostname: "fixture.example.invalid" });
    expect(network).not.toHaveBeenCalled();
  });

  it("never sends cookies, authorization, or caller-defined headers", async () => {
    const requests: RequestInit[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      if (requests.length === 1) {
        return new Response(JSON.stringify({ ok: true, data: { status: "ok" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (requests.length === 2) {
        return new Response(JSON.stringify({ ok: true, data: { jobId: `job_${"a".repeat(32)}` } }), {
          status: 202,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (requests.length === 3) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            jobId: `job_${"a".repeat(32)}`,
            status: "failed",
            progress: 0
          }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        ok: true,
        data: { jobId: `job_${"a".repeat(32)}`, status: "failed", progress: 0 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    await expect(runControlledEgressSmoke({ ...valid, fetchImplementation: fetcher as typeof fetch }))
      .rejects.toThrow("unexpected terminal");
    for (const init of requests) {
      const headers = new Headers(init.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      expect([...headers.keys()].every((name) => [
        "content-type",
        "x-videosave-client-ip"
      ].includes(name))).toBe(true);
    }
  });
});
