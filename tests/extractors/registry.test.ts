import { describe, expect, it } from "vitest";
import { findExtractor, listExtractors, requireExtractor } from "@/lib/extractors/registry";

describe("personal-use extractor registry", () => {
  it("enables exactly one Reddit extractor in the production registry", () => {
    expect(listExtractors().filter((extractor) => extractor.id === "reddit")).toHaveLength(1);
    expect(requireExtractor(new URL("https://www.reddit.com/r/videos/comments/abc123/synthetic_post/")).id).toBe("reddit");
  });

  it("keeps exactly one disabled TikTok placeholder in the production registry", async () => {
    const placeholders = listExtractors().filter((extractor) => extractor.id === "tiktok");
    expect(placeholders).toHaveLength(1);
    const url = new URL("https://www.tiktok.com/@synthetic/video/7000000000000000001");
    expect(requireExtractor(url)).toBe(placeholders[0]);
    await expect(placeholders[0]?.extract(url)).rejects.toMatchObject({
      code: "UNSUPPORTED_URL",
      status: 400
    });
  });

  it.each([
    "https://v.redd.it/abc/DASH_720.mp4",
    "https://video.twimg.com/source/video.webm",
    "https://player.vimeo.com/progressive/source.mov",
    "https://www.youtube.com/public/source.mp4"
  ])("routes an explicit direct media URL before a platform-page placeholder: %s", (value) => {
    expect(requireExtractor(new URL(value)).id).toBe("generic-direct-media");
  });

  it.each([
    ["tiktok", "https://www.tiktok.com/@creator/video/1"],
    ["instagram", "https://www.instagram.com/reel/public"],
    ["facebook", "https://www.facebook.com/watch/?v=1"],
    ["x", "https://x.com/creator/status/1"]
  ])("keeps the %s page boundary explicit", async (id, value) => {
    const extractor = requireExtractor(new URL(value));
    expect(extractor.id).toBe(id);
    await expect(extractor.extract(new URL(value))).rejects.toMatchObject({
      code: "UNSUPPORTED_URL",
      status: 400
    });
  });

  it.each([
    "https://www.reddit.com/r/videos/comments/abc123/synthetic_post/",
    "https://reddit.com/r/videos/comments/ABC123/another-slug",
    "https://old.reddit.com/r/videos/comments/abc123/legacy_post/",
    "https://www.reddit.com/comments/abc123/",
    "https://redd.it/abc123"
  ])("enables only the strict Reddit single-post extractor for %s", (value) => {
    expect(requireExtractor(new URL(value)).id).toBe("reddit");
  });

  it.each([
    "http://www.reddit.com/r/videos/comments/abc123/post/",
    "https://www.reddit.com/r/videos/",
    "https://www.reddit.com/gallery/abc123",
    "https://www.reddit.com/r/videos/comments/abc123/post/comment42/",
    "https://redd.it/tiny"
  ])("does not classify out-of-scope Reddit pages: %s", (value) => {
    expect(findExtractor(new URL(value))).toBeUndefined();
  });

  it.each([
    "https://youtube.com/watch?v=AbCdEfGhI_1",
    "https://www.youtube.com/shorts/AbCdEfGhI_1",
    "https://m.youtube.com/watch?v=AbCdEfGhI_1",
    "https://youtu.be/AbCdEfGhI_1"
  ])("enables only the strict YouTube single-video extractor for %s", (value) => {
    expect(requireExtractor(new URL(value)).id).toBe("youtube");
  });

  it.each([
    "http://youtube.com/watch?v=AbCdEfGhI_1",
    "https://youtube.com/watch?v=short",
    "https://youtube.com/watch?v=AbCdEfGhI_1&list=PLfixture",
    "https://youtube.com/channel/UCfixture",
    "https://youtube.com/live/AbCdEfGhI_1",
    "https://youtube-nocookie.com/embed/AbCdEfGhI_1"
  ])("does not classify out-of-scope YouTube pages: %s", (value) => {
    expect(findExtractor(new URL(value))).toBeUndefined();
  });

  it.each([
    "https://vimeo.com/123",
    "https://www.vimeo.com/123",
    "https://player.vimeo.com/video/123"
  ])("enables only the Vimeo single-video extractor for %s", (value) => {
    expect(requireExtractor(new URL(value)).id).toBe("vimeo");
  });

  it.each([
    "http://vimeo.com/123",
    "https://vimeo.com/showcase/123",
    "https://vimeo.com/channels/staffpicks/123",
    "https://vimeo.com/user123"
  ])("does not classify out-of-scope Vimeo pages: %s", (value) => {
    expect(findExtractor(new URL(value))).toBeUndefined();
  });

  it("does not match lookalike platform hostnames", () => {
    expect(findExtractor(new URL("https://youtube.com.attacker.example/watch.mp4"))?.id).toBe("generic-direct-media");
    expect(findExtractor(new URL("https://youtube.com.attacker.example/watch"))).toBeUndefined();
  });
});
