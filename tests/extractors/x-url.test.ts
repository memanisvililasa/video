import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeXStatusUrl,
  classifyXUrl,
  supportsInternalXUrl
} from "@/lib/extractors/x-url";
import { API_ERROR_CODES } from "@/lib/types";

const POST_ID = "700000000000000001";

function expectUnsupported(value: string): void {
  expect(() => classifyXUrl(new URL(value))).toThrowError(expect.objectContaining({
    code: API_ERROR_CODES.UNSUPPORTED_URL
  }));
}

describe("isolated X/Twitter status URL foundation", () => {
  it.each([
    `https://x.com/synthetic_user/status/${POST_ID}`,
    `https://www.x.com/synthetic_user/status/${POST_ID}/`,
    `https://twitter.com/synthetic_user/status/${POST_ID}`,
    `https://www.twitter.com/synthetic_user/status/${POST_ID}/`,
    `https://mobile.x.com/synthetic_user/status/${POST_ID}`,
    `https://mobile.twitter.com/synthetic_user/status/${POST_ID}`
  ])("classifies an exact status candidate alias: %s", (value) => {
    expect(classifyXUrl(new URL(value))).toMatchObject({
      platform: "x",
      postId: POST_ID,
      sourceKind: "status-post-candidate"
    });
  });

  it("removes tracking and fragments and produces a deterministic x.com identity URL", () => {
    const identity = canonicalizeXStatusUrl(new URL(
      `https://www.twitter.com/Synthetic_User/status/${POST_ID}?s=20&t=fixture&utm_source=test#media`
    ));
    expect(identity.canonicalUrl.toString()).toBe(`https://x.com/_/status/${POST_ID}`);
    expect(identity.canonicalUrl.hostname).toBe("x.com");
    expect(identity.canonicalUrl.search).toBe("");
    expect(identity.canonicalUrl.hash).toBe("");
  });

  it("uses only the post ID for canonical identity", () => {
    const first = classifyXUrl(new URL(`https://x.com/First_User/status/${POST_ID}?ref_src=fixture`));
    const second = classifyXUrl(new URL(`https://twitter.com/second_user/status/${POST_ID}?utm_medium=share`));
    expect(first.canonicalUrl.toString()).toBe(second.canonicalUrl.toString());
    expect(first.postId).toBe(second.postId);
  });

  it.each([
    "https://x.com/synthetic_user",
    "https://x.com/search?q=video",
    "https://x.com/hashtag/video",
    "https://x.com/i/lists/123",
    "https://x.com/i/communities/123",
    "https://x.com/i/spaces/fixture",
    "https://x.com/i/broadcasts/fixture",
    "https://x.com/i/moments/123",
    "https://x.com/messages/123",
    "https://x.com/login",
    "https://x.com/account/access",
    "https://x.com/intent/tweet",
    "https://x.com/share",
    "https://x.com/synthetic_user/status",
    "https://x.com/synthetic_user/status/not-numeric",
    "https://x.com/synthetic_user/status/0",
    "https://x.com/synthetic_user/status/0123",
    "https://x.com/synthetic_user/status/123456789012345678901",
    `https://x.com/synthetic-user/status/${POST_ID}`,
    `https://x.com/this_username_is_too_long/status/${POST_ID}`,
    `https://x.com/synthetic_user/status/${POST_ID}/video/1`,
    `https://x.com/synthetic_user/status/${POST_ID}/photo/1`,
    `https://x.com/synthetic_user/status/${POST_ID}/extra`,
    `https://x.com/synthetic_user/status/${POST_ID}?unknown=1`,
    `https://x.com/synthetic_user/status/${POST_ID}?s=1&s=2`,
    `https://x.com/synthetic_user/status/${POST_ID}?S=20`,
    `http://x.com/synthetic_user/status/${POST_ID}`,
    `https://user:password@x.com/synthetic_user/status/${POST_ID}`,
    `https://x.com:8443/synthetic_user/status/${POST_ID}`,
    `https://x.com.attacker.example/synthetic_user/status/${POST_ID}`,
    `https://attacker.x.com/synthetic_user/status/${POST_ID}`,
    `https://127.0.0.1/synthetic_user/status/${POST_ID}`,
    `https://[::1]/synthetic_user/status/${POST_ID}`,
    `https://m.x.com/synthetic_user/status/${POST_ID}`,
    `https://x.com/synthetic_user%2Fstatus%2F${POST_ID}`
  ])("rejects an out-of-scope or ambiguous URL: %s", expectUnsupported);

  it("rejects t.co before any fetch or transport can run", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      expectUnsupported("https://t.co/SyntheticCode");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns false without diagnostics for unsupported boundaries", () => {
    expect(supportsInternalXUrl(new URL("https://t.co/SyntheticCode"))).toBe(false);
    expect(supportsInternalXUrl(new URL(`https://x.example/synthetic_user/status/${POST_ID}`))).toBe(false);
  });
});

afterEach(() => vi.unstubAllGlobals());
