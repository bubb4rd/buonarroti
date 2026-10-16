"use client";

import { useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canRetry, cancelPending, dismissPending, retryPending } from "./generationStore";
import type { PendingGen, ReusePromptFn } from "./types";

/**
 * A generation slot in the grid at its real aspect ratio: an ink shimmer with
 * elapsed time and model while it runs, or a quiet failure card with Retry.
 */
export function PendingTile({ pg, onReuse }: { pg: PendingGen; onReuse: ReusePromptFn }) {
  return pg.error ? <FailedTile pg={pg} onReuse={onReuse} /> : <RunningTile pg={pg} />;
}

function useElapsed(since: string | undefined) {
  const start = since ? Date.parse(since) : NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!Number.isFinite(start)) return "";
  const s = Math.max(0, Math.floor((now - start) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function RunningTile({ pg }: { pg: PendingGen }) {
  const elapsed = useElapsed(pg.createdAt);
  return (
    <div className="ink-shimmer relative size-full overflow-hidden rounded-[var(--radius-sm)]" aria-busy="true" aria-label="Generating">
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-ink-3" />
            {pg.prePending ? "Starting…" : "Generating"}
            {elapsed && <span className="text-ink-3 tabular-nums">{elapsed}</span>}
          </div>
          {pg.modelName && <div className="mt-0.5 truncate text-[11.5px] text-ink-3">{pg.modelName}</div>}
        </div>
        {pg.prePending && (
          <Button variant="ghost" size="sm" onClick={() => cancelPending(pg.id)} className="shrink-0">
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

const isModeration = (e: string) => /moderation|flagged as sensitive/i.test(e);

function FailedTile({ pg, onReuse }: { pg: PendingGen; onReuse: ReusePromptFn }) {
  const moderated = pg.errorCode === "rejected" || isModeration(pg.error ?? "");
  return (
    <div className="group relative flex size-full flex-col overflow-hidden rounded-[var(--radius-sm)] bg-surface p-3 shadow-[inset_0_0_0_1px_var(--rule)]">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex h-5 items-center gap-1 rounded-full bg-sanguine/10 px-2 text-[11.5px] text-sanguine">
          {moderated ? "Declined" : "Failed"}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => dismissPending(pg.id)}
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <X />
        </Button>
      </div>
      <p title={pg.error} className="mt-2 line-clamp-4 min-h-0 shrink overflow-hidden text-[12px] leading-snug break-words text-ink-2">{pg.error}</p>
      {moderated && <p className="mt-1 text-[11.5px] text-ink-3">Credits are refunded for declined prompts.</p>}
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2">
        {canRetry(pg) && (
          <button type="button" onClick={() => retryPending(pg.id)} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-sanguine hover:underline">
            <RotateCcw className="size-3" />
            Retry
          </button>
        )}
        <button
          type="button"
          onClick={() => onReuse(pg.prompt, pg.referenceImageUrls)}
          className="text-[12.5px] text-ink-3 hover:text-ink hover:underline"
        >
          Edit prompt
        </button>
      </div>
    </div>
  );
}
