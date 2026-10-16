import { NextRequest, NextResponse } from "next/server";
import { checkJob } from "@/lib/kieJobPoller";

/**
 * GET /api/job-status?taskId= → exactly one of
 * `{status:"pending"}` | `{status:"done", imageUrl?, imageUrls?, videoUrl?}` |
 * `{status:"error", error, code?}` | `{status:"not_found"}`.
 */
export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get("taskId");
  if (!taskId) {
    return NextResponse.json({ error: "taskId is required", code: "invalid" }, { status: 400 });
  }
  return NextResponse.json(await checkJob(taskId), { headers: { "Cache-Control": "no-store" } });
}
