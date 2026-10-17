"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Braces, ChevronDown, ChevronUp, Layers, Maximize2, MessageCircleQuestion, Minimize2, Minus, Plus, Volume2, X } from "lucide-react";
import { MediaPickerModal } from "@/components/MediaPickerModal";
import { Button } from "@/components/ui/button";
import { GenerateButton } from "@/components/ui/generate-button";
import { Kbd } from "@/components/ui/kbd";
import { Segmented } from "@/components/ui/segmented";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { imageFilesFromClipboard } from "@/lib/clipboardImages";
import { thumbSrc } from "@/lib/galleryUtils";
import { PROVIDERS, modelHasProviderChoice, setModelProvider, type ProviderId } from "@/lib/providers";
import { setUiPref, useUiPref } from "@/lib/uiPrefs";
import { cn } from "@/lib/utils";
import { askAboutDraft } from "./askAssistant";
import { AspectRatioPicker } from "./AspectRatioPicker";
import { DurationPicker } from "./DurationPicker";
import { ElementPickerModal } from "./ElementPickerModal";
import { ModelPicker } from "./ModelPicker";
import { OptionPicker, QualityIcon } from "./OptionPicker";
import { PromptEditor } from "./PromptEditor";
import { ProviderBackendIcon } from "./ProviderIcon";
import { ReferenceStrip } from "./ReferenceStrip";
import type { ComposerState, PickerTarget, VidTarget } from "./useComposer";

/**
 * The prompt box: a raised paper sheet floating over the bottom of the grid.
 * References on top, the prompt in the middle, a row of quiet pickers and the
 * one primary action (Generate, ⌘↵) at the bottom. Typing is never blocked —
 * generations run in the background (see generationStore). It can be folded
 * into a one-line pill (⌘.) that remembers the choice; the draft is untouched.
 */
export function Composer({ c, hidden }: { c: ComposerState; hidden: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [picker, setPicker] = useState<{ target: PickerTarget; kind: "image" | "video" } | null>(null);
  const [elementsOpen, setElementsOpen] = useState(false);
  const [preview, setPreview] = useState<{ url: string; mediaKind: "image" | "video" } | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const vidImageInput = useRef<HTMLInputElement>(null);
  const vidVideoInput = useRef<HTMLInputElement>(null);
  const vidAudioInput = useRef<HTMLInputElement>(null);
  const vidTarget = useRef<VidTarget | null>(null);
  const collapsed = useUiPref("composerCollapsed", false);
  // Opened from the pill: Esc on a still-empty composer folds it back.
  const reopenedFromPill = useRef(false);

  const setCollapsed = (next: boolean) => {
    setUiPref("composerCollapsed", next);
    reopenedFromPill.current = !next;
    if (next) { setExpanded(false); return; }
    requestAnimationFrame(() => rootRef.current?.querySelector("textarea")?.focus());
  };

  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === "." && !e.shiftKey) {
        e.preventDefault();
        setCollapsed(!collapsed);
      } else if (e.key.toLowerCase() === "k" && e.shiftKey) {
        e.preventDefault();
        askAboutDraft(c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed, hidden, c]);

  // Collapse the expanded sheet on an outside click (popups and overlays don't count).
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-composer-popup], [data-element-picker-modal], [data-at-menu], [data-composer-overlay]")) return;
      if (rootRef.current && !rootRef.current.contains(t)) setExpanded(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [expanded]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPreview(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  const pickFrom = (target: VidTarget, kind: "image" | "video" | "audio") => {
    vidTarget.current = target;
    (kind === "image" ? vidImageInput : kind === "video" ? vidVideoInput : vidAudioInput).current?.click();
  };

  const vm = c.vidModel;
  const pickerSelected = picker?.target === "refImage" ? c.refImages
    : picker?.target === "resource" ? c.vidResources
    : picker?.target === "referenceVideo" ? c.vidRefVideos
    : null;
  const pickerMax = picker?.target === "refImage" ? c.maxImgs
    : picker?.target === "resource" || picker?.target === "referenceVideo" ? c.vidSlotLimit(picker.target)
    : undefined;
  const promptCount = c.multiPromptMode ? c.prompt.split(/\n\n+/).filter(p => p.trim()).length : 0;

  return (
    <>
      <div
        ref={rootRef}
        onDragOver={e => {
          if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; }
        }}
        onDrop={e => {
          if (e.dataTransfer.files?.length) { e.preventDefault(); e.stopPropagation(); c.addFiles(e.dataTransfer.files); }
        }}
        onPaste={e => {
          const files = imageFilesFromClipboard(e.clipboardData);
          if (files.length === 0) return;
          e.preventDefault();
          c.addFiles(files);
        }}
        onKeyDown={e => {
          // Only keys from the composer itself, not from popups portalled out of it.
          if (e.key !== "Escape" || !reopenedFromPill.current || c.hasContent || expanded) return;
          if (!rootRef.current?.contains(e.target as Node)) return;
          setCollapsed(true);
        }}
        aria-hidden={hidden || undefined}
        className={cn(
          "absolute left-1/2 z-[200] flex -translate-x-1/2 flex-col transition-[transform,opacity,width,height,bottom] duration-300 ease-[var(--ease-out)]",
          expanded ? "bottom-6 h-[calc(100%-48px)] w-[min(1100px,calc(100%-48px))]"
            : collapsed ? "bottom-6 w-[min(560px,calc(100%-32px))]"
            : "bottom-6 w-[min(860px,calc(100%-32px))]",
          hidden && !expanded && "pointer-events-none translate-y-[calc(100%+40px)] opacity-0",
        )}
      >
        {collapsed ? (
          <ComposerPill c={c} onExpand={() => setCollapsed(false)} />
        ) : (
        <div
          className={cn(
            "animate-in fade-in-0 slide-in-from-bottom-1 relative flex flex-col rounded-[var(--radius-xl)] bg-surface-raised shadow-[var(--shadow-md)] duration-200",
            expanded && "h-full",
          )}
        >
          {/* Top-right: clear, expand, minimize */}
          <div className="absolute top-2.5 right-2.5 z-10 flex items-center gap-0.5">
            {c.hasContent && (
              <Button variant="ghost" size="icon-sm" aria-label="Clear prompt and references" title="Clear prompt and references" onClick={c.clearAll}>
                <X />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={expanded ? "Collapse prompt" : "Expand prompt"}
              title={expanded ? "Collapse prompt" : "Expand prompt"}
              onClick={() => setExpanded(v => !v)}
            >
              {expanded ? <Minimize2 /> : <Maximize2 />}
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="Minimize composer" onClick={() => setCollapsed(true)}>
                    <ChevronDown />
                  </Button>
                }
              />
              <TooltipContent>
                Minimize <Kbd>⌘.</Kbd>
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="max-h-[200px] shrink-0 overflow-y-auto pr-[84px]">
            <ReferenceStrip
              c={c}
              onOpenPicker={(target, kind) => setPicker({ target, kind })}
              onPickAudio={target => pickFrom(target, "audio")}
              onOpenElements={() => setElementsOpen(true)}
              onPreview={setPreview}
            />
          </div>

          <div className={cn("flex flex-col gap-2.5 px-4 pt-3.5 pb-3", expanded && "min-h-0 flex-1")}>
            {c.multiPromptMode && (
              <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                <span className="size-1.5 rounded-full bg-lapis" />
                Multi · <span className="text-ink-2 tabular-nums">{promptCount} prompt{promptCount === 1 ? "" : "s"}</span>
                <span className="text-ink-4">· a blank line starts the next one</span>
              </div>
            )}
            <div className={cn("pr-[68px]", expanded && "flex min-h-0 flex-1 flex-col")}>
              <PromptEditor c={c} expanded={expanded} anchorRef={rootRef} onFiles={c.addFiles} />
            </div>

            {/* Controls */}
            <div className={cn("flex items-end gap-3 border-t border-rule pt-2.5", expanded ? "mt-auto" : "mt-1")}>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
                <ModelPicker models={c.models} value={c.modelId} onChange={c.selectModel} />

                {modelHasProviderChoice(c.modelId) && (
                  <OptionPicker
                    aria-label="Backend"
                    value={c.providerId}
                    onChange={v => setModelProvider(c.modelId, v as ProviderId)}
                    options={PROVIDERS.map(p => ({ value: p.id, label: p.label, icon: <ProviderBackendIcon id={p.id} /> }))}
                  />
                )}

                {c.supportsQuality && (
                  <OptionPicker
                    aria-label="Quality"
                    value={c.quality}
                    onChange={c.setQuality}
                    icon={<QualityIcon />}
                    options={c.qualityOpts.map(q => ({ value: q, label: q.toUpperCase() }))}
                  />
                )}

                {c.azureResolutionOpts.length > 0 && (
                  <OptionPicker
                    aria-label="Resolution"
                    value={c.azureResolution}
                    onChange={c.setAzureResolution}
                    icon={<QualityIcon />}
                    options={c.azureResolutionOpts.map(r => ({ value: r, label: r.toUpperCase() }))}
                  />
                )}

                {c.ratios.length > 0 && (
                  <AspectRatioPicker
                    value={c.aspectRatio}
                    onChange={c.setAspectRatio}
                    ratios={c.ratios}
                    allowCustom={c.isAzureProvider && c.azureResolutionOpts.length > 0}
                    customWidth={c.azureCustomWidth}
                    customHeight={c.azureCustomHeight}
                    onApplyCustom={c.setAzureCustom}
                  />
                )}

                {c.isVideo && (vm?.durations.length ?? 0) > 0 && (
                  <DurationPicker value={c.duration} durations={vm!.durations} onChange={c.setDuration} />
                )}

                {c.isVideo && (vm?.modes?.length ?? 0) > 0 && (
                  <OptionPicker aria-label="Mode" value={c.mode} onChange={c.setMode} options={vm!.modes!.map(m => ({ value: m.value, label: m.label }))} />
                )}

                {c.isVideo && (vm?.resolutions?.length ?? 0) > 0 && (
                  <OptionPicker
                    aria-label="Video resolution"
                    value={c.resolution || vm!.defaultResolution!}
                    onChange={c.setResolution}
                    options={vm!.resolutions!.map(r => ({ value: r, label: r }))}
                  />
                )}

                {c.isVideo && vm?.sound && (
                  <ToggleChip pressed={c.sound} onClick={() => c.setSound(s => !s)} icon={<Volume2 />}>Sound</ToggleChip>
                )}

                {c.isVideo && (c.modelId === "veo3" || c.modelId === "veo3_fast") && (
                  <Segmented
                    size="sm"
                    aria-label="Veo input"
                    className="mx-1"
                    value={c.veoMode}
                    onChange={c.setVeoMode}
                    options={[{ value: "frames", label: "Frames" }, { value: "references", label: "References" }]}
                  />
                )}

                {c.isVideo && vm?.supportsSeeds && (
                  <label className="flex h-7 items-center gap-1.5 rounded-[var(--radius)] px-2.5 text-[12.5px] text-ink-2 hover:bg-wash">
                    Seed
                    <input
                      type="number"
                      min={0}
                      max={2147483647}
                      value={c.seed}
                      onChange={e => c.setSeed(e.target.value === "" ? 0 : Math.max(0, Math.min(2147483647, parseInt(e.target.value, 10) || 0)))}
                      className="w-[72px] [appearance:textfield] bg-transparent text-right text-ink tabular-nums outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  </label>
                )}

                {!c.isVideo && !c.multiPromptMode && (
                  <div className="flex h-7 items-center rounded-[var(--radius)]" role="group" aria-label="Number of images">
                    <Button variant="ghost" size="icon-sm" aria-label="Fewer images" disabled={c.count <= 1} onClick={() => c.setCount(n => Math.max(1, n - 1))}>
                      <Minus />
                    </Button>
                    <span className="min-w-[30px] text-center text-[12.5px] text-ink tabular-nums">{c.count}/{c.maxImageCount}</span>
                    <Button variant="ghost" size="icon-sm" aria-label="More images" disabled={c.count >= c.maxImageCount} onClick={() => c.setCount(n => Math.min(c.maxImageCount, n + 1))}>
                      <Plus />
                    </Button>
                  </div>
                )}

                <ToggleChip
                  pressed={c.multiPromptMode}
                  icon={<Layers />}
                  title="One generation per paragraph"
                  onClick={() => c.setMultiPromptMode(m => !m)}
                >
                  Multi
                </ToggleChip>

                <ToggleChip
                  pressed={c.promptTextMode !== "text"}
                  icon={<Braces />}
                  title="Structured prompt (JSON or YAML)"
                  onClick={() => {
                    if (c.promptTextMode !== "text") { c.setPromptTextMode("text"); return; }
                    try {
                      c.setPrompt(JSON.stringify(JSON.parse(c.prompt), null, 2));
                      c.setPromptTextMode("json");
                    } catch {
                      c.setPromptTextMode(/^(\s*[\w\-./]+\s*:|---|\s*-\s)/m.test(c.prompt) ? "yaml" : "json");
                    }
                  }}
                >
                  {c.promptTextMode === "yaml" ? "YAML" : "JSON"}
                </ToggleChip>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-ink-3"
                        aria-label="Ask the assistant about this draft"
                        onClick={() => askAboutDraft(c)}
                      />
                    }
                  >
                    <MessageCircleQuestion />
                  </TooltipTrigger>
                  <TooltipContent>
                    Not sure? Talk it through with the assistant <Kbd>⇧⌘K</Kbd>
                  </TooltipContent>
                </Tooltip>
                {c.promptMaxLength !== null && !c.multiPromptMode && (
                  <span aria-hidden className={cn("text-[11.5px] tabular-nums", c.promptOverLimit ? "text-sanguine" : "text-ink-4")}>
                    {c.prompt.length.toLocaleString()}/{c.promptMaxLength.toLocaleString()}
                  </span>
                )}
                <GenerateButton
                  onClick={c.generate}
                  disabled={!c.canGenerate}
                  blockedReason={c.blockedReason ?? undefined}
                  outcome={generateOutcome(c)}
                  shortcut="⌘↵"
                />
              </div>
            </div>
          </div>
        </div>
        )}
      </div>

      <input ref={imageInput} type="file" accept="image/*" multiple hidden
        onChange={e => { if (e.target.files) { c.handleFilePick(e.target.files); e.target.value = ""; } }} />
      <input ref={vidImageInput} type="file" accept="image/*" multiple hidden
        onChange={e => { if (e.target.files && vidTarget.current) { c.handleVidFilePick(e.target.files, vidTarget.current); e.target.value = ""; } }} />
      <input ref={vidVideoInput} type="file" accept="video/*" multiple hidden
        onChange={e => { if (e.target.files && vidTarget.current) { c.handleVidFilePick(e.target.files, vidTarget.current); e.target.value = ""; } }} />
      <input ref={vidAudioInput} type="file" accept="audio/*" multiple hidden
        onChange={e => { if (e.target.files && vidTarget.current) { c.handleVidFilePick(e.target.files, vidTarget.current); e.target.value = ""; } }} />

      <MediaPickerModal
        open={!!picker}
        mediaKind={picker?.kind ?? "image"}
        anchorRef={rootRef}
        onClose={() => setPicker(null)}
        onPickUrl={url => {
          if (!picker) return;
          const multi = picker.target === "refImage" || picker.target === "resource" || picker.target === "referenceVideo";
          if (!multi) setPicker(null);
          if (picker.target === "refImage") c.addReference(url);
          else c.addVidRefUrl(picker.target, url);
        }}
        onDeselect={url => { if (picker) c.removeByUrl(picker.target, url); }}
        onUpload={() => {
          if (!picker) return;
          setPicker(null);
          if (picker.target === "refImage") imageInput.current?.click();
          else pickFrom(picker.target, picker.kind);
        }}
        onDropFiles={files => {
          if (!picker) return;
          if (picker.target === "refImage") c.handleFilePick(files);
          else c.handleVidFilePick(files, picker.target);
          setPicker(null);
        }}
        selectedUrls={pickerSelected?.filter(r => r.cdnUrl).map(r => r.cdnUrl!)}
        maxCount={pickerMax}
      />

      <ElementPickerModal
        open={elementsOpen}
        attached={c.vidElements}
        onClose={() => setElementsOpen(false)}
        onAttach={el => {
          c.setVidElements(prev => (prev.some(e => e.id === el.id) ? prev : [...prev, el]));
          setElementsOpen(false);
        }}
      />

      {preview && createPortal(
        <div
          data-composer-overlay=""
          onClick={() => setPreview(null)}
          className="animate-in fade-in-0 fixed inset-0 z-[99000] flex items-center justify-center bg-[var(--scrim)] backdrop-blur-[2px] duration-150"
        >
          <div onClick={e => e.stopPropagation()} className="animate-in zoom-in-95 relative overflow-hidden rounded-[var(--radius-lg)] bg-mat shadow-[var(--shadow-lg)] duration-200">
            {preview.mediaKind === "video" ? (
              <video src={preview.url} controls autoPlay className="block max-h-[90vh] max-w-[90vw]" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview.url} alt="" className="block max-h-[90vh] max-w-[90vw] object-contain" />
            )}
            <button
              type="button"
              aria-label="Close preview"
              onClick={() => setPreview(null)}
              className="on-media absolute top-2.5 right-2.5 flex size-8 items-center justify-center rounded-full"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function ToggleChip({
  pressed, onClick, icon, title, children,
}: {
  pressed: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className="aria-pressed:bg-lapis-soft aria-pressed:text-lapis"
    >
      {icon}
      {children}
    </Button>
  );
}

/**
 * The minimized composer: one line of raised paper with the draft's opening
 * words, any attached references and the model. Clicking it (or ⌘.) opens the
 * full composer; Generate stays reachable when there's a draft.
 */
function ComposerPill({ c, onExpand }: { c: ComposerState; onExpand: () => void }) {
  const draft = c.prompt.replace(/\s+/g, " ").trim().slice(0, 140);
  const refs = (c.isVideo ? [c.vidStartFrame, c.vidEndFrame, ...c.vidResources] : c.refImages).filter(r => r !== null);
  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex h-12 items-center gap-1 rounded-[var(--radius-xl)] bg-surface-raised p-1.5 shadow-[var(--shadow-md)] duration-200">
      <button
        type="button"
        onClick={onExpand}
        aria-label="Open composer"
        className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-lg)] pr-2 pl-3 text-left outline-none transition-colors duration-150 hover:bg-wash focus-visible:shadow-[var(--focus-ring)]"
      >
        {refs.length > 0 && (
          <span aria-hidden className="flex shrink-0 -space-x-2">
            {refs.slice(0, 3).map(r => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={r.id}
                src={thumbSrc(r.objectUrl, 48)}
                alt=""
                className={cn("size-6 rounded-[var(--radius-xs)] object-cover shadow-[0_0_0_1.5px_var(--surface-raised)]", r.uploading && "opacity-60")}
              />
            ))}
          </span>
        )}
        <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", draft ? "text-ink" : "text-ink-4")}>
          {draft || "Describe what to make…"}
        </span>
        <span className="shrink-0 text-[12px] text-ink-3">{c.activeModel.name}</span>
      </button>
      {c.hasContent && (
        <GenerateButton
          onClick={c.generate}
          disabled={!c.canGenerate}
          blockedReason={c.blockedReason ?? undefined}
          outcome={generateOutcome(c)}
        />
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Expand composer" onClick={onExpand}>
              <ChevronUp />
            </Button>
          }
        />
        <TooltipContent>
          Expand <Kbd>⌘.</Kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** What one click makes, after the verb: "image", "4 images", "video". */
function generateOutcome(c: ComposerState): string {
  const n = Math.max(1, c.generationCount);
  const noun = c.isVideo ? "video" : "image";
  return n === 1 ? noun : `${n} ${noun}s`;
}
