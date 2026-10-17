"use client";

import * as React from "react";
import { Check, ChevronLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { menuItemClass } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AZURE_POPULAR_SIZES, validateAzureCustomSize } from "@/lib/modelConfig";
import { cn } from "@/lib/utils";
import { PickerChevron } from "./OptionPicker";

export interface AspectRatioPickerProps {
  value: string;
  onChange: (v: string) => void;
  ratios: string[];
  /** Offers "Custom…" (Azure gpt-image-2): popular sizes plus manual width × height. */
  allowCustom: boolean;
  customWidth?: number;
  customHeight?: number;
  onApplyCustom: (w: number, h: number) => void;
  disabled?: boolean;
}

/** Outlined rectangle in `currentColor` at the ratio's proportions, fitted inside maxW × maxH. */
export function RatioGlyph({ ratio, maxW, maxH }: { ratio: string; maxW: number; maxH: number }) {
  const [ws, hs] = ratio.split(":");
  const w = parseFloat(ws), h = parseFloat(hs);
  if (!w || !h) return null;
  let rw = maxW, rh = (h / w) * maxW;
  if (rh > maxH) { rh = maxH; rw = (w / h) * maxH; }
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-[2px] border-[1.5px] border-current"
      style={{ width: Math.round(rw), height: Math.round(rh) }}
    />
  );
}

export function AspectRatioPicker({
  value,
  onChange,
  ratios,
  allowCustom,
  customWidth,
  customHeight,
  onApplyCustom,
  disabled,
}: AspectRatioPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<"list" | "custom">("list");
  const [widthDraft, setWidthDraft] = React.useState(1024);
  const [heightDraft, setHeightDraft] = React.useState(1024);
  const [customError, setCustomError] = React.useState<string | null>(null);
  const activeRowRef = React.useRef<HTMLButtonElement>(null);

  // "auto" / "adaptive" read as words in sentence case; numeric ratios are unchanged.
  const label = value === "custom"
    ? `${customWidth ?? 1024}×${customHeight ?? 1024}`
    : value.charAt(0).toUpperCase() + value.slice(1);

  const applyCustom = () => {
    const err = validateAzureCustomSize(widthDraft, heightDraft);
    if (err) { setCustomError(err); return; }
    onApplyCustom(widthDraft, heightDraft);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        if (next) setView("list");
        setOpen(next);
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        aria-label={`Aspect ratio: ${label}`}
        render={<Button variant="ghost" size="sm" className="gap-1.5" />}
      >
        {value !== "custom" && <RatioGlyph ratio={value} maxW={16} maxH={12} />}
        <span className="tabular-nums">{label}</span>
        <PickerChevron />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        data-composer-popup=""
        aria-label="Aspect ratio"
        initialFocus={activeRowRef}
        className={view === "list" ? "w-auto min-w-[max(var(--anchor-width),10rem)]" : "w-[260px] p-3"}
      >
        {view === "list" ? (
          <div
            className="max-h-[min(60vh,var(--available-height))] overflow-y-auto"
            onKeyDown={e => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
              const i = rows.indexOf(document.activeElement as HTMLButtonElement);
              const next = e.key === "ArrowDown" ? (i + 1) % rows.length : (i - 1 + rows.length) % rows.length;
              rows[next]?.focus();
            }}
          >
            {ratios.map(r => {
              const active = r === value;
              return (
                <button
                  key={r}
                  type="button"
                  ref={active ? activeRowRef : undefined}
                  aria-pressed={active}
                  onClick={() => { onChange(r); setOpen(false); }}
                  className={cn(menuItemClass, "pr-8")}
                >
                  <span className="flex w-8 items-center justify-center text-ink-2">
                    <RatioGlyph ratio={r} maxW={24} maxH={16} />
                  </span>
                  <span className="tabular-nums">{r.charAt(0).toUpperCase() + r.slice(1)}</span>
                  {active && <Check aria-hidden strokeWidth={2.25} className="absolute right-2 size-3.5 text-lapis" />}
                </button>
              );
            })}
            {allowCustom && (
              <>
                <div className="-mx-1 my-1 h-px bg-rule" />
                <button
                  type="button"
                  ref={value === "custom" ? activeRowRef : undefined}
                  aria-pressed={value === "custom"}
                  onClick={() => {
                    setWidthDraft(customWidth ?? 1024);
                    setHeightDraft(customHeight ?? 1024);
                    setCustomError(null);
                    setView("custom");
                  }}
                  className={cn(menuItemClass, "pr-8")}
                >
                  <span className="w-8" />
                  <span>Custom…</span>
                  {value === "custom" && <Check aria-hidden strokeWidth={2.25} className="absolute right-2 size-3.5 text-lapis" />}
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" className="-ml-1.5 h-6 gap-0.5 px-1.5 text-[12px]" onClick={() => setView("list")}>
                <ChevronLeft aria-hidden />
                Back
              </Button>
              <span className="type-label">Custom size</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                inputMode="numeric"
                aria-label="Width"
                placeholder="Width"
                value={widthDraft}
                onChange={e => setWidthDraft(Number(e.target.value))}
                onKeyDown={e => { if (e.key === "Enter") applyCustom(); }}
                className="h-7 tabular-nums"
              />
              <span aria-hidden className="shrink-0 text-[12px] text-ink-3">×</span>
              <Input
                type="number"
                inputMode="numeric"
                aria-label="Height"
                placeholder="Height"
                value={heightDraft}
                onChange={e => setHeightDraft(Number(e.target.value))}
                onKeyDown={e => { if (e.key === "Enter") applyCustom(); }}
                className="h-7 tabular-nums"
              />
            </div>
            <div className="grid grid-cols-2 gap-1">
              {AZURE_POPULAR_SIZES.map(p => {
                const picked = p.width === widthDraft && p.height === heightDraft;
                return (
                  <button
                    key={p.label}
                    type="button"
                    aria-pressed={picked}
                    onClick={() => { setWidthDraft(p.width); setHeightDraft(p.height); setCustomError(null); }}
                    className={cn(
                      "rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[12px] leading-snug text-ink-2 shadow-[inset_0_0_0_1px_var(--rule)] transition-colors duration-100 outline-none hover:bg-wash hover:text-ink focus-visible:shadow-[var(--focus-ring)]",
                      picked && "bg-lapis-soft text-lapis shadow-none hover:bg-lapis-soft hover:text-lapis",
                    )}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            {customError && <p role="alert" className="text-[12px] leading-snug text-sanguine">{customError}</p>}
            <Button variant="ink" size="sm" className="w-full" onClick={applyCustom}>
              Apply
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
