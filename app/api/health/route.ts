import { NextResponse } from "next/server";
import { createApiSuccessResponse } from "@/lib/errors";
import type { HealthResponse } from "@/lib/types";

export async function GET() {
  const response: HealthResponse = createApiSuccessResponse({
    status: "ok"
  });

  return NextResponse.json(
    response,
    { status: 200 }
  );
}
