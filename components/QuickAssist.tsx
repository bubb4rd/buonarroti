"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Maximize2, PenLine, X } from "lucide-react";
import { useChatSessionStore, type StoredMessage } from "@/lib/chatSessionStore";
import { useChatStreamingStore, watchSession } from "@/lib/chatStreamingStore";
import { Mark } from "@/components/brand/Mark";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Composer } from "@/components/chat/Composer";
import { ChatThread } from "@/components/chat/ChatThread";

const NO_MESSAGES: StoredMessage[] = [];

/** ⌘K assistant: a raised-paper command panel on the same sessions and streaming engine as /chat. */
export function QuickAssist() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [pickedId, setSessionId] = useState<string | null>(null);

  const session = useChatSessionStore((s) => (pickedId ? s.sessions.find((x) => x.id === pickedId) : undefined));
  // A session deleted from the sidebar while open reads as no session: the next send starts fresh.
  const sessionId = session ? pickedId : null;
  const preferredModel = useChatSessionStore((s) => s.preferredModel);
  const stream = useChatStreamingStore((s) => (sessionId ? s.streams[sessionId] : undefined));
  const model = session?.model ?? preferredModel;
  const messages = session?.messages ?? NO_MESSAGES;
  const isEmpty = messages.length === 0 && !stream;

  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    function onPointer(e: PointerEvent) {
      const t = e.target as HTMLElement;
      // The model menu renders in a portal outside the panel.
      if (open && !containerRef.current?.contains(t) && !t.closest('[role="menu"]')) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => textareaRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => (open && sessionId ? watchSession(sessionId) : undefined), [open, sessionId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, stream?.content, open]);

  function send() {
    const text = input.trim();
    if (!text) return;
    let id = sessionId;
    if (!id) {
      id = useChatSessionStore.getState().ensureDraftSession(model, "");
      setSessionId(id);
    }
    setInput("");
    useChatStreamingStore.getState().send(id, text);
  }

  function changeModel(id: string) {
    const store = useChatSessionStore.getState();
    store.setPreferredModel(id);
    if (sessionId) store.setSessionModel(sessionId, id);
  }

  /** A reply still streaming keeps going into its own session; it shows up in the sidebar. */
  function newChat() {
    setSessionId(null);
    setInput("");
    textareaRef.current?.focus();
  }

  function openInChat() {
    if (!sessionId) return;
    if (input.trim()) useChatSessionStore.getState().setDraft(sessionId, input);
    setOpen(false);
    router.push(`/chat?id=${sessionId}`);
  }

  return (
    <div ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="fixed right-6 bottom-2 z-[1000] flex h-9 items-center gap-2 rounded-full bg-surface-raised pr-2 pl-3 text-[13px] font-medium text-ink-2 shadow-[var(--shadow-md)] transition-colors duration-150 hover:text-ink"
      >
        <Mark className="size-4" title="" />
        Assistant
        {stream && <span className="size-1.5 animate-pulse rounded-full bg-lapis" aria-label="Replying" />}
        <Kbd>⌘K</Kbd>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Assistant"
          className="fixed right-6 bottom-14 z-[1001] flex max-h-[min(620px,calc(100vh-96px))] w-[400px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-[var(--radius-xl)] bg-surface-raised shadow-[var(--shadow-lg)] duration-200 ease-[var(--ease-out)] animate-in fade-in-0 slide-in-from-bottom-2"
        >
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-rule pr-2 pl-4">
            <Mark className="size-4 text-ink-2" title="" />
            <span className="min-w-0 truncate text-[13.5px] font-medium text-ink">
              {session?.title || "Assistant"}
            </span>
            <div className="ml-auto flex items-center gap-0.5">
              {sessionId && (
                <Button variant="ghost" size="icon-sm" onClick={openInChat} aria-label="Open in chat" title="Open in chat">
                  <Maximize2 />
                </Button>
              )}
              {!isEmpty && (
                <Button variant="ghost" size="icon-sm" onClick={newChat} aria-label="New chat" title="New chat">
                  <PenLine />
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="Close" title="Close">
                <X />
              </Button>
            </div>
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
            {isEmpty ? (
              <div className="flex flex-col items-center py-6 text-center">
                <h2 className="type-heading text-ink">What shall we make?</h2>
                <p className="mt-1.5 max-w-[280px] text-[13px] text-ink-2">
                  Give me an idea or a prompt, and I will make it richer.
                </p>
              </div>
            ) : (
              <ChatThread
                messages={messages}
                stream={stream}
                onRetry={() => sessionId && useChatStreamingStore.getState().retry(sessionId)}
                compact
              />
            )}
          </div>

          <div className="shrink-0 px-3 pb-3">
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={send}
              onStop={() => sessionId && useChatStreamingStore.getState().stop(sessionId)}
              streaming={!!stream}
              model={model}
              onModelChange={changeModel}
              textareaRef={textareaRef}
              placeholder="Describe your idea…"
              compact
            />
          </div>
        </div>
      )}
    </div>
  );
}
