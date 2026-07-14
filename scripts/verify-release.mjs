import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_ROOT_DIRECTORY, verifyReleaseRoot } from "./release-contract.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const requested = process.argv[2];
if (process.argv.length > 3) {
  console.error("Release verification accepts at most one directory argument.");
  process.exitCode = 1;
} else {
  const root = requested ? path.resolve(process.cwd(), requested) : path.join(projectRoot, RELEASE_ROOT_DIRECTORY);
  verifyReleaseRoot(root, { builderRoot: process.env.VIDEOSAVE_BUILDER_ROOT }).then(
    ({ manifest, files }) => {
      console.info(`Release verification passed: ${manifest.build.gitCommit.slice(0, 12)}, ${files.length} files.`);
    },
    (error) => {
      console.error(error instanceof Error ? error.message : "Release verification failed.");
      process.exitCode = 1;
    }
  );
}
