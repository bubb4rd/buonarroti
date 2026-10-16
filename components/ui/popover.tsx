"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

/**
 * Popover — a sheet of raised paper anchored to a trigger.
 * <Popover>
 *   <PopoverTrigger render={<Button variant="ghost" size="sm" />}>…</PopoverTrigger>
 *   <PopoverContent side="top">…</PopoverContent>
 * </Popover>
 * Popups sit at z 9300, above dialogs (9000/9001).
 */
const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger
const PopoverClose = PopoverPrimitive.Close

/** Raised-paper surface shared by popovers and menus, with a 150ms fade/scale. */
const popupSurfaceClass =
  "origin-(--transform-origin) rounded-[var(--radius-lg)] bg-surface-raised p-1 text-ink shadow-[var(--shadow-lg)] outline-none transition-[opacity,scale] duration-150 ease-[var(--ease-out)] data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0"

type PositionProps = Pick<
  PopoverPrimitive.Positioner.Props,
  "side" | "align" | "sideOffset" | "alignOffset" | "collisionPadding"
>

function PopoverContent({
  className,
  positionerClassName,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  alignOffset = 0,
  collisionPadding = 8,
  ...props
}: PopoverPrimitive.Popup.Props & PositionProps & { positionerClassName?: string }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        className={cn("isolate z-[9300] outline-none", positionerClassName)}
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(popupSurfaceClass, className)}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverClose, PopoverContent, popupSurfaceClass }
