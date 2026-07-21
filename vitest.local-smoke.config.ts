import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": projectRoot,
      "server-only": fileURLToPath(new URL("./tests/server-only-stub.ts", import.meta.url))
    }
  },
  test: {
    name: "local-smoke",
    environment: "node",
    include: ["tests/smoke/local-media.smoke.ts", "tests/smoke/tiktok-internal-media.smoke.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
