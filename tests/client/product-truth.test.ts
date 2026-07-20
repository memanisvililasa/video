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
  it("describes direct media plus bounded Vimeo/YouTube/Reddit support without stale claims", async () => {
    const content = (await Promise.all(productFiles.map((relative) =>
      readFile(path.join(process.cwd(), relative), "utf8")
    ))).join("\n");
    expect(content).not.toMatch(/Этап 2|На Этапе 4|frontend-(?:этап|интерфейс)|skeleton\/stub|будут добавлены/i);
    expect(content).toMatch(/\.mp4/);
    expect(content).toMatch(/\.webm/);
    expect(content).toMatch(/\.mov/);
    expect(content).toMatch(/не обходит DRM/);
    expect(content).toMatch(/Vimeo/);
    expect(content).toMatch(/публичн(?:ые|ой) одиночн/i);
    expect(content).toMatch(/progressive HTTPS/i);
    expect(content).toMatch(/YouTube/);
    expect(content).toMatch(/Shorts/);
    expect(content).toMatch(/watch-видео|watch URL/i);
    expect(content).toMatch(/раздельные.*поток|video\/audio streams/i);
    expect(content).toMatch(/playlist/i);
    expect(content).toMatch(/Reddit/);
    expect(content).toMatch(/Reddit-hosted|v\.redd\.it/i);
    expect(content).toMatch(/single|одиночн/i);
    expect(content).toMatch(/split|раздельные.*поток/i);
    expect(content).toMatch(/silent|без аудио/i);
    expect(content).toMatch(/gallery/i);
    expect(content).toMatch(/external embed/i);
    expect(content).toMatch(/другие страницы платформ|другие page URL/i);
    expect(content).toMatch(/не поддерживаются|отклоняются/i);
    expect(content).not.toMatch(/поддерживаются все.*Vimeo|любые.*Vimeo/i);
    expect(content).not.toMatch(/поддерживаются все.*YouTube|любые.*YouTube/i);
    expect(content).not.toMatch(/YouTube, Reddit, TikTok.*не поддерживаются/i);
    expect(content).not.toMatch(/Reddit, TikTok, Instagram.*не поддерживаются/i);
    expect(content).toMatch(/TikTok, Instagram, Facebook и X\/Twitter.*(?:отключены|не поддерживаются)/i);
    expect(content).not.toMatch(/(?:поддерживает|поддерживаемые)[^\n]{0,80}TikTok/i);
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
