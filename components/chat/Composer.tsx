"use client";

import { useLayoutEffect, type RefObject } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useWorkflowStore } from "@/lib/store";
import type { ModelId } from "@/lib/models";
import { cn } from "@/lib/utils";
import { ModelPicker, useModelReady } from "./ModelPicker";

/**
 * Prompt box (DESIGN.md § Composer). The textarea is never disabled: while a
 * reply streams you can keep writing, and the send button becomes Stop.
 * ↵ or ⌘↵ sends, ⇧↵ adds a line.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  streaming,
  model,
  onModelChange,
  placeholder,
  textareaRef,
  compact = false,
  pickerSide = "top",
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  streaming: boolean;
  model: ModelId;
  onModelChange: (id: ModelId) => void;
  placeholder?: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  compact?: boolean;
  pickerSide?: "top" | "bottom";
  autoFocus?: boolean;
}) {
  const { ready } = useModelReady(model);
  const setSettingsOpen = useWorkflowStore((s) => s.setSettingsOpen);
  const canSend = !streaming && !!value.trim() && ready !== false;
  const maxHeight = compact ? 120 : 220;

  // Grow with content, including when the value is restored programmatically.
  useLayoutEffect(() => {
    const t = textareaRef.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight, textareaRef]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && streaming) {
      e.preventDefault();
      e.stopPropagation();
      onStop();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (canSend) onSubmit();
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "flex flex-col bg-surface-raised shadow-[var(--shadow-md)] transition-shadow duration-150 focus-within:shadow-[var(--shadow-md),var(--focus-ring)]",
          compact ? "rounded-[var(--radius-lg)]" : "rounded-[var(--radius-xl)]",
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          autoFocus={autoFocus}
          aria-label="Message"
          className={cn(
            "w-full resize-none bg-transparent text-ink outline-none placeholder:text-ink-4 focus-visible:shadow-none!",
            compact ? "px-3.5 pt-3 pb-1 text-[14px] leading-[22px]" : "px-4.5 pt-4 pb-1.5 text-[15px] leading-6",
          )}
          style={{ maxHeight }}
        />
        <div className={cn("flex items-center gap-2", compact ? "px-2 pb-2" : "px-2.5 pb-2.5")}>
          <ModelPicker model={model} onChange={onModelChange} side={pickerSide} />
          <div className="ml-auto flex items-center gap-2">
            {!compact && !streaming && (
              <span className="hidden text-[11.5px] text-ink-4 sm:inline">⇧↵ new line</span>
            )}
            {streaming ? (
              <Button variant="outline" size="sm" onClick={onStop} aria-label="Stop the reply">
                <Square className="size-3 fill-current" />
                Stop
                <Kbd>esc</Kbd>
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={onSubmit} disabled={!canSend} aria-label="Send">
                <ArrowUp />
                Send
                <Kbd>↵</Kbd>
              </Button>
            )}
          </div>
        </div>
      </div>
      {ready === false && (
        <p className="px-1 text-[12px] text-ink-3">
          <span className="mr-1.5 inline-block size-1.5 rounded-full bg-ochre align-middle" />
          {model === "azure-auto" ? "Add your Azure key" : "Add your kie.ai key"} in{" "}
          <button type="button" className="text-lapis underline-offset-4 hover:underline" onClick={() => setSettingsOpen(true, "api-keys")}>
            Settings
          </button>{" "}
          to send. Your message is kept.
        </p>
      )}
    </div>
  );
}
