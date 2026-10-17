"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useWorkflowStore } from "@/lib/store";
import type { AssistantContext, StoredMessage } from "@/lib/chatSessionStore";
import type { LiveStream } from "@/lib/chatStreamingStore";
import { handOffPromptToComposer } from "@/components/gallery/composerDraft";
import { cn } from "@/lib/utils";
import { Markdown, fencedBlocks, toPlainText, type FenceRenderer } from "./Markdown";

function UserTurn({ message, compact }: { message: StoredMessage; compact: boolean }) {
  const [viewing, setViewing] = useState<string | null>(null);
  const images = message.images ?? [];
  return (
    <div className="flex flex-col items-end gap-1.5">
      {images.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {images.map((url, i) => (
            <button
              key={`${url}-${i}`}
              type="button"
              onClick={() => setViewing(url)}
              aria-label={`Open image ${i + 1}`}
              className={cn(
                "overflow-hidden rounded-[var(--radius-sm)] bg-mat shadow-[var(--shadow-sm)] transition-opacity duration-150 hover:opacity-90 focus-visible:shadow-[var(--focus-ring)]",
                compact ? "size-16" : "size-24",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- local /generated files */}
              <img src={url} alt="" loading="lazy" className="size-full object-cover" />
            </button>
          ))}
        </div>
      )}
      {message.content && (
        <div
          className={cn(
            "max-w-[85%] whitespace-pre-wrap break-words bg-surface-raised text-ink shadow-[var(--shadow-sm)]",
            compact
              ? "rounded-[var(--radius-lg)] px-3 py-2 text-[13.5px] leading-[1.5]"
              : "rounded-[var(--radius-lg)] px-4 py-2.5 text-[14.5px] leading-[1.55]",
          )}
        >
          {message.content}
        </div>
      )}
      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="w-auto max-w-[92vw] bg-mat p-0">
          <DialogTitle className="sr-only">Attached image</DialogTitle>
          {viewing && (
            // eslint-disable-next-line @next/next/no-img-element -- local /generated files
            <img
              src={viewing}
              alt="Attached image"
              className="block max-h-[86vh] max-w-[92vw] min-w-[min(360px,92vw)] object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Caret() {
  return <span aria-hidden className="ml-0.5 inline-block h-[1.05em] w-[2px] animate-pulse rounded-full bg-ink-3 align-text-bottom" />;
}

function Thinking() {
  return (
    <div className="flex items-center gap-2 text-[13px] text-ink-3" role="status">
      <span className="flex gap-1">
        {[0, 1, 2].map((d) => (
          <span key={d} className="size-1.5 animate-pulse rounded-full bg-ink-4" style={{ animationDelay: `${d * 160}ms` }} />
        ))}
      </span>
      Thinking
    </div>
  );
}

/** Copy, and "Use as prompt" when there is a prompt to use. */
function AssistantActions({
  copyText,
  prompt,
  context,
  className,
}: {
  copyText: string;
  prompt?: string;
  context?: AssistantContext;
  className?: string;
}) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      useWorkflowStore.getState().addToast("Copying was blocked by the system. Select the text and copy it by hand.", "error");
    }
  }

  // A chat opened on a generation hands back that generation's references and settings too, like "Reuse".
  function sendToComposer() {
    if (!prompt) return;
    const tab = context?.tab ?? "images";
    handOffPromptToComposer(
      tab,
      prompt,
      context?.source === "result"
        ? {
            refUrls: context.refUrls ?? [],
            meta: {
              model: context.model,
              aspectRatio: context.aspectRatio,
              quality: context.quality,
              azureResolution: context.azureResolution,
            },
          }
        : undefined,
    );
    router.push(`/gallery?tab=${tab}`);
  }

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <Button variant="ghost" size="sm" className="text-ink-3" onClick={copy}>
        {copied ? <Check className="text-verdigris" /> : <Copy />}
        {copied ? "Copied" : "Copy"}
      </Button>
      {prompt && (
        <Button variant="ghost" size="sm" className="text-ink-3" onClick={sendToComposer}>
          <Wand2 />
          Use as prompt
        </Button>
      )}
    </div>
  );
}

/** A finished prompt from an explore reply (a ```prompt block), with its own actions once complete. */
function PromptCard({
  text,
  live,
  context,
  compact,
}: {
  text: string;
  live: boolean;
  context?: AssistantContext;
  compact: boolean;
}) {
  return (
    <div className="flex flex-col rounded-[var(--radius-lg)] bg-surface shadow-[var(--shadow-sm)]">
      <p
        className={cn(
          "px-3.5 pt-3 whitespace-pre-wrap text-ink",
          compact ? "text-[13px] leading-[1.55]" : "text-[14px] leading-[1.6]",
          live ? "pb-3" : "pb-1",
        )}
      >
        {text}
      </p>
      {!live && <AssistantActions copyText={text} prompt={text} context={context} className="px-1 pb-1" />}
    </div>
  );
}

/** Answers the assistant offered (a ```options block). Clicking one sends it; only the latest reply's are live. */
function ReplyOptions({ text, onPick }: { text: string; onPick?: (choice: string) => void }) {
  const choices = text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Suggested replies">
      {choices.map((choice, i) => (
        <button
          key={`${i}-${choice}`}
          type="button"
          disabled={!onPick}
          onClick={() => onPick?.(choice)}
          className="min-h-7 rounded-full border border-dashed border-rule-strong px-3 py-1 text-left text-[12.5px] leading-[1.35] text-ink-2 transition-colors duration-150 enabled:hover:border-solid enabled:hover:bg-wash enabled:hover:text-ink disabled:opacity-60"
        >
          {choice}
        </button>
      ))}
    </div>
  );
}

/** Draws ```prompt and ```options blocks as controls; `onReply` set only where answering is still possible. */
function fenceRenderer(opts: {
  live: boolean;
  context?: AssistantContext;
  compact: boolean;
  onReply?: (text: string) => void;
}): FenceRenderer {
  return function renderFence({ lang, text, closed }) {
    if (lang === "prompt") {
      return <PromptCard text={text.trim()} live={opts.live || !closed} context={opts.context} compact={opts.compact} />;
    }
    if (lang === "options") {
      return <ReplyOptions text={text} onPick={opts.live || !closed ? undefined : opts.onReply} />;
    }
    return undefined;
  };
}

function AssistantTurn({
  message,
  compact,
  isLast,
  onRetry,
  onReply,
  context,
}: {
  message: StoredMessage;
  compact: boolean;
  isLast: boolean;
  onRetry: () => void;
  onReply?: (text: string) => void;
  context?: AssistantContext;
}) {
  const prose = compact ? "text-[13.5px] leading-[1.6]" : "text-[15px] leading-[1.7]";
  // A refine reply is the prompt itself; an explore reply is conversation with prompts in their own cards.
  const wholeIsPrompt = message.mode !== "explore" && fencedBlocks(message.content, "prompt").length === 0;
  return (
    <div className="flex flex-col gap-2">
      {message.content && (
        <Markdown
          text={message.content}
          className={cn("text-ink", prose)}
          renderFence={fenceRenderer({ live: false, context, compact, onReply: isLast && !message.status ? onReply : undefined })}
        />
      )}
      {message.status === "error" ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <span className="size-1.5 shrink-0 rounded-full bg-sanguine" />
          <span className="text-ink-2">{message.error ?? "The reply failed."}</span>
          {isLast && (
            <Button variant="link" size="sm" className="h-auto text-[13px]" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      ) : (
        message.content && (
          <div className="flex flex-wrap items-center gap-x-3">
            <AssistantActions
              copyText={message.content}
              prompt={wholeIsPrompt ? toPlainText(message.content) : undefined}
              context={context}
              className={compact ? "-ml-2" : "-ml-2.5"}
            />
            {message.status === "stopped" && (
              <span className="flex items-center gap-2 text-[12px] text-ink-3">
                Stopped early
                {isLast && (
                  <Button variant="link" size="sm" className="h-auto text-[12px]" onClick={onRetry}>
                    Regenerate
                  </Button>
                )}
              </span>
            )}
          </div>
        )
      )}
    </div>
  );
}

/** The conversation, shared by /chat and the ⌘K assistant. */
export function ChatThread({
  messages,
  stream,
  onRetry,
  onReply,
  context,
  compact = false,
}: {
  messages: StoredMessage[];
  stream: LiveStream | undefined;
  onRetry: () => void;
  /** Sends a suggested answer (from a ```options block) as the user's next message. */
  onReply?: (text: string) => void;
  /** What the chat was opened about; "Use as prompt" hands its setup back to the composer. */
  context?: AssistantContext;
  compact?: boolean;
}) {
  // While streaming, the engine checkpoints partial text under the stream's id; show the live copy instead.
  const visible = stream ? messages.filter((m) => m.id !== stream.messageId) : messages;
  const awaitingReply = !stream && messages[messages.length - 1]?.role === "user";

  return (
    <div className={cn("flex flex-col", compact ? "gap-4" : "gap-7")}>
      {visible.map((m, i) =>
        m.role === "user" ? (
          <UserTurn key={m.id} message={m} compact={compact} />
        ) : (
          <AssistantTurn
            key={m.id}
            message={m}
            compact={compact}
            isLast={i === visible.length - 1 && !stream}
            onRetry={onRetry}
            onReply={onReply}
            context={context}
          />
        ),
      )}
      {stream &&
        (stream.content ? (
          <Markdown
            text={stream.content}
            trailing={<Caret />}
            className={cn("text-ink", compact ? "text-[13.5px] leading-[1.6]" : "text-[15px] leading-[1.7]")}
            renderFence={fenceRenderer({ live: true, context, compact })}
          />
        ) : (
          <Thinking />
        ))}
      {awaitingReply && (
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <span className="size-1.5 rounded-full bg-ochre" />
          No reply yet.
          <Button variant="link" size="sm" className="h-auto text-[13px]" onClick={onRetry}>
            Ask again
          </Button>
        </div>
      )}
    </div>
  );
}
