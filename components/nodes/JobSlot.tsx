"use client";
import { useEffect, useState } from "react";
import { ShieldBan } from "lucide-react";
import { formatElapsed } from "@/lib/useJobStatus";

/** Re-renders every second while `active`, returning ms since `since`. */
export function useElapsed(since: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Refresh on the next frame (re-activation), then once a second.
    const raf = requestAnimationFrame(() => setNow(Date.now()));
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { cancelAnimationFrame(raf); clearInterval(t); };
  }, [active]);
  return since ? now - since : 0;
}

type ChipTone = "running" | "queued" | "done" | "failed";

const CHIP_TONE: Record<ChipTone, string> = {
  running: "text-ink-2",
  queued:  "text-ochre",
  done:    "text-verdigris",
  failed:  "text-sanguine",
};

/** DESIGN.md status chip, raised so it reads over artwork and empty mats alike. */
export function StatusChip({ tone, children }: { tone: ChipTone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 h-5 text-[11.5px] tabular-nums bg-surface-raised shadow-[var(--shadow-sm)] pointer-events-none select-none ${CHIP_TONE[tone]}`}
    >
      {tone === "running" && <span aria-hidden className="size-1.5 rounded-full bg-current animate-pulse" />}
      {tone === "queued" && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {tone === "done" && <span aria-hidden>✓</span>}
      {children}
    </span>
  );
}

/** In-flight media slot: ink shimmer, elapsed time, model name. */
export function GeneratingSlot({ startedAt, model, label = "Generating" }: { startedAt?: number; model?: string; label?: string }) {
  const elapsed = useElapsed(startedAt, true);
  return (
    <div className="absolute inset-0 ink-shimmer flex flex-col items-center justify-center gap-0.5 select-none pointer-events-none">
      <span className="text-[13px] text-ink-2 tabular-nums">
        {label}{startedAt ? ` · ${formatElapsed(elapsed)}` : "…"}
      </span>
      {model && <span className="text-[11.5px] text-ink-3">{model}</span>}
    </div>
  );
}

export function isModerationError(msg: string | undefined): boolean {
  return !!msg && (msg.includes("moderation_blocked") || msg.includes("flagged as sensitive"));
}

/** Failed media slot: what happened, then Retry (and optionally Remove). */
export function JobErrorSlot({
  message,
  onRetry,
  onRemove,
  retryDisabled,
}: {
  message: string;
  onRetry?: () => void;
  onRemove?: () => void;
  retryDisabled?: boolean;
}) {
  const moderated = isModerationError(message);
  return (
    <div className="absolute inset-0 bg-mat flex flex-col items-center justify-center gap-2.5 px-5 text-center z-20">
      <span className="inline-flex items-center gap-1.5 rounded-full px-2 h-5 text-[11.5px] text-sanguine bg-surface-raised shadow-[var(--shadow-sm)]">
        {moderated ? <ShieldBan size={12} strokeWidth={1.75} /> : <span aria-hidden className="size-1.5 rounded-full bg-current" />}
        Failed
      </span>
      <p className="text-[12.5px] leading-snug text-ink-2 break-words max-w-full">
        {moderated ? "kie.ai flagged this as sensitive content. Adjust the prompt, then retry." : message}
      </p>
      {(onRetry || onRemove) && (
        <div className="flex items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
          {onRetry && (
            <button
              type="button"
              disabled={retryDisabled}
              onClick={(e) => { e.stopPropagation(); onRetry(); }}
              className="h-7 px-2.5 rounded-[var(--radius)] text-[12.5px] font-medium text-lapis hover:bg-lapis-soft transition-colors disabled:opacity-45 disabled:pointer-events-none"
            >
              Retry
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              className="h-7 px-2.5 rounded-[var(--radius)] text-[12.5px] text-ink-3 hover:text-ink hover:bg-wash transition-colors"
            >
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
