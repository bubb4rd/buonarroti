/**
 * GET /api/download?url=<encoded-url>&filename=<name>
 *
 * Server-side proxy that fetches the asset and returns it with
 * Content-Disposition: attachment so the browser saves it to disk.
 * Only hosts on the allowlist (by hostname suffix, https only) are proxied.
 */
import { NextRequest, NextResponse } from "next/server";

// kie.ai serves results from several CDN hosts (cdn.kie.ai,
// tempfile.aiquickdraw.com, tempfile.redpandaai.co, …), so match by suffix —
// the same families `next.config.ts` allows for images.
const ALLOWED_HOST_SUFFIXES = [
  "kie.ai",
  "aiquickdraw.com",
  "redpandaai.co",
  "r2.dev",
  "replicate.delivery",
  "replicate.com",
];

function isAllowed(url: string): boolean {
  if (url.startsWith("/generated/")) return true; // local disk, served same-origin
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  // Quotes / control characters would break out of the Content-Disposition value.
  const filename = (req.nextUrl.searchParams.get("filename") ?? "download").replace(/["\\\r\n]/g, "_") || "download";

  if (!url) return new NextResponse("Missing url", { status: 400 });
  if (!isAllowed(url)) return new NextResponse("Forbidden", { status: 403 });

  let fetchUrl = url;
  if (url.startsWith("/generated/")) {
    const resolved = new URL(url, req.nextUrl.origin);
    // Re-check after normalization: rejects "/generated/../api/..." traversal
    // that would otherwise turn this proxy into same-origin SSRF.
    if (!resolved.pathname.startsWith("/generated/")) return new NextResponse("Forbidden", { status: 403 });
    fetchUrl = resolved.toString();
  }

  let upstream: Response;
  try {
    upstream = await fetch(fetchUrl);
  } catch {
    return new NextResponse("Fetch failed", { status: 502 });
  }

  if (!upstream.ok) {
    return new NextResponse("Upstream error", { status: upstream.status });
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
