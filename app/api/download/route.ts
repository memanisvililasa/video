import { createDownloadPostHandler } from "@/app/api/download/handler";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { resolveWebApiRuntime } from "@/lib/web/runtime-resolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createDownloadPostHandler({
  async enqueueDownloadJob(request) {
    return (await resolveWebApiRuntime()).jobs.enqueueDownloadJob(request);
  },
  checkRateLimit
});
