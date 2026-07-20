import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

async function source(relative: string): Promise<string> {
  return readFile(path.join(ROOT, relative), "utf8");
}

describe("Stage 8.7A Facebook NO-GO decision", () => {
  it("records the accepted security boundary and every reconsideration prerequisite", async () => {
    const decision = await source("docs/adr/0005-facebook-production-integration-security-decision.md");
    expect(decision).toMatch(/Stage: 8\.7A/);
    expect(decision).toMatch(/Accepted — NO-GO/);
    expect(decision).toMatch(/feasibility: NOT CONFIRMED/);
    expect(decision).toMatch(/Stage 8\.7B and Stage 8\.7C are prohibited/);
    for (const mechanism of [
      "cookies", "login", "OAuth", "access tokens", "session reuse", "browser profiles", "netrc",
      "impersonation", "challenge solving", "CAPTCHA bypass", "proxy bypass", "DRM bypass",
      "remote executable", "user-supplied headers"
    ]) {
      expect(decision, mechanism).toContain(mechanism);
    }
    for (const prerequisite of [
      "audited, repository-approved executable contract",
      "verified artifact and digest",
      "controlled egress",
      "source and release-packaging security audit",
      "owner-authorized metadata-only acceptance"
    ]) {
      expect(decision, prerequisite).toContain(prerequisite);
    }
    expect(decision).not.toMatch(/https?:\/\//);
    expect(decision).not.toMatch(/facebook\.com|fb\.watch|Synth(?:Code|_)|runtime (?:URL|ID|output)|page name:/i);
  });

  it("keeps the Facebook metadata foundation pure and non-executable", async () => {
    const metadata = await source("lib/extractors/facebook-metadata.ts");
    expect(metadata).toContain('FACEBOOK_METADATA_EXECUTION_DECISION = "no-go"');
    expect(metadata).toContain("normalizeSyntheticFacebookMetadata");
    expect(metadata).not.toMatch(/bounded-process|child_process|yt-dlp|owner-authorized|fixedArguments/);
    expect(metadata).not.toMatch(/\b(?:spawn|execFile|fetch|requestHead)\s*\(/);
    expect(metadata).not.toMatch(/node:fs|node:http|node:https|proxy|impersonat/i);
  });

  it("keeps Facebook foundation modules outside the production graph and egress policy", async () => {
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
      expect(content, filename).not.toMatch(/from ["']@\/lib\/extractors\/facebook-(?:url|metadata|short-link)["']/);
    }

    const [url, shortLink, metadata, contract, egress] = await Promise.all([
      source("lib/extractors/facebook-url.ts"),
      source("lib/extractors/facebook-short-link.ts"),
      source("lib/extractors/facebook-metadata.ts"),
      source("lib/extractors/yt-dlp/contract.ts"),
      source("lib/extractors/yt-dlp/egress-guard.ts")
    ]);
    expect(`${url}\n${shortLink}\n${metadata}`).not.toMatch(/child_process|bounded-process|yt-dlp|node:https|node:http/);
    expect(shortLink).not.toMatch(/\bfetch\s*\(|\bspawn\s*\(|\bexecFile\s*\(/);
    expect(contract).not.toMatch(/^\s*facebook:\s*Object\.freeze/m);
    expect(egress).not.toMatch(/facebook|fb\.watch/i);
  });
});
