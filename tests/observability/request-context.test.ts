import { describe, expect, it } from "vitest";
import { currentRequestContext, runWithRequestContext, runWithoutRequestContext } from "@/lib/observability/request-context";
import { generateRequestId, resolveRequestId } from "@/lib/observability/request-id";
import { resolveRateLimitClientIdentifier } from "@/lib/security/client-identifier";

describe("request ID contract", () => {
  it("accepts one canonical Nginx ID and rejects malformed, duplicate-like, oversized, and controls", () => {
    const valid = "a".repeat(32);
    expect(resolveRequestId(new Headers({ "x-request-id": valid }), () => "b".repeat(32)))
      .toEqual({ requestId: valid, acceptedInbound: true });
    for (const value of [
      "",
      "A".repeat(32),
      `${valid},${"b".repeat(32)}`,
      "a".repeat(33),
      "a".repeat(31),
      "not valid",
      "a".repeat(30) + "\t"
    ]) {
      expect(resolveRequestId(new Headers({ "x-request-id": value }), () => "b".repeat(32)))
        .toEqual({ requestId: "b".repeat(32), acceptedInbound: false });
    }
  });

  it("supports deterministic injection and unique secure fallback", () => {
    expect(generateRequestId(() => "c".repeat(32))).toBe("c".repeat(32));
    const ids = new Set(Array.from({ length: 32 }, () => generateRequestId()));
    expect(ids.size).toBe(32);
  });

  it("does not make request IDs or spoofed forwarding headers rate-limit authority", () => {
    const first = new Headers({
      "x-request-id": "a".repeat(32),
      "x-forwarded-for": "198.51.100.10",
      "x-real-ip": "198.51.100.11",
      "x-videosave-client-ip": "127.0.0.1"
    });
    const second = new Headers({
      "x-request-id": "b".repeat(32),
      "x-forwarded-for": "203.0.113.10",
      "x-real-ip": "203.0.113.11",
      "x-videosave-client-ip": "127.0.0.1"
    });
    expect(resolveRateLimitClientIdentifier(first, "none")).toBe("unidentified");
    expect(resolveRateLimitClientIdentifier(second, "none")).toBe("unidentified");
    expect(resolveRateLimitClientIdentifier(first, "nginx-single-host"))
      .toBe(resolveRateLimitClientIdentifier(second, "nginx-single-host"));
  });
});

describe("AsyncLocalStorage request context", () => {
  it("isolates concurrent requests and clears context after completion", async () => {
    const observed = await Promise.all([
      runWithRequestContext({ requestId: "1".repeat(32), route: "job_status", method: "GET" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return currentRequestContext()?.requestId;
      }),
      runWithRequestContext({ requestId: "2".repeat(32), route: "job_submit", method: "POST" }, async () => {
        await Promise.resolve();
        return currentRequestContext()?.requestId;
      })
    ]);
    expect(observed).toEqual(["1".repeat(32), "2".repeat(32)]);
    expect(currentRequestContext()).toBeUndefined();
  });

  it("provides an explicit boundary for detached background work", () => {
    const value = runWithRequestContext(
      { requestId: "3".repeat(32), route: "job_submit", method: "POST" },
      () => runWithoutRequestContext(() => currentRequestContext())
    );
    expect(value).toBeUndefined();
  });
});
