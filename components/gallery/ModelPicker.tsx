"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ImageModel, VideoModel } from "@/lib/modelConfig";
import { PickerChevron } from "./OptionPicker";
import { ProviderIcon } from "./ProviderIcon";

export type PickerModel = ImageModel | VideoModel;

export interface ModelPickerProps {
  models: ReadonlyArray<PickerModel>;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

function isVideoModel(m: PickerModel): m is VideoModel {
  return "durations" in m;
}

/** One-line summary built only from the model's real capabilities in lib/modelConfig. */
export function describeModel(m: PickerModel): string {
  if (!isVideoModel(m)) {
    const parts = [m.supportsImages && m.maxImages > 0 ? `Up to ${m.maxImages} references` : "Text only"];
    const q = m.apiInput.qualityOptions;
    if (q?.length) parts.push(q.map(o => o.toUpperCase()).join(" · "));
    return parts.join(" · ");
  }
  const parts: string[] = [];
  if (m.durations.length) {
    const min = Math.min(...m.durations);
    const max = Math.max(...m.durations);
    parts.push(min === max ? `${min}s` : `${min}–${max}s`);
  }
  const handles = m.handles;
  if (handles.includes("startFrame") && handles.includes("endFrame")) parts.push("Start and end frame");
  else if (handles.includes("startFrame")) parts.push("Start frame");
  if (handles.includes("resource")) parts.push(`${m.maxResources ?? 3} references`);
  if (handles.includes("referenceVideo")) parts.push("Video references");
  if (handles.includes("videoRef")) parts.push("Motion video");
  if (handles.includes("audioRef")) parts.push("Audio references");
  if (m.sound) parts.push("Sound");
  return parts.length ? parts.join(" · ") : "Text to video";
}

/** Model menu grouped by maker; opens upward from the composer. */
export function ModelPicker({ models, value, onChange, disabled }: ModelPickerProps) {
  const selected = models.find(m => m.id === value);

  const groups = React.useMemo(() => {
    const byProvider = new Map<string, PickerModel[]>();
    for (const m of models) {
      const list = byProvider.get(m.provider);
      if (list) list.push(m);
      else byProvider.set(m.provider, [m]);
    }
    return [...byProvider];
  }, [models]);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Model: ${selected?.name ?? value}`}
        render={<Button variant="ghost" size="sm" className="gap-1.5" />}
      >
        {selected && (
          <span className="flex items-center text-ink-3">
            <ProviderIcon provider={selected.provider} />
          </span>
        )}
        <span>{selected?.name ?? value}</span>
        <PickerChevron />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        sideOffset={6}
        data-composer-popup=""
        aria-label="Model"
        className="max-h-[min(60vh,var(--available-height))] w-[300px] rounded-[var(--radius-lg)]"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={v => onChange(v as string)}>
          {groups.map(([provider, list], i) => (
            <React.Fragment key={provider}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  <ProviderIcon provider={provider} />
                  {provider}
                </DropdownMenuLabel>
                {list.map(m => {
                  const description = describeModel(m);
                  return (
                    <DropdownMenuRadioItem key={m.id} value={m.id} label={m.name} title={description} closeOnClick className="py-1.5">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[13px] text-ink">{m.name}</span>
                        <span className="truncate text-[12px] text-ink-3">{description}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuGroup>
            </React.Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
