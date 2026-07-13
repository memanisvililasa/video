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
    name: "postgres",
    environment: "node",
    include: ["tests/postgres/**/*.integration.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    restoreMocks: true,
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
});
