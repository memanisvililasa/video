import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

async function source(relative: string): Promise<string> {
  return readFile(path.join(ROOT, relative), "utf8");
}

describe("Stage 8.5A TikTok NO-GO decision", () => {
  it("records the accepted security boundary and every reconsideration prerequisite", async () => {
    const decision = await source("docs/adr/0003-tiktok-metadata-adapter-security-decision.md");
    expect(decision).toMatch(/Stage: 8\.5A/);
    expect(decision).toMatch(/Accepted — NO-GO/);
    expect(decision).toMatch(/Stage 8\.5B and Stage 8\.5C are prohibited/);
    for (const mechanism of [
      "cookies", "login", "session reuse", "browser profiles", "netrc", "impersonation",
      "challenge solving", "CAPTCHA bypass", "proxy bypass", "DRM bypass", "remote executable"
    ]) {
      expect(decision, mechanism).toContain(mechanism);
    }
    for (const prerequisite of [
      "official, repository-approved executable artifact",
      "verified digest",
      "controlled egress",
      "source and release-packaging security audit",
      "owner-authorized metadata-only acceptance"
    ]) {
      expect(decision, prerequisite).toContain(prerequisite);
    }
    expect(decision).not.toMatch(/https?:\/\//);
    expect(decision).not.toMatch(/\b\d{15,24}\b/);
  });

  it("keeps the metadata foundation pure and non-executable", async () => {
    const metadata = await source("lib/extractors/tiktok-metadata.ts");
    expect(metadata).toContain('TIKTOK_METADATA_EXECUTION_DECISION = "no-go"');
    expect(metadata).toContain("normalizeSyntheticTikTokMetadata");
    expect(metadata).not.toMatch(/bounded-process|child_process|yt-dlp|owner-authorized|fixedArguments/);
    expect(metadata).not.toMatch(/\b(?:spawn|execFile|fetch|requestHead)\s*\(/);
    expect(metadata).not.toMatch(/node:fs|node:http|node:https|proxy|impersonat/i);
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
      expect(content, filename).not.toMatch(/from ["']@\/lib\/extractors\/tiktok-(?:url|short-link|metadata)["']/);
    }
    const signals = await source("lib/observability/signals.ts");
    expect(signals).not.toMatch(/tiktok/i);
  });
});
