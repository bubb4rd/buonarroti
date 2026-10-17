"use client";

import * as React from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The tre cerchi as the Generate glyph: three rings for sculpture, painting and
 * architecture. They part a little on hover, turn a third of a circle when a
 * generation is sent, and keep turning while one is in flight (globals.css §
 * Generate).
 */
function Rings({ launches, busy }: { launches: number; busy?: boolean }) {
  return (
    <svg
      key={launches}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={5}
      aria-hidden
      data-launch={launches > 0 ? "" : undefined}
      data-busy={busy ? "" : undefined}
      className="generate-rings"
    >
      <circle cx="32" cy="23" r="12" />
      <circle cx="23" cy="39" r="12" />
      <circle cx="41" cy="39" r="12" />
    </svg>
  );
}

type GenerateButtonProps = Omit<ButtonPrimitive.Props, "children"> & {
  size?: "default" | "sm";
  /** A job from this button is in flight. */
  busy?: boolean;
  /** What the click makes, after the verb: "4 images", "video". */
  outcome?: string;
  /** Keyboard shortcut shown at the right edge, e.g. "⌘↵". */
  shortcut?: React.ReactNode;
  /** Why it can't run yet; shown as a tooltip while disabled. */
  blockedReason?: string;
};

/**
 * The app's one generative action (DESIGN.md § Generate). Ground ultramarine,
 * lit from above, paper-white type in both themes; it says what it will make.
 */
export function GenerateButton({
  size = "default",
  busy,
  outcome,
  shortcut,
  blockedReason,
  disabled,
  className,
  onClick,
  ...props
}: GenerateButtonProps) {
  const [launches, setLaunches] = React.useState(0);
  const inactive = disabled || busy;

  const button = (
    <ButtonPrimitive
      data-slot="button"
      aria-busy={busy || undefined}
      disabled={inactive}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) setLaunches((n) => n + 1);
      }}
      className={cn(
        "generate-button group/button relative inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-[var(--radius)] select-none outline-none",
        size === "sm" ? "h-7 gap-1.5 px-2.5 text-[12px]" : "h-9 gap-2 px-3.5 text-[13.5px]",
        className,
      )}
      {...props}
    >
      <span className={cn("shrink-0", size === "sm" ? "size-3.5" : "size-[17px]")}>
        <Rings launches={launches} busy={busy} />
      </span>
      <span className="font-semibold tracking-[-0.005em]">{busy ? "Generating" : "Generate"}</span>
      {outcome && !busy && <span className="-ml-0.5 font-normal opacity-80">{outcome}</span>}
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </ButtonPrimitive>
  );

  if (!disabled || busy || !blockedReason) return button;
  // Disabled buttons get no pointer events, so the wrapper carries the tooltip.
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="inline-flex shrink-0 rounded-[var(--radius)] outline-none focus-visible:shadow-[var(--focus-ring)]" />}>
        {button}
      </TooltipTrigger>
      <TooltipContent>{blockedReason}</TooltipContent>
    </Tooltip>
  );
}
