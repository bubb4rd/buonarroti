import { NextRequest } from "next/server";
import { jobEvents } from "@/lib/jobEvents";
import { checkJob } from "@/lib/kieJobPoller";
import type { JobResult } from "@/lib/jobStore";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-store",
  "Connection": "keep-alive",
};

/**
 * How long one stream stays open. Unrelated to the job's own cap (which the
 * poller enforces): when this elapses the stream just closes and EventSource
 * reconnects, re-checking the job.
 */
const STREAM_MAX_MS = 10 * 60_000;
/** Reconnect delay advertised to EventSource. */
const RETRY_MS = 3_000;

function event(payload: JobResult): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * GET /api/job-stream?taskId= (SSE). Emits the same payloads as
 * `/api/job-status` and closes after a terminal one (`done`, `error`,
 * `not_found`).
 */
export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get("taskId");
  if (!taskId) return new Response("taskId required", { status: 400 });

  const enc = new TextEncoder();
  const channel = `job:${taskId}`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(cap);
        jobEvents.off(channel, send);
        req.signal.removeEventListener("abort", close);
        try { controller.close(); } catch { /* already closed by the client */ }
      };

      // Only terminal results are sent; while pending the stream stays quiet
      // apart from heartbeats.
      const send = (payload: JobResult) => {
        if (closed || payload.status === "pending") return;
        controller.enqueue(enc.encode(event(payload)));
        close();
      };

      // Listen before checking, so a result that lands in between isn't missed.
      jobEvents.on(channel, send);
      req.signal.addEventListener("abort", close);

      // Keepalive comment every 25 s (proxies drop idle SSE connections)
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(enc.encode(": ping\n\n"));
      }, 25_000);
      const cap = setTimeout(close, STREAM_MAX_MS);

      controller.enqueue(enc.encode(`retry: ${RETRY_MS}\n\n`));
      try {
        send(await checkJob(taskId));
      } catch (e) {
        console.error(`[job-stream] ${taskId} status check failed:`, e);
        close(); // EventSource reconnects and checks again
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
