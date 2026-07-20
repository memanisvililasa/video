import { describe, expect, it } from "vitest";
import {
  canonicalizeRedditSourceInput,
  canonicalizeRedditPostUrl,
  supportsRedditPostUrl
} from "@/lib/extractors/reddit-url";
import { API_ERROR_CODES } from "@/lib/types";

describe("strict Reddit single-post URL boundary", () => {
  it("canonicalizes the original Reddit input before job persistence", () => {
    const fallback = new URL("https://www.reddit.com/r/videos/comments/abc123/post/?utm_source=share");
    expect(canonicalizeRedditSourceInput(fallback.toString(), fallback).toString())
      .toBe("https://www.reddit.com/comments/abc123/");
  });

  it.each([
    "https://www.reddit.com/r/videos/comments/abc123/synthetic_post/",
    "https://reddit.com/r/videos/comments/ABC123/another-slug",
    "https://old.reddit.com/r/videos/comments/abc123/legacy_post/",
    "https://redd.it/AbC123",
    "https://www.reddit.com/comments/abc123/",
    "https://www.reddit.com:443/r/videos/comments/abc123/synthetic_post/"
  ])("canonicalizes a supported post identity: %s", (value) => {
    const result = canonicalizeRedditPostUrl(new URL(value));
    expect(result).toMatchObject({
      postId: "abc123",
      url: new URL("https://www.reddit.com/comments/abc123/")
    });
    expect(supportsRedditPostUrl(new URL(value))).toBe(true);
  });

  it("removes tracking, fragments, and slug from canonical identity", () => {
    const left = canonicalizeRedditPostUrl(new URL(
      "https://www.reddit.com/r/videos/comments/abc123/first/?utm_source=share&utm_medium=web#comment"
    ));
    const right = canonicalizeRedditPostUrl(new URL(
      "https://reddit.com/r/elsewhere/comments/abc123/second/?share_id=synthetic&ref=share"
    ));
    expect(left.postId).toBe(right.postId);
    expect(left.url.toString()).toBe("https://www.reddit.com/comments/abc123/");
    expect(right.url.toString()).toBe(left.url.toString());
  });

  it.each([
    "http://www.reddit.com/r/videos/comments/abc123/post/",
    "https://user:secret@www.reddit.com/r/videos/comments/abc123/post/",
    "https://www.reddit.com:444/r/videos/comments/abc123/post/",
    "https://reddit.com.attacker.example/r/videos/comments/abc123/post/",
    "https://new.reddit.com/r/videos/comments/abc123/post/",
    "https://m.reddit.com/r/videos/comments/abc123/post/",
    "https://www.reddit.com/r/videos/",
    "https://www.reddit.com/user/synthetic/",
    "https://www.reddit.com/search/?q=video",
    "https://www.reddit.com/r/videos/collection/synthetic/",
    "https://www.reddit.com/gallery/abc123",
    "https://www.reddit.com/r/videos/comments/abc123/post/comment42/",
    "https://www.reddit.com/r/videos/comments/tiny/post/",
    "https://www.reddit.com/r/videos/comments/abc123/post/?unknown=value",
    "https://www.reddit.com/r/videos/comments/abc123/post/?utm_source=one&utm_source=two",
    "https://redd.it/abc123/extra"
  ])("rejects an out-of-scope URL: %s", (value) => {
    expect(() => canonicalizeRedditPostUrl(new URL(value))).toThrowError(
      expect.objectContaining({ code: API_ERROR_CODES.UNSUPPORTED_URL })
    );
    expect(supportsRedditPostUrl(new URL(value))).toBe(false);
  });
});
