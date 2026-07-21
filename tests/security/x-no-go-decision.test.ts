import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

async function source(relative: string): Promise<string> {
  return readFile(path.join(ROOT, relative), "utf8");
}

describe("Stage 8.8A X/Twitter NO-GO decision", () => {
  it("records the accepted security boundary and every reconsideration prerequisite", async () => {
    const decision = await source("docs/adr/0006-x-twitter-production-integration-security-decision.md");
    expect(decision).toMatch(/Stage: 8\.8A/);
    expect(decision).toMatch(/Accepted — NO-GO/);
    expect(decision).toMatch(/feasibility: NOT CONFIRMED/);
    expect(decision).toMatch(/Stage 8\.8B and Stage 8\.8C are prohibited/);
    for (const mechanism of [
      "cookies", "login", "OAuth", "guest tokens", "bearer tokens", "authorization headers",
      "session reuse", "browser profiles", "netrc", "impersonation", "challenge solving",
      "CAPTCHA bypass", "proxy bypass", "DRM bypass", "remote executable", "user-supplied headers"
    ]) {
      expect(decision, mechanism).toContain(mechanism);
    }
    for (const prerequisite of [
      "audited, repository-approved executable contract",
      "independently verified artifact, signature, and digest",
      "path-aware controlled egress",
      "source and release-packaging security audit",
      "owner-authorized ephemeral metadata-only acceptance"
    ]) {
      expect(decision, prerequisite).toContain(prerequisite);
    }
    expect(decision).not.toMatch(/https?:\/\//);
    expect(decision).not.toMatch(/x\.com|twitter\.com|t\.co|Synthetic(?:Code|_|\d)|runtime (?:URL|ID|output)|(?:guest[_-]?token|bearer)\s*[:=]/i);
  });

  it("keeps the X/Twitter foundation pure and non-executable", async () => {
    const [url, metadata] = await Promise.all([
      source("lib/extractors/x-url.ts"),
      source("lib/extractors/x-metadata.ts")
    ]);
    expect(metadata).toContain('X_METADATA_EXECUTION_DECISION = "no-go"');
    expect(metadata).toContain("normalizeSyntheticXMetadata");
    expect(`${url}\n${metadata}`).not.toMatch(/bounded-process|child_process|yt-dlp|owner-authorized|fixedArguments/);
    expect(`${url}\n${metadata}`).not.toMatch(/\b(?:spawn|execFile|fetch|requestHead)\s*\(/);
    expect(`${url}\n${metadata}`).not.toMatch(/node:fs|node:http|node:https|proxy|impersonat/i);
  });

  it("keeps foundation modules outside the production graph and X/Twitter outside executable egress", async () => {
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
      expect(content, filename).not.toMatch(/from ["']@\/lib\/extractors\/x-(?:url|metadata)["']/);
    }

    const [contract, egress, runner] = await Promise.all([
      source("lib/extractors/yt-dlp/contract.ts"),
      source("lib/extractors/yt-dlp/egress-guard.ts"),
      source("lib/extractors/yt-dlp/runner.ts")
    ]);
    expect(contract).not.toMatch(/^\s*x:\s*Object\.freeze/m);
    expect(contract).not.toContain('Object.freeze(["Twitter"])');
    expect(egress).not.toMatch(/x\.com|twitter\.com|twimg\.com|syndication/i);
    expect(runner).toContain("hasOwnProperty.call(YT_DLP_EXTRACTOR_KEYS, platform)");
  });
});
