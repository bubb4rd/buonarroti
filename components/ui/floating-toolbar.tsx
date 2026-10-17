"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * Floating toolbar — raised paper bars that hover over the canvas
 * (canvas tools, selection actions, node and group action bars).
 *
 * <FloatingBar>
 *   <ToolbarButton tooltip="Duplicate" onClick={…}><Copy /></ToolbarButton>
 *   <ToolbarSeparator />
 *   <ToolbarButton tooltip="Delete" shortcut="⌫" danger onClick={…}><Trash2 /></ToolbarButton>
 * </FloatingBar>
 */

/** Class string for the raised-paper floating surface. Use for menus/panels that are not bars. */
export const floatingPanelClass =
  "bg-surface-raised text-ink shadow-[var(--shadow-lg)] rounded-[var(--radius-lg)]"

function FloatingBar({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<"div"> & { orientation?: "horizontal" | "vertical" }) {
  return (
    <div
      data-slot="floating-bar"
      data-orientation={orientation}
      className={cn(
        floatingPanelClass,
        "flex items-center gap-0.5 p-1 whitespace-nowrap select-none",
        orientation === "vertical" && "flex-col",
        className
      )}
      {...props}
    />
  )
}

/** Shared icon-button look for every canvas toolbar. */
export const toolbarButtonClass =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-ink-2 outline-none transition-[background-color,color,opacity] duration-150 ease-[var(--ease-out)] hover:bg-wash hover:text-ink focus-visible:shadow-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-35 data-[active=true]:bg-wash-strong data-[active=true]:text-ink data-[danger=true]:hover:bg-sanguine/10 data-[danger=true]:hover:text-sanguine [&_svg:not([class*='size-'])]:size-3.5"

function ToolbarButton({
  className,
  active,
  danger,
  stopPropagation = true,
  tooltip,
  shortcut,
  tooltipSide = "top",
  onMouseDown,
  onClick,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & {
  active?: boolean
  danger?: boolean
  /** Keep clicks from reaching the React Flow pane/node underneath. Default true. */
  stopPropagation?: boolean
  /** Ink tooltip label; use instead of the native `title`. */
  tooltip?: React.ReactNode
  /** Keyboard hint shown in the tooltip, e.g. "V" or "⌘Z". */
  shortcut?: string
  tooltipSide?: "top" | "bottom" | "left" | "right"
}) {
  const button = (
    <button
      type={type}
      data-slot="toolbar-button"
      data-active={active || undefined}
      data-danger={danger || undefined}
      aria-pressed={active}
      aria-label={props["aria-label"] ?? (typeof tooltip === "string" ? tooltip : props.title)}
      className={cn(toolbarButtonClass, className)}
      onMouseDown={(e) => {
        if (stopPropagation) e.stopPropagation()
        onMouseDown?.(e)
      }}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation()
        onClick?.(e)
      }}
      {...props}
    />
  )
  if (!tooltip) return button
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side={tooltipSide}>
        {tooltip}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

function ToolbarSeparator({
  className,
  orientation = "vertical",
}: {
  className?: string
  orientation?: "vertical" | "horizontal"
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "shrink-0 bg-rule",
        orientation === "vertical" ? "mx-0.5 h-4 w-px" : "my-0.5 h-px w-4",
        className
      )}
    />
  )
}

export { FloatingBar, ToolbarButton, ToolbarSeparator }
