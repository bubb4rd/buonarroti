"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

/** Switch — ink track when on, a paper thumb. */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-[18px] w-[30px] shrink-0 cursor-pointer items-center rounded-full bg-ink/15 p-[2px] transition-colors duration-200 outline-none focus-visible:shadow-[var(--focus-ring)] data-[checked]:bg-ink disabled:cursor-not-allowed disabled:opacity-45",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-[14px] rounded-full bg-surface-raised shadow-[0_1px_2px_rgb(var(--shadow-rgb)/0.3)] transition-transform duration-200 ease-[var(--ease-out)] data-[checked]:translate-x-[12px] dark:data-[checked]:bg-paper" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
