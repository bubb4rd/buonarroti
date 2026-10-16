"use client";

import { ChevronDown } from "lucide-react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { MODEL_GROUPS, MODELS, type ModelId } from "@/lib/models";
import { useWorkflowStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Whether the chosen chat model has the key it needs. `null` = still checking. */
export function useModelReady(model: ModelId): { ready: boolean | null; azureReady: boolean } {
  const kieKeySet = useWorkflowStore((s) => s.kieKeySet);
  const azureKeySet = useWorkflowStore((s) => s.azureKeySet);
  return {
    ready: model === "azure-auto" ? azureKeySet : kieKeySet,
    azureReady: azureKeySet === true,
  };
}

export function ModelPicker({
  model,
  onChange,
  side = "top",
  className,
}: {
  model: ModelId;
  onChange: (id: ModelId) => void;
  side?: "top" | "bottom";
  className?: string;
}) {
  const { azureReady } = useModelReady(model);
  const current = MODELS.find((m) => m.id === model);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" className={cn("gap-1 text-ink-2", className)} />}
        aria-label="Choose model"
      >
        {current?.label ?? "Choose model"}
        <ChevronDown className="size-3 text-ink-3" />
      </DropdownMenuTrigger>
      {/* Own positioner so the menu layers above the ⌘K panel (z-[1001]). */}
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner className="isolate z-[1100] outline-none" side={side} align="start" sideOffset={6}>
          <MenuPrimitive.Popup className="max-h-(--available-height) min-w-[230px] origin-(--transform-origin) overflow-y-auto rounded-[var(--radius)] bg-surface-raised p-1 text-ink shadow-[var(--shadow-lg)] outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0">
            <DropdownMenuRadioGroup value={model} onValueChange={(v) => onChange(String(v))}>
              {MODEL_GROUPS.map((group, gi) => (
                <DropdownMenuGroup key={group.label}>
                  {gi > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="text-[11.5px] font-normal text-ink-3">{group.label}</DropdownMenuLabel>
                  {group.models.map((m) => {
                    const needsKey = m.id === "azure-auto" && !azureReady;
                    return (
                      <DropdownMenuRadioItem key={m.id} value={m.id} disabled={needsKey} className="gap-3 text-[13px]">
                        <span className="text-ink">{m.label}</span>
                        <span className="ml-auto text-[11.5px] text-ink-3">{needsKey ? "Needs Azure key" : m.desc}</span>
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuGroup>
              ))}
            </DropdownMenuRadioGroup>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </DropdownMenu>
  );
}
