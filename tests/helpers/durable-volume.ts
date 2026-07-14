import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DURABLE_VOLUME_MARKER_FILENAME,
  durableVolumeMarkerContent
} from "@/lib/storage/durable-volume-marker";

export const TEST_DURABLE_VOLUME_AUTHORITY_ID = "0123456789abcdef0123456789abcdef";

/** Explicit test-only provisioning; production runtimes never create markers. */
export async function provisionDurableVolumeTestRoot(
  root: string,
  options: Readonly<{ createPublished?: boolean; authorityId?: string }> = {}
): Promise<void> {
  await writeFile(
    path.join(root, DURABLE_VOLUME_MARKER_FILENAME),
    durableVolumeMarkerContent(options.authorityId ?? TEST_DURABLE_VOLUME_AUTHORITY_ID),
    { encoding: "utf8", mode: 0o600, flag: "wx" }
  );
  if (options.createPublished) {
    await mkdir(path.join(root, "published"), { mode: 0o750 });
  }
}
