import { createMediaJobRouteHandlers } from "@/app/api/jobs/[id]/handler";
import { serializeMediaJobSnapshot } from "@/lib/api/media-job-serializer";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { resolveWebApiRuntime } from "@/lib/web/runtime-resolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createMediaJobRouteHandlers({
  async getDownloadJob(jobId) {
    return (await resolveWebApiRuntime()).jobs.getDownloadJob(jobId);
  },
  async cancelDownloadJob(jobId) {
    return (await resolveWebApiRuntime()).jobs.cancelDownloadJob(jobId);
  },
  serializeMediaJobSnapshot,
  checkRateLimit
});

export const GET = handlers.GET;
export const DELETE = handlers.DELETE;
