import { cn } from "@/lib/utils"

/**
 * The mark: Michelangelo's own emblem, the *tre cerchi* — three interlaced
 * rings for sculpture, painting and architecture. Drawn in currentColor so it
 * takes ink on paper and paper on ink.
 */
export function Mark({ className, title = "Buonarroti" }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={3.4}
      role="img"
      aria-label={title}
      className={cn("size-6", className)}
    >
      <circle cx="32" cy="23" r="13" />
      <circle cx="23" cy="39" r="13" />
      <circle cx="41" cy="39" r="13" />
    </svg>
  )
}

/** Wordmark: the serif name set with optical size for display. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn("font-serif text-[19px] leading-none tracking-[-0.01em] text-ink", className)}
      style={{ fontVariationSettings: '"opsz" 30' }}
    >
      Buonarroti
    </span>
  )
}
