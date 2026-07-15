import type { NextRequest } from "next/server";
import { handleInternalWebRequest } from "@/lib/observability/internal-web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: NextRequest) => handleInternalWebRequest(request, "ready");
export const HEAD = GET;
export const POST = GET;
export const DELETE = GET;
export const OPTIONS = GET;
