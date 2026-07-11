import { createMediaJobRouteHandlers } from "@/app/api/jobs/[id]/handler";
import { serializeMediaJobSnapshot } from "@/lib/api/media-job-serializer";
import { cancelDownloadJob, getDownloadJob } from "@/lib/jobs/download-service";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createMediaJobRouteHandlers({
  getDownloadJob,
  cancelDownloadJob,
  serializeMediaJobSnapshot,
  checkRateLimit
});

export const GET = handlers.GET;
export const DELETE = handlers.DELETE;
