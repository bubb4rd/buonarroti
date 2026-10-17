export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { listAgents } from "@/lib/acp/status";

/** ACP agents (Claude Code / Codex / Gemini CLI) and the models each one offers. `?refresh=1` re-probes. */
export async function GET(req: NextRequest) {
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const agents = await listAgents({ refresh });
  return Response.json({ agents }, { headers: { "Cache-Control": "no-store" } });
}
