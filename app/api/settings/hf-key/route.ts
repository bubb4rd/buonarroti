import { NextRequest, NextResponse } from "next/server";
import { getHfToken, setHfToken, deleteHfToken } from "@/lib/guest/db";

export async function GET() {
  return NextResponse.json({ hasToken: !!getHfToken() });
}

export async function POST(req: NextRequest) {
  const { hfToken } = await req.json();
  if (typeof hfToken !== "string" || !hfToken.trim()) {
    return NextResponse.json({ error: "hfToken is required" }, { status: 400 });
  }
  setHfToken(hfToken.trim());
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  deleteHfToken();
  return NextResponse.json({ ok: true });
}
