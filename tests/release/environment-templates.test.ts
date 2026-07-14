import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const templatesRoot = path.join(process.cwd(), "deployment/env");

async function template(name: string): Promise<string> {
  return readFile(path.join(templatesRoot, name), "utf8");
}

describe("production environment template contract", () => {
  it("contains only the three role-specific documentation templates", async () => {
    const names = await readdir(templatesRoot);
    expect(names.sort()).toEqual([
      "migration.env.example",
      "web.env.example",
      "worker.env.example"
    ]);
  });

  it.each([
    ["web.env.example", "web"],
    ["worker.env.example", "worker"],
    ["migration.env.example", "migration"]
  ])("pins the %s role without test or populated credentials", async (name, role) => {
    const content = await template(name);
    expect(content).toContain("NODE_ENV=production");
    expect(content).toContain(`APP_PROCESS_ROLE=${role}`);
    expect(content).not.toContain("TEST_DATABASE_URL");
    expect(content).not.toMatch(/postgres(?:ql)?:\/\/[^<\s:@/]+:[^<\s@/]+@/i);
    expect(content).not.toMatch(/\/Users\/|\/home\/[^<\s/]+\//);
  });

  it("documents the loopback-only persistent web boundary", async () => {
    const content = await template("web.env.example");
    expect(content).toContain("HOSTNAME=127.0.0.1");
    expect(content).toContain("JOB_REPOSITORY_BACKEND=postgres");
    expect(content).toContain("MEDIA_STORAGE_BACKEND=durable-volume");
    expect(content).toContain("TRUST_PROXY_MODE=nginx-single-host");
    expect(content).not.toContain("WORKER_CONCURRENCY");
  });

  it("documents the compiled worker and external media tools", async () => {
    const content = await template("worker.env.example");
    expect(content).toContain("JOB_REPOSITORY_BACKEND=postgres");
    expect(content).toContain("MEDIA_STORAGE_BACKEND=durable-volume");
    expect(content).toContain("WORKER_CONCURRENCY=2");
    expect(content).toContain("FFMPEG_PATH=/usr/bin/ffmpeg");
    expect(content).toContain("FFPROBE_PATH=/usr/bin/ffprobe");
    expect(content).not.toContain("TRUST_PROXY_MODE");
  });

  it("keeps migration configuration separate from runtime services", async () => {
    const content = await template("migration.env.example");
    expect(content).toContain("DATABASE_URL=postgresql://<migration-role>");
    expect(content).not.toContain("JOB_REPOSITORY_BACKEND");
    expect(content).not.toContain("MEDIA_STORAGE_ROOT");
    expect(content).not.toContain("WORKER_");
  });
});
