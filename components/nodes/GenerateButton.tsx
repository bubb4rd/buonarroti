"use client";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GenerateButton as GenerateAction } from "@/components/ui/generate-button";
import { cn } from "@/lib/utils";

interface Props {
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  extracting?: boolean;
  warningMessages?: string[];
}

/** The node's primary action: the shared Generate button, or a sanguine outline when an input is broken. */
export default function GenerateButton({ onClick, busy, disabled, extracting, warningMessages }: Props) {
  const hasWarning = !!warningMessages?.length;

  if (!hasWarning && !extracting) {
    return (
      <GenerateAction
        size="sm"
        busy={busy}
        disabled={disabled}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
      />
    );
  }

  return (
    <div className="group/generate relative shrink-0">
      <Button
        size="sm"
        variant="outline"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        disabled={disabled || busy || extracting}
        aria-busy={extracting}
        className={cn(
          "h-7 gap-1.5 px-3 text-[12px]",
          hasWarning && "cursor-not-allowed text-sanguine shadow-[inset_0_0_0_1px_rgb(var(--sanguine-rgb)/0.45)]",
          extracting && "text-ochre",
        )}
      >
        {extracting ? (
          <>
            <Loader2 className="size-3 animate-spin" />
            Extracting…
          </>
        ) : (
          "Generate"
        )}
      </Button>

      {hasWarning && (
        <div
          role="tooltip"
          className="pointer-events-none absolute right-0 bottom-[calc(100%+6px)] z-[200] rounded-[var(--radius-sm)] bg-surface-raised px-2.5 py-1.5 text-[12px] whitespace-nowrap text-ink-2 opacity-0 shadow-[var(--shadow-lg)] transition-opacity duration-150 group-hover/generate:opacity-100"
        >
          {warningMessages.map((msg, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="size-1.5 shrink-0 rounded-full bg-sanguine" />
              {msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
