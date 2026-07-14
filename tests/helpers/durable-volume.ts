import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DURABLE_VOLUME_MARKER_CONTENT,
  DURABLE_VOLUME_MARKER_FILENAME
} from "@/lib/storage/durable-volume-marker";

/** Explicit test-only provisioning; production runtimes never create markers. */
export async function provisionDurableVolumeTestRoot(
  root: string,
  options: Readonly<{ createPublished?: boolean }> = {}
): Promise<void> {
  await writeFile(
    path.join(root, DURABLE_VOLUME_MARKER_FILENAME),
    DURABLE_VOLUME_MARKER_CONTENT,
    { encoding: "utf8", mode: 0o600, flag: "wx" }
  );
  if (options.createPublished) {
    await mkdir(path.join(root, "published"), { mode: 0o750 });
  }
}
