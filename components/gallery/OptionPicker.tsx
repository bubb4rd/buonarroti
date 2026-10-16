"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export interface PickerOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  description?: string;
}

export interface OptionPickerProps {
  value: string;
  onChange: (v: string) => void;
  options: PickerOption[];
  /** Leading trigger icon, used when the selected option has none of its own. */
  icon?: React.ReactNode;
  "aria-label": string;
  disabled?: boolean;
}

/** Small chevron that flips while its picker is open (the trigger is a `group/button`). */
export function PickerChevron() {
  return (
    <ChevronDown
      aria-hidden
      strokeWidth={2.25}
      className="size-3 text-ink-3 transition-transform duration-150 ease-[var(--ease-out)] group-aria-expanded/button:rotate-180"
    />
  );
}

/** Diamond glyph marking quality / resolution pickers. */
export function QualityIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.7832 0.499878C10.3232 0.499878 10.6767 0.496482 11.0146 0.578979C11.1617 0.61491 11.3057 0.662985 11.4443 0.722534C11.7645 0.860077 12.0366 1.07387 12.4492 1.39148C13.1566 1.93605 13.7165 2.36662 14.127 2.75183C14.5421 3.14152 14.8482 3.52421 15.0088 3.99109C15.1407 4.37448 15.1904 4.77934 15.1543 5.18152C15.11 5.67308 14.9012 6.11252 14.5889 6.57898C14.2806 7.0392 13.8372 7.57315 13.2793 8.24695L10.6172 11.4628C10.115 12.0692 9.7038 12.5675 9.32715 12.9071C8.93826 13.2577 8.52095 13.4998 7.99902 13.4999C7.47706 13.4998 7.05981 13.2577 6.6709 12.9071C6.29425 12.5675 5.88301 12.0692 5.38086 11.4628L2.71875 8.24695C2.16068 7.573 1.71649 7.03928 1.4082 6.57898C1.09583 6.11253 0.88806 5.67308 0.84375 5.18152C0.807575 4.77927 0.857447 4.37442 0.989258 3.99109C1.14984 3.52425 1.45592 3.14152 1.87109 2.75183C2.28153 2.36662 2.84142 1.93606 3.54883 1.39148C3.96144 1.07384 4.23354 0.860066 4.55371 0.722534C4.69233 0.663015 4.83627 0.614905 4.9834 0.578979C5.32129 0.496532 5.67406 0.499877 6.21387 0.499878H9.7832ZM6.21387 1.49988C5.62618 1.49988 5.41459 1.50338 5.2207 1.55066C5.12692 1.57356 5.03539 1.60407 4.94824 1.64148C4.77007 1.71805 4.60994 1.83744 4.15918 2.18445C3.43571 2.74139 2.92207 3.13743 2.55566 3.48132C2.19409 3.82071 2.01931 4.06993 1.93457 4.31628C1.84817 4.56755 1.81638 4.83083 1.83984 5.09167C1.86269 5.34527 1.97017 5.62051 2.23926 6.02234C2.51258 6.43044 2.91688 6.91921 3.48828 7.60925L6.15039 10.8251C6.67274 11.4559 7.03123 11.8858 7.34082 12.1649C7.63783 12.4326 7.8253 12.4998 7.99902 12.4999C8.17274 12.4998 8.36021 12.4326 8.65723 12.1649C8.96678 11.8858 9.32443 11.4558 9.84668 10.8251L12.5098 7.60925C13.0811 6.91925 13.4855 6.43042 13.7588 6.02234C14.0278 5.62058 14.1353 5.34525 14.1582 5.09167C14.1816 4.83081 14.1498 4.56744 14.0635 4.31628C13.9788 4.06995 13.8039 3.82068 13.4424 3.48132C13.076 3.13744 12.5623 2.74138 11.8389 2.18445C11.3881 1.83744 11.228 1.71805 11.0498 1.64148C10.9627 1.60406 10.8712 1.57359 10.7773 1.55066C10.5834 1.50333 10.3713 1.49988 9.7832 1.49988H6.21387ZM9.33203 4.16687C9.6081 4.16695 9.83203 4.39078 9.83203 4.66687C9.83188 4.94283 9.60801 5.16679 9.33203 5.16687H6.66504C6.38915 5.16669 6.16519 4.94277 6.16504 4.66687C6.16504 4.39084 6.38905 4.16705 6.66504 4.16687H9.33203Z" />
    </svg>
  );
}

/** Ghost trigger + upward menu for a single choice (backend, quality, resolution, mode). */
export function OptionPicker({ value, onChange, options, icon, "aria-label": ariaLabel, disabled }: OptionPickerProps) {
  const selected = options.find(o => o.value === value);
  const label = selected?.label ?? value;
  const triggerIcon = selected?.icon ?? icon;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`${ariaLabel}: ${label}`}
        render={<Button variant="ghost" size="sm" className="gap-1.5" />}
      >
        {triggerIcon && <span className="flex items-center text-ink-3">{triggerIcon}</span>}
        <span className="tabular-nums">{label}</span>
        <PickerChevron />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        sideOffset={6}
        data-composer-popup=""
        aria-label={ariaLabel}
        className="max-h-[min(60vh,var(--available-height))] w-auto min-w-[max(var(--anchor-width),10rem)]"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={v => onChange(v as string)}>
          {options.map(o => (
            <DropdownMenuRadioItem key={o.value} value={o.value} label={o.label} closeOnClick className={o.description ? "py-1.5" : undefined}>
              {o.icon && <span className="flex items-center text-ink-3">{o.icon}</span>}
              {o.description ? (
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{o.label}</span>
                  <span className="truncate text-[12px] text-ink-3">{o.description}</span>
                </span>
              ) : (
                <span className="truncate tabular-nums">{o.label}</span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
