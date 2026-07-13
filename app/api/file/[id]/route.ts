import { createReadStream } from "node:fs";
import { createFileDeliveryRouteHandler } from "@/app/api/file/[id]/handler";
import { getPreparedFile } from "@/lib/storage/local-storage";

export const GET = createFileDeliveryRouteHandler({
  async getFile(id) {
    const file = await getPreparedFile(id);
    if (!file) return null;
    const stream = createReadStream(file.path);
    return Object.freeze({
      fileId: file.id,
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      expiresAt: file.expiresAt,
      stream,
      async close() { stream.destroy(); }
    });
  }
});
