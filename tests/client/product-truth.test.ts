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

async function source(relative: string): Promise<string> {
  return readFile(path.join(process.cwd(), relative), "utf8");
}

describe("personal-use product truth", () => {
  it("describes direct media plus bounded Vimeo/YouTube/Reddit support without stale claims", async () => {
    const content = (await Promise.all(productFiles.map(source))).join("\n");
    expect(content).not.toMatch(/Этап 2|На Этапе 4|frontend-(?:этап|интерфейс)|skeleton\/stub|будут добавлены/i);
    expect(content).toMatch(/\.mp4/);
    expect(content).toMatch(/\.webm/);
    expect(content).toMatch(/\.mov/);
    expect(content).toMatch(/прямые публичные HTTPS/i);
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
    expect(content).not.toMatch(/(?:поддерживает|поддерживаемые)[^\n]{0,80}Instagram/i);
    expect(content).not.toMatch(/(?:поддерживает|поддерживаемые)[^\n]{0,80}Facebook/i);
    expect(content).not.toMatch(/(?:поддерживает|поддерживаемые)[^\n]{0,80}X\/Twitter/i);
    expect(content).toMatch(/t\.co[^\n]{0,100}(?:не поддерживается|unsupported)|(?:не поддерживаются|unsupported)[^\n]{0,100}t\.co/i);
    expect(content).toMatch(/внешн(?:ие|ий).*Reddit embeds?/i);
    expect(content).toMatch(/private\/login-required|login-required/i);
    expect(content).toMatch(/live content|live\/premiere/i);
    expect(content).toMatch(/playlists?|playlist/i);
    expect(content).toMatch(/unsupported multi-item/i);
    expect(content).not.toMatch(/люб(?:ая|ую|ой)\s+платформ|any platform/i);
    expect(content).toMatch(/не гарантирует[^\n]{0,100}(?:исходн|оригинальн|original)[^\n]{0,40}качеств/i);
    expect(content).not.toMatch(/(?<!не )гарантирует[^\n]{0,100}(?:исходн|оригинальн|original)[^\n]{0,40}качеств/i);
    expect(content).not.toMatch(/гарантирует[^\n]{0,100}(?:удаление|отсутствие)[^\n]{0,40}(?:watermark|водян)/i);
    expect(content).toMatch(/не удаляет водяные знаки/i);
  });

  it("records the current Stage 8 history and keeps deployment claims fail-closed", async () => {
    const readme = await source("README.md");
    for (const stage of ["8.1", "8.2", "8.3", "8.4A", "8.4B", "8.4C", "8.5A", "8.6A", "8.7A", "8.8A", "8.9"]) {
      expect(readme, `Stage ${stage}`).toContain(stage);
    }
    for (const adr of ["ADR 0003", "ADR 0004", "ADR 0005", "ADR 0006"]) {
      expect(readme, adr).toContain(adr);
    }
    expect(readme).toMatch(/Stage 8\.9:\s*Personal-use platform matrix closure/i);
    expect(readme).toMatch(/8\.5A[^\n]*8\.6A[^\n]*8\.7A[^\n]*8\.8A[^\n]*Accepted NO-GO/i);
    expect(readme).toMatch(/production deployment не (?:выполнялся|выполнен)/i);
    expect(readme).toMatch(/не заявляет готовность к публичному multi-user production/i);
    expect(readme).not.toMatch(/production deployment (?:успешно )?выполнен/i);
    expect(readme).toMatch(/auto-discovered или user-supplied JS runtimes[^\n]*отключены/i);
    expect(readme).toMatch(/фиксированный локальный Node binary/i);
  });

  it("does not claim or configure Redis for the accepted local/single-host scope", async () => {
    const [environment, config, limiter] = await Promise.all([
      source(".env.example"),
      source("lib/config/env.ts"),
      source("lib/security/rate-limit.ts")
    ]);
    expect(`${environment}\n${config}\n${limiter}`).not.toMatch(/REDIS_URL|Upstash|redisUrl/);
  });
});
