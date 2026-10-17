import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Buttons — see DESIGN.md § Buttons.
 * primary  : lapis fill. One per view, the thing the user came to do.
 * ink      : ink fill. Strong secondary / confirm in dialogs.
 * outline  : raised paper with hairline. Default secondary.
 * ghost    : no chrome until hover. Toolbars, icon actions.
 * danger   : sanguine text, wash fill on hover. Destructive.
 * link     : inline lapis text.
 */
const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius)] border border-transparent text-[13px] font-medium whitespace-nowrap select-none outline-none transition-[background-color,color,box-shadow,transform,opacity] duration-150 ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] active:not-disabled:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary:
          "bg-lapis text-lapis-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(var(--lapis-rgb)/0.3)] hover:bg-lapis-hover",
        ink: "bg-ink text-paper hover:bg-ink/88",
        outline:
          "bg-surface-raised text-ink shadow-[var(--shadow-sm)] hover:bg-surface aria-expanded:bg-wash",
        ghost:
          "text-ink-2 hover:bg-wash hover:text-ink aria-expanded:bg-wash-strong aria-expanded:text-ink",
        danger: "text-sanguine hover:bg-sanguine/10",
        link: "h-auto px-0 text-lapis underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-7 px-2.5 text-[12.5px] [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-8 px-3",
        lg: "h-10 px-4 text-[14px]",
        icon: "size-8",
        "icon-sm": "size-7 rounded-[var(--radius-sm)] [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
