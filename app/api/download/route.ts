import { createDownloadPostHandler } from "@/app/api/download/handler";
import { enqueueDownloadJob } from "@/lib/jobs/download-service";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createDownloadPostHandler({
  enqueueDownloadJob,
  checkRateLimit
});
