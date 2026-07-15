import { describe, expect, it } from "vitest";
import { checkHostnameSafety } from "@/lib/security/ssrf";
import { validateVideoUrl } from "@/lib/security/url-validation";

const blockedMappedIpv4 = [
  ["127.0.0.1", "PRIVATE_IPV4"],
  ["10.0.0.1", "PRIVATE_IPV4"],
  ["172.16.0.1", "PRIVATE_IPV4"],
  ["192.168.1.1", "PRIVATE_IPV4"],
  ["169.254.1.1", "PRIVATE_IPV4"],
  ["0.0.0.0", "PRIVATE_IPV4"],
  ["224.0.0.1", "RESERVED_IPV4"],
  ["192.0.2.1", "RESERVED_IPV4"]
] as const;

describe("IPv4-mapped IPv6 SSRF policy", () => {
  it.each(blockedMappedIpv4)("applies the IPv4 decision to mapped %s", (ipv4, reason) => {
    const direct = checkHostnameSafety(ipv4);
    const mapped = checkHostnameSafety(`::ffff:${ipv4}`);
    expect(direct).toMatchObject({ ok: false, reason });
    expect(mapped).toMatchObject({ ok: false, reason });
  });

  it("canonicalizes mapped public IPv4 to the ordinary IPv4 representation", () => {
    expect(checkHostnameSafety("8.8.8.8")).toEqual({ ok: true, hostname: "8.8.8.8" });
    expect(checkHostnameSafety("::ffff:8.8.8.8")).toEqual({ ok: true, hostname: "8.8.8.8" });
    expect(checkHostnameSafety("0:0:0:0:0:FFFF:0808:0808")).toEqual({ ok: true, hostname: "8.8.8.8" });
  });

  it.each([
    "https://[::ffff:127.0.0.1]/video.mp4",
    "https://[::ffff:10.0.0.1]/video.mp4",
    "https://[::ffff:172.16.0.1]/video.mp4",
    "https://[::ffff:192.168.1.1]/video.mp4",
    "https://[::ffff:169.254.1.1]/video.mp4",
    "https://[::ffff:0.0.0.0]/video.mp4"
  ])("rejects a mapped literal URL without exposing its address: %s", (value) => {
    const result = validateVideoUrl(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("ffff");
      expect(result.message).not.toMatch(/127\.0\.0\.1|10\.0\.0\.1|172\.16\.0\.1|192\.168\.1\.1|169\.254\.1\.1/);
    }
  });

  it("normalizes URL-parser-supported mapped public forms before use", () => {
    const dotted = validateVideoUrl("https://[::ffff:8.8.8.8]/video.mp4");
    const expanded = validateVideoUrl("https://[0:0:0:0:0:FFFF:0808:0808]/video.mp4");
    expect(dotted).toMatchObject({ ok: true, hostname: "8.8.8.8", normalizedUrl: "https://8.8.8.8/video.mp4" });
    expect(expanded).toMatchObject({ ok: true, hostname: "8.8.8.8", normalizedUrl: "https://8.8.8.8/video.mp4" });
  });

  it.each([
    "https://[::ffff:999.1.1.1]/video.mp4",
    "https://[::ffff:7f00:1:2]/video.mp4",
    "https://[fe80::1%25eth0]/video.mp4",
    "https://%5B::ffff:127.0.0.1%5D/video.mp4"
  ])("fails closed for malformed, zoned, or unsupported encoded literals: %s", (value) => {
    expect(validateVideoUrl(value).ok).toBe(false);
  });

  it.each(["::7f00:1", "::127.0.0.1", "0:0:0:0:0:0:7f00:1"])(
    "does not treat deprecated IPv4-compatible form as public IPv6: %s",
    (value) => expect(checkHostnameSafety(value).ok).toBe(false)
  );
});
