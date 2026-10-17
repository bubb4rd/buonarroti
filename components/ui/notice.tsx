import * as React from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Notice — the quiet banner (DESIGN.md § Banners). An inline paper card with a
 * pigment dot, one sentence and one action; optionally dismissible.
 * Sits in the stack at the top of the content sheet (see app/layout.tsx).
 */
const DOT = {
  ochre: "bg-ochre shadow-[0_0_0_3px_rgb(var(--ochre-rgb)/0.16)]",
  lapis: "bg-lapis shadow-[0_0_0_3px_rgb(var(--lapis-rgb)/0.16)]",
  sanguine: "bg-sanguine shadow-[0_0_0_3px_rgb(var(--sanguine-rgb)/0.16)]",
  verdigris: "bg-verdigris shadow-[0_0_0_3px_rgb(var(--verdigris-rgb)/0.16)]",
} as const

export type NoticeTone = keyof typeof DOT

function Notice({
  tone = "ochre",
  action,
  onDismiss,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  tone?: NoticeTone
  /** One action, usually a `<Button size="sm">`. */
  action?: React.ReactNode
  onDismiss?: () => void
}) {
  return (
    <div
      role="status"
      data-slot="notice"
      className={cn(
        "flex min-h-10 items-center gap-3 rounded-[var(--radius)] bg-surface py-1.5 pr-1.5 pl-3.5 text-[13px] leading-snug text-ink-2 shadow-[var(--shadow-sm)]",
        "animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-[var(--ease-out)]",
        className
      )}
      {...props}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-ink-4 transition-colors duration-150 hover:bg-wash hover:text-ink-2"
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </button>
      )}
    </div>
  )
}

export { Notice }
