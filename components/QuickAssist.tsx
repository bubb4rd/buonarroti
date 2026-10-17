"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Maximize2, Minus, PenLine } from "lucide-react";
import { useChatSessionStore, type AssistantContext, type ChatMode, type StoredMessage } from "@/lib/chatSessionStore";
import { useChatStreamingStore, watchSession } from "@/lib/chatStreamingStore";
import { ASSISTANT_LAUNCH_EVENT, type AssistantLaunch } from "@/lib/assistantLaunch";
import { useDefaultChatModel } from "@/lib/useAgents";
import { setUiPref, useUiPref } from "@/lib/uiPrefs";
import { cn } from "@/lib/utils";
import { Mark } from "@/components/brand/Mark";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Composer } from "@/components/chat/Composer";
import { ChatThread } from "@/components/chat/ChatThread";
import { ContextCard } from "@/components/chat/ContextCard";
import { useImageAttachments } from "@/components/chat/useImageAttachments";

const NO_MESSAGES: StoredMessage[] = [];

/** Portalled UI that belongs to the panel even though it renders outside it. */
const PANEL_PORTALS = '[role="menu"], [data-slot="dialog-content"], [data-slot="dialog-backdrop"]';

const CONTEXT_PLACEHOLDERS: Record<AssistantContext["source"], string> = {
  composer: "Where are you stuck?",
  result: "What should change?",
  upload: "What would you like to make from it?",
};

/**
 * ⌘K assistant: a raised-paper command panel on the same sessions and streaming engine as /chat.
 * Closed, it is the "Assistant ⌘K" pill; hidden, a slim tab on the bottom edge. ⌘K opens it from either.
 * Other surfaces open it on something (`launchAssistant`): a fresh explore chat with that context.
 */
export function QuickAssist() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const minimized = useUiPref("quickAssistMinimized", false);
  const [input, setInput] = useState("");
  const attachments = useImageAttachments();
  const [pickedId, setSessionId] = useState<string | null>(null);
  // The mode for the next new chat, until there is a session to hold it.
  const [pendingMode, setPendingMode] = useState<ChatMode>("refine");

  const session = useChatSessionStore((s) => (pickedId ? s.sessions.find((x) => x.id === pickedId) : undefined));
  // A session deleted from the sidebar while open reads as no session: the next send starts fresh.
  const sessionId = session ? pickedId : null;
  const defaultModel = useDefaultChatModel();
  const stream = useChatStreamingStore((s) => (sessionId ? s.streams[sessionId] : undefined));
  const model = session?.model ?? defaultModel;
  const mode: ChatMode = session ? (session.mode ?? "refine") : pendingMode;
  const context = session?.context;
  const messages = session?.messages ?? NO_MESSAGES;
  const isEmpty = messages.length === 0 && !stream;

  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open && !document.querySelector('[data-slot="dialog-content"]')) {
        setOpen(false);
      }
    }
    function onPointer(e: PointerEvent) {
      const t = e.target as HTMLElement;
      if (open && !containerRef.current?.contains(t) && !t.closest(PANEL_PORTALS)) setOpen(false);
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

  // The images stay in this panel's draft (not the session's) so an unanswered launch leaves
  // an empty session behind, which the sidebar hides and the next new chat reuses.
  const { reset: resetAttachments } = attachments;
  useEffect(() => {
    function onLaunch(e: Event) {
      const { images, context: launched } = (e as CustomEvent<AssistantLaunch>).detail;
      const id = useChatSessionStore.getState().createSession(model, { mode: "explore", context: launched });
      setSessionId(id);
      setInput("");
      resetAttachments(images);
      setOpen(true);
      window.setTimeout(() => textareaRef.current?.focus(), 60);
    }
    window.addEventListener(ASSISTANT_LAUNCH_EVENT, onLaunch);
    return () => window.removeEventListener(ASSISTANT_LAUNCH_EVENT, onLaunch);
  }, [model, resetAttachments]);

  useEffect(() => (open && sessionId ? watchSession(sessionId) : undefined), [open, sessionId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, stream?.content, open]);

  function send() {
    const text = input.trim();
    const images = attachments.urls;
    if (!text && images.length === 0) return;
    let id = sessionId;
    if (!id) {
      id = useChatSessionStore.getState().ensureDraftSession(model, "", [], { mode });
      setSessionId(id);
    }
    setInput("");
    attachments.reset([]);
    useChatStreamingStore.getState().send(id, text, images);
  }

  function changeModel(id: string) {
    const store = useChatSessionStore.getState();
    store.setPreferredModel(id);
    if (sessionId) store.setSessionModel(sessionId, id);
  }

  function changeMode(next: ChatMode) {
    if (sessionId) useChatSessionStore.getState().setSessionMode(sessionId, next);
    else setPendingMode(next);
    textareaRef.current?.focus();
  }

  /** A reply still streaming keeps going into its own session; it shows up in the sidebar. */
  function newChat() {
    setSessionId(null);
    setInput("");
    attachments.reset([]);
    textareaRef.current?.focus();
  }

  function openInChat() {
    if (!sessionId) return;
    if (input.trim() || attachments.urls.length > 0) {
      useChatSessionStore.getState().setDraft(sessionId, input, attachments.urls);
    }
    setOpen(false);
    router.push(`/chat?id=${sessionId}`);
  }

  const replying = stream && <span className="size-1.5 animate-pulse rounded-full bg-lapis" aria-label="Replying" />;

  return (
    <div ref={containerRef}>
      {minimized ? (
        !open && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => setUiPref("quickAssistMinimized", false)}
                  aria-label="Show assistant"
                  className="group/tab fixed right-6 bottom-0 z-[1000] flex h-3.5 w-14 items-end justify-center outline-none duration-200 ease-[var(--ease-out)] animate-in fade-in-0 slide-in-from-bottom-1"
                />
              }
            >
              <span
                className={cn(
                  "h-1.5 w-full rounded-t-full shadow-[var(--shadow-sm)] transition-[height,background-color] duration-150 ease-[var(--ease-out)] group-hover/tab:h-2 group-focus-visible/tab:h-2 group-focus-visible/tab:shadow-[var(--focus-ring)]",
                  stream ? "animate-pulse bg-lapis" : "bg-ink-4 group-hover/tab:bg-ink-3",
                )}
              />
            </TooltipTrigger>
            <TooltipContent side="top" align="end">
              Show assistant
              <Kbd>⌘K</Kbd>
            </TooltipContent>
          </Tooltip>
        )
      ) : (
        <div className="group/pill fixed right-6 bottom-2 z-[1000] duration-200 ease-[var(--ease-out)] animate-in fade-in-0 slide-in-from-bottom-1">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex h-9 items-center gap-2 rounded-full bg-surface-raised pr-2 pl-3 text-[13px] font-medium text-ink-2 shadow-[var(--shadow-md)] transition-colors duration-150 outline-none hover:text-ink focus-visible:shadow-[var(--shadow-md),var(--focus-ring)]"
          >
            <Mark className="size-4" title="" />
            Assistant
            {replying}
            <Kbd>⌘K</Kbd>
          </button>
          {!open && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => setUiPref("quickAssistMinimized", true)}
                    aria-label="Hide assistant"
                    className="absolute -top-1.5 -left-1.5 inline-flex size-5 items-center justify-center rounded-full bg-surface-raised text-ink-3 opacity-0 shadow-[var(--shadow-sm),inset_0_0_0_1px_var(--rule)] transition-[opacity,color] duration-150 ease-[var(--ease-out)] outline-none group-hover/pill:opacity-100 hover:text-ink focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)]"
                  />
                }
              >
                <ChevronDown className="size-3" />
              </TooltipTrigger>
              <TooltipContent side="top">Hide</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Assistant"
          className={cn(
            "fixed right-6 z-[1001] flex max-h-[min(620px,calc(100vh-96px))] w-[400px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-[var(--radius-xl)] bg-surface-raised shadow-[var(--shadow-lg)] duration-200 ease-[var(--ease-out)] animate-in fade-in-0 slide-in-from-bottom-2",
            minimized ? "bottom-5" : "bottom-14",
          )}
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
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="Minimize" />}
                >
                  <Minus />
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Minimize
                  <Kbd>esc</Kbd>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
            {context && sessionId && (
              <div className="mb-4">
                <ContextCard
                  context={context}
                  compact
                  onDetach={() => useChatSessionStore.getState().setSessionContext(sessionId, undefined)}
                />
              </div>
            )}
            {isEmpty ? (
              <div className={cn("flex flex-col items-center text-center", context ? "py-2" : "py-6")}>
                <h2 className="type-heading text-ink">
                  {context ? "What would you like help with?" : mode === "explore" ? "What are you after?" : "What shall we make?"}
                </h2>
                <p className="mt-1.5 max-w-[300px] text-[13px] text-ink-2">
                  {context
                    ? "Say what feels off or where you're stuck, or just send and I'll start from what I can see."
                    : mode === "explore"
                      ? "Start with a feeling, a purpose or an image. I'll ask a few questions before writing the prompt."
                      : "Give me an idea, a prompt or an image, and I will make it richer."}
                </p>
              </div>
            ) : (
              <ChatThread
                messages={messages}
                stream={stream}
                onRetry={() => sessionId && useChatStreamingStore.getState().retry(sessionId)}
                onReply={(text) => sessionId && useChatStreamingStore.getState().send(sessionId, text)}
                context={context}
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
              placeholder={
                !isEmpty
                  ? "Reply, or ask for another take…"
                  : context
                    ? CONTEXT_PLACEHOLDERS[context.source]
                    : mode === "explore"
                      ? "A feeling, a purpose, a half-idea…"
                      : "Describe your idea…"
              }
              compact
              attachments={attachments}
              mode={mode}
              onModeChange={changeMode}
            />
          </div>
        </div>
      )}
    </div>
  );
}
