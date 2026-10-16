"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { thumbSrc } from "@/lib/galleryUtils";
import { cn } from "@/lib/utils";
import { renderGalleryMentions, syntaxHighlightJson, syntaxHighlightYaml } from "./mentions";
import type { ComposerState, MentionableAsset } from "./useComposer";
import type { TaggedImage } from "./types";

/**
 * The prompt field. A transparent textarea carries the caret and selection;
 * an overlay underneath paints the same text with @mention chips and JSON/YAML
 * highlighting. Multi mode splits the prompt on blank lines into a stack of
 * one-line rows, each submitted as its own generation.
 */

const TEXT = "text-[15px] leading-[23px]";
const COLLAPSED_MAX_H = 264;

/** Collapses runs of empty blocks to at most one. */
function splitBlocks(prompt: string): string[] {
  return prompt.split(/\n\n+/).reduce<string[]>((acc, b) => (!b.trim() && acc.some(x => !x.trim()) ? acc : [...acc, b]), []);
}

function autoSize(el: HTMLTextAreaElement, maxH: number) {
  const st = el.scrollTop;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
  el.scrollTop = st;
}

export function PromptEditor({
  c,
  expanded,
  anchorRef,
  onFiles,
}: {
  c: ComposerState;
  expanded: boolean;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onFiles: (files: FileList) => void;
}) {
  const { prompt, setPrompt, promptTextMode, multiPromptMode, taggedImages, promptMaxLength } = c;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const activeBlock = useRef<{ el: HTMLTextAreaElement; idx: number } | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [chipPreview, setChipPreview] = useState<{ tag: TaggedImage; rect: DOMRect } | null>(null);
  const [openBlock, setOpenBlock] = useState<number | null>(null);

  const mentions = mentionQuery === null ? [] : c.mentionableAssets.slice(0, 8);
  const menuOpen = mentions.length > 0 && anchorRect !== null;
  const selected = Math.min(mentionIdx, mentions.length - 1);

  // Size the single textarea to its content (or fill the sheet when expanded).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || multiPromptMode) return;
    if (expanded) { el.style.height = "100%"; return; }
    autoSize(el, COLLAPSED_MAX_H);
    if (overlayRef.current) overlayRef.current.style.transform = el.scrollTop ? `translateY(-${el.scrollTop}px)` : "";
  }, [prompt, expanded, multiPromptMode, promptTextMode]);

  // Close the @ menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-at-menu]") && !t.closest("[data-prompt-input]")) setMentionQuery(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const trackMention = (ta: HTMLTextAreaElement) => {
    const match = ta.value.slice(0, ta.selectionStart ?? ta.value.length).match(/@(\w*)$/);
    const query = match ? match[1] : null;
    if (query !== null && mentionQuery === null) {
      setMentionIdx(0);
      setAnchorRect(anchorRef.current?.getBoundingClientRect() ?? null);
    }
    setMentionQuery(query);
  };

  const insertMention = (asset: MentionableAsset) => {
    const label = asset.label;
    if (!taggedImages.some(t => t.refId === asset.id)) {
      c.setTaggedImages(prev => [...prev, { label, refId: asset.id, url: asset.cdnUrl!, kind: c.isVideo ? asset.kind : "image" }]);
    }
    const splice = (text: string, cursor: number) => {
      const before = text.slice(0, cursor);
      const lastAt = before.lastIndexOf("@");
      const start = lastAt >= 0 ? lastAt : cursor;
      return { text: `${before.slice(0, start)}@${label} ${text.slice(cursor)}`, pos: start + label.length + 2 };
    };
    let el: HTMLTextAreaElement | null;
    let pos: number;
    if (multiPromptMode && activeBlock.current) {
      const { el: blockEl, idx } = activeBlock.current;
      const blocks = splitBlocks(prompt);
      if (idx >= blocks.length) return;
      const next = splice(blocks[idx], blockEl.selectionStart ?? blocks[idx].length);
      blocks[idx] = next.text;
      setPrompt(blocks.join("\n\n"));
      el = blockEl;
      pos = next.pos;
    } else {
      el = inputRef.current;
      const next = splice(prompt, el?.selectionStart ?? prompt.length);
      setPrompt(next.text);
      pos = next.pos;
    }
    setMentionQuery(null);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); });
  };

  const onMentionKeys = (e: React.KeyboardEvent): boolean => {
    if (!menuOpen) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx((selected + 1) % mentions.length); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx((selected - 1 + mentions.length) % mentions.length); return true; }
    if (e.key === "Enter") { e.preventDefault(); insertMention(mentions[selected]); return true; }
    if (e.key === "Escape") { setMentionQuery(null); return true; }
    return false;
  };

  const submitKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); c.generate(); return true; }
    return false;
  };

  const fileDrop = {
    onDragOver: (e: React.DragEvent) => {
      if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
    },
    onDrop: (e: React.DragEvent) => {
      if (e.dataTransfer.files?.length) { e.preventDefault(); e.stopPropagation(); onFiles(e.dataTransfer.files); }
    },
  };

  const handlers = {
    onEnter: (tag: TaggedImage, rect: DOMRect) => setChipPreview({ tag, rect }),
    onLeave: () => setChipPreview(null),
    onMouseDown: focusAfterMention,
  };

  const paint = (text: string) => {
    if (promptTextMode === "yaml") return syntaxHighlightYaml(text, taggedImages, handlers);
    if (promptTextMode === "json") return syntaxHighlightJson(text, taggedImages, handlers);
    return renderGalleryMentions(text, taggedImages, handlers);
  };

  const mono = promptTextMode !== "text";
  const placeholder = c.isVideo ? "Describe the video you imagine…" : "Describe the image you imagine…";

  return (
    <>
      {!multiPromptMode ? (
        <div data-prompt-field="" className={cn("relative min-h-0", expanded && "flex-1 overflow-hidden")}>
          <textarea
            ref={inputRef}
            data-prompt-input=""
            value={prompt}
            rows={1}
            spellCheck
            aria-label="Prompt"
            placeholder={placeholder}
            {...fileDrop}
            onChange={e => {
              setPrompt(e.target.value);
              trackMention(e.target);
            }}
            onSelect={e => trackMention(e.currentTarget)}
            onScroll={e => { if (overlayRef.current) overlayRef.current.style.transform = `translateY(-${e.currentTarget.scrollTop}px)`; }}
            onKeyDown={e => { if (!onMentionKeys(e)) submitKey(e); }}
            className={cn(
              "relative block w-full resize-none overflow-y-auto border-none bg-transparent p-0 text-transparent caret-[var(--lapis)] outline-none [scrollbar-width:none] placeholder:text-ink-4",
              TEXT,
              mono ? "font-mono text-[13.5px]" : "tracking-[-0.005em]",
              expanded ? "h-full" : "max-h-[264px]",
            )}
          />
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <div
              ref={overlayRef}
              className={cn("break-words whitespace-pre-wrap text-ink will-change-transform", TEXT, mono ? "font-mono text-[13.5px]" : "tracking-[-0.005em]")}
            >
              {promptMaxLength !== null && prompt.length > promptMaxLength && !mono ? (
                <>
                  {paint(prompt.slice(0, promptMaxLength))}
                  <span className="rounded-[2px] bg-sanguine/15 text-sanguine">{prompt.slice(promptMaxLength)}</span>
                </>
              ) : (
                paint(prompt)
              )}
            </div>
          </div>
        </div>
      ) : (
        <MultiPromptStack
          c={c}
          expanded={expanded}
          openBlock={openBlock}
          setOpenBlock={setOpenBlock}
          activeBlock={activeBlock}
          trackMention={trackMention}
          onMentionKeys={onMentionKeys}
          submitKey={submitKey}
          fileDrop={fileDrop}
          paint={paint}
          placeholder={placeholder}
        />
      )}

      {menuOpen && anchorRect && createPortal(
        <MentionMenu
          anchor={anchorRect}
          assets={mentions}
          selected={selected}
          onHover={setMentionIdx}
          onPick={insertMention}
          isVideo={c.isVideo}
        />,
        document.body,
      )}

      {chipPreview && createPortal(
        <div
          className="pointer-events-none fixed z-[99999] -translate-x-1/2"
          style={{
            left: Math.max(110, Math.min(chipPreview.rect.left + chipPreview.rect.width / 2, window.innerWidth - 110)),
            ...(chipPreview.rect.top > 190 ? { bottom: window.innerHeight - chipPreview.rect.top + 8 } : { top: chipPreview.rect.bottom + 8 }),
          }}
        >
          <div className="animate-in fade-in-0 zoom-in-95 overflow-hidden rounded-[var(--radius)] bg-mat shadow-[var(--shadow-lg)] duration-150">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={thumbSrc(chipPreview.tag.url, 256)} alt="" className="block h-auto max-h-40 w-auto max-w-[200px] object-contain" />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** Clicking a chip in the overlay puts the caret in its textarea, right after that mention. */
function focusAfterMention(tag: TaggedImage, chip: HTMLElement) {
  const ta = chip.closest("[data-prompt-field]")?.querySelector("textarea");
  if (!ta) return;
  const at = ta.value.indexOf(`@${tag.label}`);
  const pos = at >= 0 ? at + tag.label.length + 1 : ta.value.length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
}

function MultiPromptStack({
  c, expanded, openBlock, setOpenBlock, activeBlock, trackMention, onMentionKeys, submitKey, fileDrop, paint, placeholder,
}: {
  c: ComposerState;
  expanded: boolean;
  openBlock: number | null;
  setOpenBlock: React.Dispatch<React.SetStateAction<number | null>>;
  activeBlock: React.RefObject<{ el: HTMLTextAreaElement; idx: number } | null>;
  trackMention: (ta: HTMLTextAreaElement) => void;
  onMentionKeys: (e: React.KeyboardEvent) => boolean;
  submitKey: (e: React.KeyboardEvent) => boolean;
  fileDrop: { onDragOver: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void };
  paint: (text: string) => React.ReactNode;
  placeholder: string;
}) {
  const { prompt, setPrompt, promptMaxLength, promptTextMode } = c;
  const stackRef = useRef<HTMLDivElement>(null);
  const blocks = splitBlocks(prompt);
  const rowAt = (i: number) => stackRef.current?.querySelectorAll<HTMLTextAreaElement>("textarea")[i];
  const focusRow = (i: number, at: "start" | "end") => requestAnimationFrame(() => {
    const ta = rowAt(i);
    if (!ta) return;
    activeBlock.current = { el: ta, idx: i };
    ta.focus();
    const p = at === "start" ? 0 : ta.value.length;
    ta.setSelectionRange(p, p);
  });
  const mono = promptTextMode !== "text";
  let n = 0;

  return (
    <div
      ref={stackRef}
      className={cn("flex flex-col gap-1.5 overflow-y-auto [scrollbar-width:none]", expanded ? "max-h-[calc(75vh-220px)]" : "max-h-[204px]")}
    >
      {blocks.map((block, i) => {
        const filled = !!block.trim();
        const number = filled ? ++n : null;
        const open = openBlock === i;
        const over = promptMaxLength !== null && block.length > promptMaxLength;
        return (
          <div
            key={i}
            onClick={e => {
              const next = open ? null : i;
              setOpenBlock(next);
              if (next !== null) focusRow(i, "end");
              else { const row = e.currentTarget; requestAnimationFrame(() => row.scrollIntoView({ block: "nearest", behavior: "smooth" })); }
            }}
            className={cn(
              "group relative flex shrink-0 items-start gap-2 rounded-[var(--radius)] py-1.5 pr-7 pl-2.5 transition-colors duration-150",
              open ? "bg-lapis-soft/60 shadow-[inset_0_0_0_1px_rgb(var(--lapis-rgb)/0.25)]" : "cursor-pointer bg-wash shadow-[inset_0_0_0_1px_var(--rule)]",
              !filled && "opacity-50",
            )}
          >
            <span className={cn("min-w-[18px] shrink-0 font-mono text-[11px] leading-[22px] tabular-nums", filled ? "text-lapis" : "text-ink-4")}>
              {number !== null ? String(number).padStart(2, "0") : "—"}
            </span>
            <div data-prompt-field="" className="relative min-w-0 flex-1">
              <textarea
                value={block}
                rows={1}
                data-prompt-input=""
                aria-label={`Prompt ${number ?? i + 1}`}
                placeholder={i === 0 && !filled ? placeholder : undefined}
                {...fileDrop}
                onClick={e => { if (open) e.stopPropagation(); }}
                onFocus={e => { activeBlock.current = { el: e.currentTarget, idx: i }; trackMention(e.currentTarget); }}
                onSelect={e => trackMention(e.currentTarget)}
                onScroll={e => {
                  const overlay = e.currentTarget.parentElement?.querySelector<HTMLElement>("[data-block-overlay]");
                  if (overlay) overlay.style.transform = `translateY(-${e.currentTarget.scrollTop}px)`;
                }}
                onChange={e => {
                  const value = e.target.value;
                  trackMention(e.target);
                  if (value.includes("\n\n")) {
                    // A blank line starts a new prompt below.
                    const cut = value.indexOf("\n\n");
                    const next = splitBlocks([...blocks.slice(0, i), value.slice(0, cut), value.slice(cut + 2), ...blocks.slice(i + 1)].join("\n\n"));
                    setPrompt(next.join("\n\n"));
                    setOpenBlock(i + 1);
                    focusRow(i + 1, "start");
                  } else {
                    const next = [...blocks];
                    next[i] = value;
                    setPrompt(next.join("\n\n"));
                  }
                }}
                onKeyDown={e => {
                  if (onMentionKeys(e) || submitKey(e)) return;
                  if (e.key === "Enter" && !open) { e.preventDefault(); setOpenBlock(i); focusRow(i, "end"); return; }
                  if ((e.key === "Backspace" || e.key === "Delete") && !filled && blocks.length > 1) {
                    e.preventDefault();
                    setPrompt(blocks.filter((_, j) => j !== i).join("\n\n"));
                    const to = Math.max(0, i - 1);
                    setOpenBlock(to);
                    focusRow(to, "end");
                  }
                }}
                className={cn(
                  "block w-full resize-none border-none bg-transparent p-0 text-[13.5px] leading-[22px] text-transparent caret-[var(--lapis)] outline-none placeholder:text-ink-4",
                  mono && "font-mono",
                  open ? "max-h-[330px] overflow-y-auto [field-sizing:content] [scrollbar-width:none]" : "h-[22px] max-h-[22px] overflow-hidden whitespace-nowrap",
                )}
              />
              <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
                <div
                  data-block-overlay=""
                  className={cn("text-[13.5px] leading-[22px] break-words text-ink will-change-transform", mono && "font-mono", open ? "whitespace-pre-wrap" : "whitespace-nowrap")}
                >
                  {paint(block)}
                </div>
              </div>
            </div>
            {filled && promptMaxLength !== null && (
              <span className={cn("shrink-0 font-mono text-[10.5px] leading-[22px] tabular-nums", over ? "text-sanguine" : "text-ink-4", open && "absolute right-7 bottom-1.5")}>
                {block.length}/{promptMaxLength}
              </span>
            )}
            {blocks.length > 1 && (
              <button
                type="button"
                aria-label="Remove this prompt"
                onClick={e => {
                  e.stopPropagation();
                  setPrompt(blocks.filter((_, j) => j !== i).join("\n\n"));
                  setOpenBlock(prev => (prev === null || prev === i ? null : prev > i ? prev - 1 : prev));
                }}
                className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-[var(--radius-xs)] text-ink-4 transition-colors hover:bg-wash-strong hover:text-ink"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MentionMenu({
  anchor, assets, selected, onHover, onPick, isVideo,
}: {
  anchor: DOMRect;
  assets: MentionableAsset[];
  selected: number;
  onHover: (i: number) => void;
  onPick: (a: MentionableAsset) => void;
  isVideo: boolean;
}) {
  return (
    <div
      data-at-menu=""
      role="listbox"
      onMouseDown={e => e.preventDefault()}
      className="animate-in fade-in-0 slide-in-from-bottom-1 fixed z-[9999] flex flex-col overflow-hidden rounded-[var(--radius-lg)] bg-surface-raised shadow-[var(--shadow-lg)] duration-150"
      style={{ left: anchor.left, bottom: Math.max(8, window.innerHeight - anchor.top + 6), width: anchor.width, maxHeight: anchor.top - 16 }}
    >
      <div className="type-label border-b border-rule px-3 pt-2 pb-1.5">{isVideo ? "Mention a reference" : "Mention an image"}</div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {assets.map((a, i) => (
          <button
            key={a.id}
            type="button"
            role="option"
            aria-selected={i === selected}
            onClick={() => onPick(a)}
            onMouseEnter={() => onHover(i)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-[var(--radius)] px-2 py-1.5 text-left text-[13px] text-ink-2 transition-colors",
              i === selected && "bg-wash-strong text-ink",
            )}
          >
            {a.kind === "audio" ? (
              <span className="flex size-[30px] shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-mat text-[10px] text-ink-3">♪</span>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbSrc(a.objectUrl, 30)} alt="" className="size-[30px] shrink-0 rounded-[var(--radius-sm)] bg-mat object-cover" />
            )}
            <span className="min-w-0 flex-1 truncate">{a.role}</span>
            <span className="shrink-0 font-mono text-[11.5px] text-ink-3">@{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
