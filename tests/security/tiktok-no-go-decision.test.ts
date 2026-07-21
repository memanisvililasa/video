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

  it("records the bounded Stage 8.10B decision without enabling production", async () => {
    const decision = await source("docs/adr/0008-bounded-tiktok-media-feasibility.md");
    expect(decision).toMatch(/internal Stage 8\.10B only/);
    expect(decision).toContain("v16-webapp-prime.tiktok.com");
    expect(decision).toContain("v19-webapp-prime.tiktok.com");
    for (const boundary of [
      "Wildcards", "progressive", "expire", "Referer", "owner-authorized live-download acceptance", "Stage 8.10C"
    ]) expect(decision, boundary).toContain(boundary);
    for (const prohibition of [
      "cookies", "login", "proxying", "impersonation", "yt-dlp", "production registry", "public API"
    ]) expect(decision.toLowerCase(), prohibition).toContain(prohibition.toLowerCase());
    expect(decision).not.toMatch(/https?:\/\/(?!www\.tiktok\.com\/)/);
    expect(decision).not.toMatch(/\b\d{15,24}\b/);
  });

  it("keeps every Stage 8.10B module outside production composition roots", async () => {
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
      expect(content, filename).not.toMatch(/tiktok-(?:media|internal-pipeline)/);
    }
    const registry = await source("lib/extractors/registry.ts");
    expect(registry).not.toMatch(/tiktokMedia|TikTokMedia/);
    const contract = await source("lib/extractors/yt-dlp/contract.ts");
    expect(contract).not.toMatch(/^\s*tiktok:/m);
  });

  it("uses exact host matching and fixed media headers without cookie or browser surfaces", async () => {
    const policy = await source("lib/extractors/tiktok-media-policy.ts");
    expect(policy).toContain('"v16-webapp-prime.tiktok.com"');
    expect(policy).toContain('"v19-webapp-prime.tiktok.com"');
    expect(policy).toContain("MEDIA_HOST_SET.has");
    expect(policy).not.toMatch(/endsWith|includes\([^)]*hostname|\*\./);

    const safeFetch = await source("lib/http/safe-fetch.ts");
    expect(safeFetch).toContain('TIKTOK_MEDIA_REFERER = "https://www.tiktok.com/"');
    expect(safeFetch).toContain('requestProfile === "tiktok-media-v1"');
    const media = await source("lib/extractors/tiktok-media.ts");
    expect(media).toContain('requestProfile: "tiktok-media-v1"');
    expect(media).not.toMatch(/cookie|authorization|proxy|impersonat|yt-dlp|child_process|execFile|spawn\s*\(/i);
  });
});
