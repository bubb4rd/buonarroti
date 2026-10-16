"use client";

import * as React from "react";
import { Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PickerChevron } from "./OptionPicker";

export interface DurationPickerProps {
  value: number;
  /** Allowed lengths in seconds, ascending. */
  durations: number[];
  onChange: (n: number) => void;
  disabled?: boolean;
}

/** −/+ stepper around a pill that opens a slider over the model's allowed durations. */
export function DurationPicker({ value, durations, onChange, disabled }: DurationPickerProps) {
  const index = Math.max(0, durations.indexOf(value));
  const atMin = index <= 0;
  const atMax = index >= durations.length - 1;

  return (
    <div className="flex shrink-0 items-center">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Shorter"
        disabled={disabled || atMin}
        onClick={e => { e.stopPropagation(); if (!atMin) onChange(durations[index - 1]); }}
      >
        <Minus aria-hidden />
      </Button>
      <Popover>
        <PopoverTrigger
          disabled={disabled}
          aria-label={`Duration: ${value} seconds`}
          render={<Button variant="ghost" size="sm" className="gap-1 px-2" />}
        >
          <span className="tabular-nums">{value}s</span>
          <PickerChevron />
        </PopoverTrigger>
        <PopoverContent side="top" data-composer-popup="" className="w-[240px] p-3">
          <p className="type-label mb-2">Duration</p>
          <div className="flex items-center gap-2.5 rounded-[var(--radius)] bg-wash px-3 py-2">
            <span className="min-w-7 text-[12px] text-ink-2 tabular-nums">{value}s</span>
            <span aria-hidden className="h-3.5 w-px shrink-0 bg-rule-strong" />
            <input
              type="range"
              aria-label="Duration"
              aria-valuetext={`${value} seconds`}
              min={0}
              max={durations.length - 1}
              step={1}
              value={index}
              disabled={disabled}
              onChange={e => onChange(durations[parseInt(e.target.value)])}
              className="h-1 min-w-0 flex-1 cursor-pointer accent-lapis disabled:cursor-not-allowed"
            />
          </div>
        </PopoverContent>
      </Popover>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Longer"
        disabled={disabled || atMax}
        onClick={e => { e.stopPropagation(); if (!atMax) onChange(durations[index + 1]); }}
      >
        <Plus aria-hidden />
      </Button>
    </div>
  );
}
