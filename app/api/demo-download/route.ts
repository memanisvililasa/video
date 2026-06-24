import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const quality = new URL(request.url).searchParams.get("format");
  if (quality !== "720p" && quality !== "480p") {
    return new NextResponse("Not found", { status: 404 });
  }

  // Deliberately a small text demonstrator rather than copied media from a third party.
  const body = [
    "VideoSave demo download",
    "This placeholder proves the download UX only.",
    "A production adapter may return a file only after an official provider confirms authorization.",
    `Selected quality: ${quality}`
  ].join("\n");

  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="videosave-demo-${quality}.txt"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
