"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Segmented control — the "All · 30 days · 7 days" pill. The active segment
 * is a raised paper tab; the rest are quiet text on a sunk well.
 */
export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  icon?: React.ReactNode
  disabled?: boolean
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "default",
  className,
  "aria-label": ariaLabel,
}: {
  value: T
  onChange: (value: T) => void
  options: SegmentedOption<T>[]
  size?: "sm" | "default"
  className?: string
  "aria-label"?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-[var(--radius)] bg-wash p-0.5",
        className
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={opt.disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[calc(var(--radius)-2px)] font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 outline-none focus-visible:shadow-[var(--focus-ring)] disabled:opacity-40 [&_svg]:size-3.5",
              size === "sm" ? "h-6 px-2 text-[12px]" : "h-7 px-2.5 text-[12.5px]",
              active
                ? "bg-surface-raised text-ink shadow-[var(--shadow-sm)]"
                : "text-ink-3 hover:text-ink"
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
