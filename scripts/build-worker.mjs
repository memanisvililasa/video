import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const outputDirectory = new URL("../.worker-dist/", import.meta.url);
await rm(outputDirectory, { recursive: true, force: true });

await build({
  entryPoints: [fileURLToPath(new URL("../lib/worker/entry.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("main.mjs", outputDirectory)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  plugins: [{
    name: "server-only-marker",
    setup(api) {
      api.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "marker" }));
      api.onLoad({ filter: /.*/, namespace: "marker" }, () => ({ contents: "export {};", loader: "js" }));
    }
  }]
});
