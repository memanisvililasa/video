import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

async function source(relative: string): Promise<string> {
  return readFile(path.join(ROOT, relative), "utf8");
}

describe("Stage 8.10A restricted TikTok metadata decision", () => {
  it("preserves historical ADR 0003 and records the narrow superseding boundary", async () => {
    const historical = await source("docs/adr/0003-tiktok-metadata-adapter-security-decision.md");
    expect(historical).toMatch(/Stage: 8\.5A/);
    expect(historical).toMatch(/Accepted — NO-GO/);
    expect(historical).toMatch(/Stage 8\.5B and Stage 8\.5C are prohibited/);
    for (const mechanism of [
      "cookies", "login", "session reuse", "browser profiles", "netrc", "impersonation",
      "challenge solving", "CAPTCHA bypass", "proxy bypass", "DRM bypass", "remote executable"
    ]) {
      expect(historical, mechanism).toContain(mechanism);
    }
    for (const prerequisite of [
      "official, repository-approved executable artifact",
      "verified digest",
      "controlled egress",
      "source and release-packaging security audit",
      "owner-authorized metadata-only acceptance"
    ]) {
      expect(historical, prerequisite).toContain(prerequisite);
    }
    expect(historical).not.toMatch(/https?:\/\//);
    expect(historical).not.toMatch(/\b\d{15,24}\b/);

    const decision = await source("docs/adr/0007-restricted-tiktok-public-metadata-feasibility.md");
    expect(decision).toMatch(/Stage: 8\.10A/);
    expect(decision).toMatch(/CONDITIONAL GO for isolated metadata only/);
    expect(decision).toMatch(/Supersedes: ADR 0003 only/);
    expect(decision).toMatch(/Production integration: disabled/);
    for (const boundary of [
      "ten-second maximum", "four-MiB body limit", "at most one redirect",
      "application/json hydration script", "at most three redirects", "Owner-authorized metadata-only acceptance"
    ]) expect(decision, boundary).toContain(boundary);
    for (const prohibited of [
      "yt-dlp", "cookies", "browser or client impersonation", "device IDs", "challenge solving",
      "API, GraphQL", "user-controlled headers", "media-body requests", "FFmpeg", "ffprobe"
    ]) expect(decision, prohibited).toContain(prohibited);
    expect(decision).not.toMatch(/https?:\/\//);
    expect(decision).not.toMatch(/\b\d{15,24}\b/);
  });

  it("keeps hydration parsing pure and confines I/O to safe-fetch plus reviewed short-link transport", async () => {
    const metadata = await source("lib/extractors/tiktok-metadata.ts");
    expect(metadata).toContain('TIKTOK_METADATA_EXECUTION_DECISION = "restricted-page"');
    expect(metadata).toContain("parseTikTokHydrationMetadata");
    expect(metadata).toContain("normalizeSyntheticTikTokMetadata");
    expect(metadata).not.toMatch(/bounded-process|child_process|yt-dlp|owner-authorized|fixedArguments/);
    expect(metadata).not.toMatch(/\b(?:spawn|execFile|fetch|requestHead)\s*\(/);
    expect(metadata).not.toMatch(/node:fs|node:http|node:https|proxy|impersonat/i);

    const adapter = await source("lib/extractors/tiktok-page-metadata.ts");
    expect(adapter).toContain("safeFetchBody");
    expect(adapter).toContain('requestProfile: "tiktok-public-page-v1"');
    expect(adapter).toContain("maxBytes: MAX_TIKTOK_PAGE_BYTES");
    expect(adapter).toContain("maxRedirects: 1");
    expect(adapter).toContain("requireHttps: true");
    expect(adapter).not.toMatch(/yt-dlp|cookie|authorization|thumbnail|manifest|ffmpeg|ffprobe|child_process/i);

    const safeFetch = await source("lib/http/safe-fetch.ts");
    expect(safeFetch).toContain('TIKTOK_PUBLIC_PAGE_USER_AGENT = "VideoSave/1.0 (restricted TikTok public metadata)"');
    expect(safeFetch).toContain('TIKTOK_PUBLIC_PAGE_ACCEPT = "text/html,application/xhtml+xml"');
    expect(safeFetch).toMatch(/requestProfile === "tiktok-public-page-v1"[\s\S]{0,120}TIKTOK_PUBLIC_PAGE_USER_AGENT/);
    expect(safeFetch).toMatch(/requestProfile === "tiktok-public-page-v1"[\s\S]{0,120}TIKTOK_PUBLIC_PAGE_ACCEPT/);

    const shortLink = await source("lib/extractors/tiktok-short-link.ts");
    expect(shortLink).toContain("https.request");
    expect(shortLink).toContain("resolveSafeAddress");
    expect(shortLink).toContain("maxHeaderSize: MAX_RESPONSE_HEADER_BYTES");
    expect(shortLink).toContain("response.destroy()");
    expect(shortLink).not.toContain("response.resume()");
    expect(shortLink).not.toMatch(/["'](?:cookie|authorization)["']\s*:/i);
    expect(shortLink).not.toMatch(/proxy|impersonat/i);
  });

  it("keeps TikTok URL, short-link, and metadata modules outside the production graph", async () => {
    const productionFiles = [
      "app/api/extract/route.ts",
      "lib/extractors/registry.ts",
      "lib/extractors/platform-url.ts",
      "lib/jobs/download-orchestrator.ts",
      "lib/worker/composition.ts",
      "lib/worker/processor.ts"
    ];
    for (const filename of productionFiles) {
      const content = await source(filename);
      expect(content, filename).not.toMatch(/from ["']@\/lib\/extractors\/tiktok-(?:url|short-link|metadata|page-metadata)["']/);
    }
    const signals = await source("lib/observability/signals.ts");
    expect(signals).not.toMatch(/tiktok/i);
  });

  it("removes TikTok from the executable yt-dlp platform contract", async () => {
    const contract = await source("lib/extractors/yt-dlp/contract.ts");
    expect(contract).toContain('Exclude<PlatformPageId, "reddit" | "tiktok" | "facebook" | "x">');
    expect(contract).not.toMatch(/^\s*tiktok:\s*Object\.freeze\(\["TikTok"\]\)/m);
    expect(contract).toMatch(/^\s*vimeo:\s*Object\.freeze\(\["Vimeo"\]\)/m);
    expect(contract).toMatch(/^\s*youtube:\s*Object\.freeze\(\["Youtube"\]\)/m);
  });
});
