import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const resolve = {
  alias: {
    "@": projectRoot,
    "server-only": fileURLToPath(new URL("./tests/server-only-stub.ts", import.meta.url))
  }
};

export default defineConfig({
  resolve,
  test: {
    projects: [
      {
        resolve,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          restoreMocks: true
        }
      },
      {
        resolve,
        test: {
          name: "browser",
          include: ["tests/browser/**/*.browser.test.tsx", "tests/**/*.browser.test.tsx"],
          setupFiles: ["./tests/browser/setup.ts"],
          isolate: true,
          restoreMocks: true,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [{ browser: "chromium" }]
          }
        }
      }
    ]
  }
});
