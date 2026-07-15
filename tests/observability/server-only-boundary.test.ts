import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("server-only observability import boundary", () => {
  it("guards every TypeScript observability module and keeps client sources free of imports", async () => {
    const directory = path.join(process.cwd(), "lib/observability");
    const files = (await readdir(directory)).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(8);
    for (const name of files) {
      const content = await readFile(path.join(directory, name), "utf8");
      expect(content, name).toMatch(/^import "server-only";/);
    }
    for (const relative of ["app/page.tsx", "components", "lib/client"]) {
      const candidate = path.join(process.cwd(), relative);
      const info = await import("node:fs/promises").then((fs) => fs.stat(candidate).catch(() => null));
      if (!info) continue;
      const sources = info.isDirectory()
        ? (await readdir(candidate)).filter((name) => /\.[tj]sx?$/.test(name)).map((name) => path.join(candidate, name))
        : [candidate];
      for (const source of sources) {
        expect(await readFile(source, "utf8"), source).not.toContain("@/lib/observability");
      }
    }
  });
});
