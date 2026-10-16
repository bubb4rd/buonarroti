"use client";

import { useState } from "react";
import { Check, ChevronDown, CircleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DownloadTask } from "./types";

const ICON = { strokeWidth: 1.75 } as const;
const RING_R = 6.5;
const RING_C = 2 * Math.PI * RING_R;

/** Small lapis progress ring: the arc grows as tasks finish, and spins while any are preparing. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const fraction = Math.max(0.25, total ? done / total : 0);
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4 shrink-0 animate-spin text-lapis" aria-hidden>
      <circle cx="8" cy="8" r={RING_R} stroke="currentColor" strokeWidth="1.75" opacity="0.2" />
      <circle
        cx="8"
        cy="8"
        r={RING_R}
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray={RING_C}
        strokeDashoffset={RING_C * (1 - fraction)}
        className="origin-center -rotate-90 transition-[stroke-dashoffset] duration-200 ease-[var(--ease-out)]"
      />
    </svg>
  );
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function DownloadToast({ downloads, onClear }: { downloads: DownloadTask[]; onClear: () => void }) {
  const [collapsed, setCollapsed] = useState(false);

  if (downloads.length === 0) return null;

  const preparing = downloads.filter(d => d.status === "preparing").length;
  const failed = downloads.filter(d => d.status === "error").length;
  const ready = downloads.length - preparing - failed;
  const status: DownloadTask["status"] = preparing > 0 ? "preparing" : failed > 0 ? "error" : "ready";

  const message =
    status === "preparing"
      ? preparing === 1 ? "Preparing your download…" : `Preparing ${plural(preparing, "download")}…`
      : status === "error"
        ? ready > 0
          ? `${plural(failed, "download")} failed, ${ready} saved. Try again.`
          : `${plural(failed, "download")} failed. Try again.`
        : "Saved to Downloads";

  const showList = downloads.length > 1;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-[9600] w-[300px] animate-in overflow-hidden rounded-[var(--radius-lg)] bg-surface-raised shadow-[var(--shadow-lg)] duration-200 ease-[var(--ease-out)] fade-in slide-in-from-bottom-2"
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-[3px] transition-colors duration-200",
          status === "preparing" ? "bg-ink-3" : status === "error" ? "bg-sanguine" : "bg-verdigris",
        )}
      />

      <div className="flex items-center gap-2.5 py-2 pr-2 pl-4">
        {status === "preparing" ? (
          <ProgressRing done={downloads.length - preparing} total={downloads.length} />
        ) : status === "error" ? (
          <CircleAlert className="size-4 shrink-0 text-sanguine" {...ICON} aria-hidden />
        ) : (
          <Check className="size-4 shrink-0 text-verdigris" {...ICON} aria-hidden />
        )}

        <div className="min-w-0 flex-1 py-1">
          <p className="text-[13px] leading-[1.4] text-ink">{message}</p>
          {!showList && (
            <p className="truncate text-[12px] text-ink-3" title={downloads[0].filename}>{downloads[0].filename}</p>
          )}
        </div>

        {showList && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={collapsed ? "Show downloads" : "Hide downloads"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(c => !c)}
          >
            <ChevronDown
              {...ICON}
              className={cn("transition-transform duration-200 ease-[var(--ease-out)]", collapsed && "rotate-180")}
            />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onClear}>
          <X {...ICON} />
        </Button>
      </div>

      {showList && !collapsed && (
        <ul className="max-h-60 overflow-y-auto border-t border-rule py-1 pr-2 pl-4">
          {downloads.map(task => (
            <li key={task.id} className="flex h-8 items-center gap-2.5">
              <span
                className={cn("min-w-0 flex-1 truncate text-[12.5px]", task.status === "preparing" ? "text-ink-3" : "text-ink-2")}
                title={task.filename}
              >
                {task.filename}
              </span>
              {task.status === "preparing" ? (
                <span className="shrink-0 text-[11.5px] text-ink-3">Preparing…</span>
              ) : task.status === "error" ? (
                <span className="shrink-0 text-[11.5px] text-sanguine">Failed</span>
              ) : (
                <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-verdigris">
                  <Check className="size-3" strokeWidth={2} aria-hidden />
                  Saved
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
