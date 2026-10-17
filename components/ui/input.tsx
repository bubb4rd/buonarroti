import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

const fieldClass =
  "w-full min-w-0 rounded-[var(--radius)] border border-rule-strong bg-surface-raised px-2.5 text-[13px] text-ink transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-ink-4 hover:border-ink/25 focus-visible:border-lapis focus-visible:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-sanguine"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        fieldClass,
        "h-8 py-1 file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-ink",
        className
      )}
      {...props}
    />
  )
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClass, "min-h-20 resize-none py-2 leading-relaxed", className)}
      {...props}
    />
  )
}

export { Input, Textarea, fieldClass }
