import { cn } from "@/lib/utils"

/**
 * Keyboard hint. Sits inside buttons (right edge) the way the reference does:
 * <Button>Export <Kbd>E</Kbd></Button>. On lapis/ink buttons it inverts itself.
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-[18px] w-fit min-w-[18px] items-center justify-center gap-0.5 rounded-[var(--radius-xs)] px-1 font-sans text-[10.5px] font-medium text-ink-3 select-none",
        "bg-wash shadow-[inset_0_0_0_1px_var(--rule)]",
        "in-data-[slot=button]:-mr-1 in-data-[slot=button]:ml-1",
        "group-[.bg-lapis]/button:bg-white/16 group-[.bg-lapis]/button:text-lapis-ink/85 group-[.bg-lapis]/button:shadow-none",
        "group-[.bg-ink]/button:bg-paper/14 group-[.bg-ink]/button:text-paper/80 group-[.bg-ink]/button:shadow-none",
        "in-data-[slot=tooltip-content]:bg-paper/14 in-data-[slot=tooltip-content]:text-paper/80 in-data-[slot=tooltip-content]:shadow-none",
        "[&_svg:not([class*='size-'])]:size-3",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-0.5", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
