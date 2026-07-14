import { beforeEach, describe, expect, it } from "vitest";
import {
  env,
  RATE_LIMIT_CONFIG_LIMITS,
  parseRateLimitSecurityConfig
} from "@/lib/config/env";
import { getClientIdentifier } from "@/lib/security/sanitize";
import {
  checkRateLimit,
  createRateLimitKey,
  getClientIpFromHeaders,
  getRateLimitConfig,
  resetRateLimitStoreForTests,
  resolveRateLimitClientIdentifier,
  type RateLimitBucket
} from "@/lib/security/rate-limit";

const BUCKETS: readonly RateLimitBucket[] = [
  "extract",
  "download",
  "job-status",
  "job-cancel",
  "file"
];

function headers(values: Record<string, string> = {}): Headers {
  return new Headers(values);
}

beforeEach(() => {
  resetRateLimitStoreForTests();
});

describe("rate-limit security configuration", () => {
  it("defaults to trust-none with bounded positive limiter values", () => {
    expect(parseRateLimitSecurityConfig({})).toEqual({
      trustProxyMode: "none",
      rateLimitWindowSeconds: 60,
      rateLimitMaxRequests: 30
    });
    expect(parseRateLimitSecurityConfig({ TRUST_PROXY_MODE: "none" }).trustProxyMode).toBe("none");
    expect(parseRateLimitSecurityConfig({ TRUST_PROXY_MODE: "   " }).trustProxyMode).toBe("none");
  });

  it("accepts only the explicit single-host Nginx trust mode", () => {
    expect(parseRateLimitSecurityConfig({
      TRUST_PROXY_MODE: "nginx-single-host"
    }).trustProxyMode).toBe("nginx-single-host");
  });

  it.each(["hops", "cidr", "vercel", "true", "1", "NONE"])(
    "rejects unsupported TRUST_PROXY_MODE=%s instead of enabling trust",
    (value) => {
      expect(() => parseRateLimitSecurityConfig({ TRUST_PROXY_MODE: value })).toThrow(TypeError);
    }
  );

  it.each(["0", "-1", "1.5", "NaN", "Infinity", "10001"])(
    "rejects RATE_LIMIT_MAX_REQUESTS=%s instead of enabling unlimited behavior",
    (value) => {
      expect(() => parseRateLimitSecurityConfig({ RATE_LIMIT_MAX_REQUESTS: value })).toThrow(TypeError);
    }
  );

  it("accepts the documented upper bounds", () => {
    expect(parseRateLimitSecurityConfig({
      RATE_LIMIT_MAX_REQUESTS: String(RATE_LIMIT_CONFIG_LIMITS.maxRequests),
      RATE_LIMIT_WINDOW_SECONDS: String(RATE_LIMIT_CONFIG_LIMITS.maxWindowSeconds)
    })).toMatchObject({
      rateLimitMaxRequests: RATE_LIMIT_CONFIG_LIMITS.maxRequests,
      rateLimitWindowSeconds: RATE_LIMIT_CONFIG_LIMITS.maxWindowSeconds
    });
  });

  it("rejects invalid effective overrides rather than failing open", () => {
    const input = { bucket: "download" as const, headers: headers() };
    expect(() => checkRateLimit(input, { maxRequests: 0 })).toThrow(TypeError);
    expect(() => checkRateLimit(input, { windowSeconds: 0 })).toThrow(TypeError);
    expect(() => checkRateLimit(input, { maxTrackedKeys: 0 })).toThrow(TypeError);
  });
});

describe("trust-none HTTP client identifier", () => {
  it.each([
    ["no headers", {}],
    ["Forwarded", { Forwarded: "for=198.51.100.4;proto=https" }],
    ["X-Forwarded-For IPv4", { "X-Forwarded-For": "198.51.100.4" }],
    ["X-Forwarded-For chain", { "X-Forwarded-For": "198.51.100.4, 10.0.0.2, 127.0.0.1" }],
    ["X-Real-IP", { "X-Real-IP": "203.0.113.8" }],
    ["CF-Connecting-IP", { "CF-Connecting-IP": "192.0.2.9" }],
    ["X-Client-IP", { "X-Client-IP": "198.51.100.7" }],
    ["IPv6", { "X-Forwarded-For": "2001:db8::1" }],
    ["bracketed IPv6", { "X-Forwarded-For": "[2001:db8::1]" }],
    ["IPv4-mapped IPv6", { "X-Forwarded-For": "::ffff:192.0.2.1" }],
    ["address with port", { "X-Forwarded-For": "198.51.100.4:443" }],
    ["IPv6 with port", { "X-Forwarded-For": "[2001:db8::1]:443" }],
    ["zone identifier", { "X-Forwarded-For": "fe80::1%en0" }],
    ["whitespace", { "X-Forwarded-For": "   198.51.100.4   " }],
    ["empty", { "X-Forwarded-For": "" }],
    ["invalid", { "X-Forwarded-For": "not-an-ip" }],
    ["private proxy address", { "X-Forwarded-For": "10.0.0.2" }],
    ["unknown header", { "X-Originating-IP": "203.0.113.10" }]
  ] as const)("ignores %s", (_name, values) => {
    const requestHeaders = headers(values);
    expect(resolveRateLimitClientIdentifier(requestHeaders)).toBe("unidentified");
    expect(getClientIpFromHeaders(requestHeaders)).toBe("unidentified");
    expect(getClientIdentifier(requestHeaders)).toBe("unidentified");
  });

  it("does not read headers, including malformed or oversized chains", () => {
    const poisonHeaders = {
      get(): never {
        throw new Error("untrusted header access");
      }
    } as unknown as Headers;
    expect(resolveRateLimitClientIdentifier(poisonHeaders)).toBe("unidentified");

    const longChain = Array.from({ length: 1_000 }, (_, index) => `198.51.100.${index % 255}`).join(",");
    expect(resolveRateLimitClientIdentifier(headers({ "X-Forwarded-For": longChain }))).toBe("unidentified");
  });

  it("combines duplicate headers without allowing them to affect the key", () => {
    const requestHeaders = new Headers();
    requestHeaders.append("X-Forwarded-For", "198.51.100.1");
    requestHeaders.append("X-Forwarded-For", "203.0.113.2");
    expect(createRateLimitKey({ bucket: "download", headers: requestHeaders })).toBe("download:unidentified");
  });

  it("uses one stable HTTP identifier for every bucket without merging buckets", () => {
    for (const bucket of BUCKETS) {
      expect(createRateLimitKey({
        bucket,
        headers: headers({ "X-Forwarded-For": `${bucket}.attacker.invalid` })
      })).toBe(`${bucket}:unidentified`);
    }
  });

  it("reaches the same limit while an attacker rotates forwarding headers", () => {
    const override = { maxRequests: 2, windowSeconds: 60 };
    expect(checkRateLimit({
      bucket: "download",
      headers: headers({ "X-Forwarded-For": "198.51.100.1" })
    }, override).ok).toBe(true);
    expect(checkRateLimit({
      bucket: "download",
      headers: headers({ "X-Real-IP": "203.0.113.2" })
    }, override).ok).toBe(true);
    const rejected = checkRateLimit({
      bucket: "download",
      headers: headers({ "CF-Connecting-IP": "192.0.2.3" })
    }, override);
    expect(rejected).toMatchObject({
      ok: false,
      key: "download:unidentified",
      retryAfterSeconds: expect.any(Number)
    });
  });

  it("does not place a raw client IP in HTTP limiter keys", () => {
    const key = createRateLimitKey({
      bucket: "extract",
      headers: headers({ "X-Forwarded-For": "198.51.100.42" })
    });
    expect(key).toBe("extract:unidentified");
    expect(key).not.toContain("198.51.100.42");
  });

  it("keeps the existing bucket values", () => {
    expect(getRateLimitConfig("extract").maxRequests).toBe(env.rateLimitMaxRequests);
    expect(getRateLimitConfig("download").maxRequests).toBe(Math.min(env.rateLimitMaxRequests, 10));
    expect(getRateLimitConfig("job-status").maxRequests).toBe(Math.max(env.rateLimitMaxRequests, 120));
    expect(getRateLimitConfig("job-cancel").maxRequests).toBe(Math.min(env.rateLimitMaxRequests, 20));
    expect(getRateLimitConfig("file").maxRequests).toBe(Math.max(env.rateLimitMaxRequests, 120));
  });
});

describe("single-host Nginx client identifier", () => {
  it.each([
    ["IPv4", "198.51.100.24", "198.51.100.24"],
    ["IPv6", "2001:DB8::24", "2001:db8::24"],
    ["private IPv4", "10.0.0.24", "10.0.0.24"]
  ])("accepts one proxy-owned %s identity", (_name, value, expected) => {
    expect(resolveRateLimitClientIdentifier(headers({
      "X-VideoSave-Client-IP": value
    }), "nginx-single-host")).toBe(expected);
  });

  it.each([
    {},
    { "X-VideoSave-Client-IP": "" },
    { "X-VideoSave-Client-IP": "not-an-ip" },
    { "X-VideoSave-Client-IP": "198.51.100.1, 203.0.113.2" },
    { "X-VideoSave-Client-IP": "198.51.100.1:443" },
    { "X-VideoSave-Client-IP": "[2001:db8::1]" }
  ])("fails closed for a missing or invalid trusted header", (values) => {
    expect(resolveRateLimitClientIdentifier(
      headers(values as Record<string, string>),
      "nginx-single-host"
    )).toBe("unidentified");
  });

  it("ignores all public forwarding headers when the fixed trusted header is absent", () => {
    expect(resolveRateLimitClientIdentifier(headers({
      Forwarded: "for=198.51.100.1",
      "X-Forwarded-For": "198.51.100.2",
      "X-Real-IP": "198.51.100.3",
      "CF-Connecting-IP": "198.51.100.4"
    }), "nginx-single-host")).toBe("unidentified");
  });

  it("does not allow other headers to replace a valid proxy-owned identity", () => {
    expect(createRateLimitKey({
      bucket: "download",
      headers: headers({
        "X-VideoSave-Client-IP": "198.51.100.8",
        "X-Forwarded-For": "203.0.113.9"
      })
    })).toBe("download:unidentified");
    expect(resolveRateLimitClientIdentifier(headers({
      "X-VideoSave-Client-IP": "198.51.100.8",
      "X-Forwarded-For": "203.0.113.9"
    }), "nginx-single-host")).toBe("198.51.100.8");
  });
});
