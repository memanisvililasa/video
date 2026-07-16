import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const productFiles = [
  "README.md",
  "app/page.tsx",
  "app/terms/page.tsx",
  "app/faq/page.tsx",
  "app/how-it-works/page.tsx",
  "components/platforms-section.tsx",
  "components/faq-section.tsx"
];

describe("personal-use product truth", () => {
  it("describes the implemented direct-media runtime without stale frontend-stage claims", async () => {
    const content = (await Promise.all(productFiles.map((relative) =>
      readFile(path.join(process.cwd(), relative), "utf8")
    ))).join("\n");
    expect(content).not.toMatch(/Этап 2|На Этапе 4|frontend-(?:этап|интерфейс)|skeleton\/stub|будут добавлены/i);
    expect(content).toMatch(/\.mp4/);
    expect(content).toMatch(/\.webm/);
    expect(content).toMatch(/\.mov/);
    expect(content).toMatch(/не обходит DRM/);
    expect(content).toMatch(/страниц(?:ы|ах) платформ/i);
  });

  it("does not claim or configure Redis for the accepted local/single-host scope", async () => {
    const [environment, config, limiter] = await Promise.all([
      readFile(path.join(process.cwd(), ".env.example"), "utf8"),
      readFile(path.join(process.cwd(), "lib/config/env.ts"), "utf8"),
      readFile(path.join(process.cwd(), "lib/security/rate-limit.ts"), "utf8")
    ]);
    expect(`${environment}\n${config}\n${limiter}`).not.toMatch(/REDIS_URL|Upstash|redisUrl/);
  });
});
