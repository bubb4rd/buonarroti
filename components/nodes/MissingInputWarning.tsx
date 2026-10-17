"use client";
import { TriangleAlert } from "lucide-react";

/** Sanguine marker above a node's top-right corner; hover lists what's missing. */
export default function MissingInputWarning({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;

  return (
    <div className="group/missing pointer-events-auto absolute -top-[21px] right-0.5 z-20">
      <TriangleAlert className="block size-3.5 cursor-default text-sanguine" strokeWidth={2} aria-label="Missing inputs" />

      {/* Opens downward, aligned to the right of the icon */}
      <div
        role="tooltip"
        className="pointer-events-none absolute top-[calc(100%+6px)] right-0 z-[200] rounded-[var(--radius-sm)] bg-surface-raised px-2.5 py-1.5 text-[12px] whitespace-nowrap text-ink-2 opacity-0 shadow-[var(--shadow-lg)] transition-opacity duration-150 group-hover/missing:opacity-100"
      >
        {messages.map((msg, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="size-1.5 shrink-0 rounded-full bg-sanguine" />
            {msg}
          </div>
        ))}
      </div>
    </div>
  );
}
