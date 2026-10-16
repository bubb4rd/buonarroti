"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useWorkflowStore } from "@/lib/store";
import type { StoredMessage } from "@/lib/chatSessionStore";
import type { LiveStream } from "@/lib/chatStreamingStore";
import { handOffPromptToComposer } from "@/components/gallery/composerDraft";
import { cn } from "@/lib/utils";
import { Markdown, toPlainText } from "./Markdown";

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

function AssistantActions({ content, compact }: { content: string; compact: boolean }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      useWorkflowStore.getState().addToast("Copying was blocked by the system. Select the text and copy it by hand.", "error");
    }
  }

  function sendToComposer() {
    handOffPromptToComposer("images", toPlainText(content));
    router.push("/gallery?tab=images");
  }

  return (
    <div className={cn("flex items-center gap-0.5", compact ? "-ml-2" : "-ml-2.5")}>
      <Button variant="ghost" size="sm" className="text-ink-3" onClick={copy}>
        {copied ? <Check className="text-verdigris" /> : <Copy />}
        {copied ? "Copied" : "Copy"}
      </Button>
      <Button variant="ghost" size="sm" className="text-ink-3" onClick={sendToComposer}>
        <Wand2 />
        Use as prompt
      </Button>
    </div>
  );
}

function AssistantTurn({
  message,
  compact,
  isLast,
  onRetry,
}: {
  message: StoredMessage;
  compact: boolean;
  isLast: boolean;
  onRetry: () => void;
}) {
  const prose = compact ? "text-[13.5px] leading-[1.6]" : "text-[15px] leading-[1.7]";
  return (
    <div className="flex flex-col gap-2">
      {message.content && <Markdown text={message.content} className={cn("text-ink", prose)} />}
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
            <AssistantActions content={message.content} compact={compact} />
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
  compact = false,
}: {
  messages: StoredMessage[];
  stream: LiveStream | undefined;
  onRetry: () => void;
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
          <AssistantTurn key={m.id} message={m} compact={compact} isLast={i === visible.length - 1 && !stream} onRetry={onRetry} />
        ),
      )}
      {stream &&
        (stream.content ? (
          <Markdown
            text={stream.content}
            trailing={<Caret />}
            className={cn("text-ink", compact ? "text-[13.5px] leading-[1.6]" : "text-[15px] leading-[1.7]")}
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
