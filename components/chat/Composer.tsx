"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { AlertCircle, ArrowUp, Paperclip, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkflowStore } from "@/lib/store";
import { imageFilesFromClipboard } from "@/lib/clipboardImages";
import { keyProviderFor, type ModelId } from "@/lib/models";
import { cn } from "@/lib/utils";
import { AGENT_STATUS_PHRASE, HintText, ModelPicker, useModelReady } from "./ModelPicker";
import type { ImageAttachment, ImageAttachments } from "./useImageAttachments";

/** Removable thumbnails of the images riding along with the draft. */
function AttachmentChips({
  items,
  onRemove,
  compact,
}: {
  items: ImageAttachment[];
  onRemove: (id: string) => void;
  compact: boolean;
}) {
  return (
    <div className={cn("flex flex-wrap gap-2", compact ? "px-2.5 pt-2.5" : "px-3.5 pt-3.5")}>
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            "group/chip relative shrink-0 overflow-hidden rounded-[var(--radius-sm)] bg-mat duration-150 ease-[var(--ease-out)] animate-in fade-in-0 zoom-in-95",
            compact ? "size-12" : "size-14",
            item.status === "failed" && "shadow-[inset_0_0_0_1.5px_var(--sanguine)]",
          )}
          title={item.status === "failed" ? "Couldn't attach this image" : undefined}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- object URLs and local files */}
          <img
            src={item.src}
            alt="Attached image"
            className={cn(
              "size-full object-cover transition-opacity duration-200",
              item.status === "uploading" && "animate-pulse opacity-55",
              item.status === "failed" && "opacity-40",
            )}
          />
          {item.status === "failed" && (
            <AlertCircle className="absolute top-1/2 left-1/2 size-4 -translate-x-1/2 -translate-y-1/2 text-sanguine" />
          )}
          {item.status === "uploading" && <span className="sr-only">Uploading</span>}
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            aria-label="Remove image"
            className={cn(
              "absolute top-1 right-1 inline-flex size-[18px] items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md transition-opacity duration-150 focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] group-hover/chip:opacity-100",
              item.status === "failed" ? "opacity-100" : "opacity-0",
            )}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

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
  attachments,
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
  /** Images riding along with the message: paste, drop, or the paperclip add them. */
  attachments?: ImageAttachments;
}) {
  const { ready, acp } = useModelReady(model);
  const setSettingsOpen = useWorkflowStore((s) => s.setSettingsOpen);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const hasContent = !!value.trim() || !!attachments?.urls.length;
  const canSend = !streaming && hasContent && !attachments?.uploading && ready !== false;
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

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!attachments) return;
    const files = imageFilesFromClipboard(e.clipboardData);
    if (files.length === 0) return; // plain text: let the browser paste it
    e.preventDefault();
    attachments.add(files);
  }

  const carriesFiles = (e: React.DragEvent) => !!attachments && e.dataTransfer.types.includes("Files");

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "flex flex-col bg-surface-raised shadow-[var(--shadow-md)] transition-shadow duration-150 focus-within:shadow-[var(--shadow-md),var(--focus-ring)]",
          compact ? "rounded-[var(--radius-lg)]" : "rounded-[var(--radius-xl)]",
          dragging && "shadow-[var(--shadow-md),var(--focus-ring)]",
        )}
        onDragOver={(e) => {
          if (!carriesFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!carriesFiles(e)) return;
          e.preventDefault();
          setDragging(false);
          attachments?.add(Array.from(e.dataTransfer.files));
          textareaRef.current?.focus();
        }}
      >
        {attachments && attachments.items.length > 0 && (
          <AttachmentChips items={attachments.items} onRemove={attachments.remove} compact={compact} />
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
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
          {attachments && (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-ink-3"
                      aria-label="Attach images"
                      onClick={() => fileInputRef.current?.click()}
                    />
                  }
                >
                  <Paperclip />
                </TooltipTrigger>
                <TooltipContent>
                  Attach images
                  <Kbd>⌘V</Kbd>
                </TooltipContent>
              </Tooltip>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                hidden
                onChange={(e) => {
                  attachments.add(Array.from(e.target.files ?? []));
                  e.target.value = "";
                  textareaRef.current?.focus();
                }}
              />
            </>
          )}
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
          {acp ? (
            <>
              {!acp.agent
                ? `${acp.agentId} isn't available on this computer. `
                : acp.agent.status === "ready"
                  ? `${acp.agent.name} no longer offers “${acp.modelValue}”. Pick another model to send. `
                  : `${acp.agent.name} · ${AGENT_STATUS_PHRASE[acp.agent.status]}. `}
              {acp.agent && acp.agent.status !== "ready" && acp.agent.setupHint && (
                <>
                  <HintText text={acp.agent.setupHint} />{" "}
                </>
              )}
              Your message is kept.{" "}
              <button type="button" className="text-lapis underline-offset-4 hover:underline" onClick={() => setSettingsOpen(true, "subscriptions")}>
                Manage subscriptions
              </button>
            </>
          ) : (
            <>
              {keyProviderFor(model) === "azure" ? "Add your Azure key" : "Add your kie.ai key"} in{" "}
              <button type="button" className="text-lapis underline-offset-4 hover:underline" onClick={() => setSettingsOpen(true, "api-keys")}>
                Settings
              </button>{" "}
              to send. Your message is kept.
            </>
          )}
        </p>
      )}
    </div>
  );
}
