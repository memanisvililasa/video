import { createFileDeliveryRouteHandler } from "@/app/api/file/[id]/handler";
import { resolveWebApiRuntime } from "@/lib/web/runtime-resolver";
import { webHttpObservability } from "@/lib/observability/web";

export const GET = createFileDeliveryRouteHandler({
  async getFile(id) {
    return (await resolveWebApiRuntime()).files.get(id);
  },
  observability: webHttpObservability
});
