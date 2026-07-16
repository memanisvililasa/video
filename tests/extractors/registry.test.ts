import { describe, expect, it } from "vitest";
import { findExtractor, requireExtractor } from "@/lib/extractors/registry";

describe("personal-use extractor registry", () => {
  it.each([
    "https://v.redd.it/abc/DASH_720.mp4",
    "https://video.twimg.com/source/video.webm",
    "https://player.vimeo.com/progressive/source.mov",
    "https://www.youtube.com/public/source.mp4"
  ])("routes an explicit direct media URL before a platform-page placeholder: %s", (value) => {
    expect(requireExtractor(new URL(value)).id).toBe("generic-direct-media");
  });

  it.each([
    ["youtube", "https://www.youtube.com/watch?v=public"],
    ["tiktok", "https://www.tiktok.com/@creator/video/1"],
    ["instagram", "https://www.instagram.com/reel/public"],
    ["facebook", "https://www.facebook.com/watch/?v=1"],
    ["x", "https://x.com/creator/status/1"],
    ["reddit", "https://www.reddit.com/r/videos/comments/public"],
    ["vimeo", "https://vimeo.com/123"]
  ])("keeps the %s page boundary explicit", async (id, value) => {
    const extractor = requireExtractor(new URL(value));
    expect(extractor.id).toBe(id);
    await expect(extractor.extract(new URL(value))).rejects.toMatchObject({
      code: "UNSUPPORTED_URL",
      status: 400
    });
  });

  it("does not match lookalike platform hostnames", () => {
    expect(findExtractor(new URL("https://youtube.com.attacker.example/watch.mp4"))?.id).toBe("generic-direct-media");
    expect(findExtractor(new URL("https://youtube.com.attacker.example/watch"))).toBeUndefined();
  });
});
