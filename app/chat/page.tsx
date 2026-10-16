"use client";

import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PenLine } from "lucide-react";
import { useChatSessionStore, type StoredMessage } from "@/lib/chatSessionStore";
import { useChatStreamingStore, watchSession } from "@/lib/chatStreamingStore";
import { getDefaultChatModel, useDefaultChatModel } from "@/lib/useAgents";
import { useModelLabel } from "@/components/chat/ModelPicker";
import { Mark } from "@/components/brand/Mark";
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/chat/Composer";
import { ChatThread } from "@/components/chat/ChatThread";
import { useImageAttachments } from "@/components/chat/useImageAttachments";

const DRAFT_DEBOUNCE_MS = 300;
const NO_MESSAGES: StoredMessage[] = [];

// ── Cycling placeholder ──────────────────────────────────────────────────────

const PLACEHOLDER_SENTENCES = [
  "A lighthouse at dusk, painted like a Turner",
  "Make this prompt more cinematic, with lighting details",
  "Turn this prompt into a JSON prompt",
  "A slow dolly shot through a rain-soaked market at night",
  "Rewrite this for a photorealistic style",
];

const SUGGESTIONS = [
  "Make this more cinematic",
  "Turn this into a JSON prompt",
  "Add camera and lens details",
];

function useCyclingPlaceholder(paused: boolean) {
  const [text, setText] = useState(PLACEHOLDER_SENTENCES[0]);

  useEffect(() => {
    if (paused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let idx = 0;
    let char = PLACEHOLDER_SENTENCES[0].length;
    let phase: "typing" | "waiting" | "deleting" = "waiting";
    let timeout: number;

    function tick() {
      const sentence = PLACEHOLDER_SENTENCES[idx];
      if (phase === "typing") {
        char++;
        setText(sentence.slice(0, char));
        if (char >= sentence.length) phase = "waiting";
        timeout = window.setTimeout(tick, phase === "waiting" ? 2600 : 45);
      } else if (phase === "waiting") {
        phase = "deleting";
        timeout = window.setTimeout(tick, 30);
      } else {
        char--;
        setText(sentence.slice(0, char));
        if (char <= 0) {
          idx = (idx + 1) % PLACEHOLDER_SENTENCES.length;
          phase = "typing";
        }
        timeout = window.setTimeout(tick, phase === "typing" ? 350 : 22);
      }
    }

    timeout = window.setTimeout(tick, 2600);
    return () => clearTimeout(timeout);
  }, [paused]);

  return text;
}

// ── Chat screen (landing and conversation share one composer instance) ──────

function ChatScreen({ urlId }: { urlId: string | null }) {
  // The session this composer created from a draft, until `?id=` catches up; switching to it keeps the text.
  // State drives rendering; the ref mirrors it for debounced callbacks that outlive a render.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const createdRef = useRef<string | null>(null);
  const pending = useRef<{ timer: number; sessionId: string | null; text: string; images: string[] } | null>(null);

  // The URL moved somewhere other than the session we created (e.g. "New chat"): forget it.
  let created = createdId;
  const [seenUrlId, setSeenUrlId] = useState(urlId);
  if (seenUrlId !== urlId) {
    setSeenUrlId(urlId);
    if (urlId !== createdId) {
      created = null;
      setCreatedId(null);
    }
  }
  const sessionId = urlId ?? created;

  const session = useChatSessionStore((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined));
  const defaultModel = useDefaultChatModel();
  const stream = useChatStreamingStore((s) => (sessionId ? s.streams[sessionId] : undefined));
  const model = session?.model ?? defaultModel;
  const { label, source, unavailable } = useModelLabel(model);
  const messages = session?.messages ?? NO_MESSAGES;
  const isLanding = messages.length === 0 && !stream;

  const [input, setInput] = useState(() => session?.draft ?? "");
  const attachments = useImageAttachments(session?.draftImages, onImagesChange);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Switching sessions: show that session's saved draft.
  const [shownFor, setShownFor] = useState(sessionId);
  if (shownFor !== sessionId) {
    setShownFor(sessionId);
    if (sessionId === null || sessionId !== created) setInput(session?.draft ?? "");
  }

  // history.replaceState (synced into useSearchParams by Next) rather than router.replace: a new search
  // string is a new page segment for the router, which would remount this screen mid-keystroke.
  const markCreated = useCallback((id: string) => {
    createdRef.current = id;
    setCreatedId(id);
    window.history.replaceState(window.history.state, "", `/chat?id=${id}`);
  }, []);

  const commitDraft = useCallback(
    (targetId: string | null, text: string, images: string[]) => {
      const store = useChatSessionStore.getState();
      const id = targetId ?? createdRef.current;
      if (id && store.sessions.some((s) => s.id === id)) {
        store.setDraft(id, text, images);
      } else if (!targetId && (text.trim() || images.length > 0)) {
        markCreated(store.ensureDraftSession(getDefaultChatModel(), text, images));
      }
    },
    [markCreated],
  );

  const flushDraft = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    commitDraft(p.sessionId, p.text, p.images);
  }, [commitDraft]);

  // Switching sessions: show that session's saved images too (the text follows above, during render).
  const { reset: resetAttachments } = attachments;
  useEffect(() => {
    if (sessionId !== null && sessionId === createdRef.current) return;
    const saved = sessionId ? useChatSessionStore.getState().sessions.find((s) => s.id === sessionId) : undefined;
    resetAttachments(saved?.draftImages ?? []);
  }, [sessionId, resetAttachments]);

  // Save the draft before switching away, unmounting, or the window closing.
  useEffect(() => {
    if (sessionId !== createdRef.current) createdRef.current = null;
    window.addEventListener("pagehide", flushDraft);
    return () => {
      window.removeEventListener("pagehide", flushDraft);
      flushDraft();
    };
  }, [sessionId, flushDraft]);

  useEffect(() => (sessionId ? watchSession(sessionId) : undefined), [sessionId]);

  function scheduleDraft(text: string, images: string[]) {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = {
      sessionId,
      text,
      images,
      timer: window.setTimeout(flushDraft, DRAFT_DEBOUNCE_MS),
    };
  }

  function onChange(text: string) {
    setInput(text);
    scheduleDraft(text, attachments.urls);
  }

  function onImagesChange(images: string[]) {
    scheduleDraft(input, images);
  }

  function submit() {
    const text = input.trim();
    const images = attachments.urls;
    if (!text && images.length === 0) return;
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    const store = useChatSessionStore.getState();
    let id = sessionId ?? createdRef.current;
    if (!id || !store.sessions.some((s) => s.id === id)) {
      id = store.ensureDraftSession(model, "");
      markCreated(id);
    }
    store.setDraft(id, "", []);
    setInput("");
    attachments.reset([]);
    stickToBottom.current = true;
    useChatStreamingStore.getState().send(id, text, images);
  }

  function changeModel(id: string) {
    const store = useChatSessionStore.getState();
    store.setPreferredModel(id);
    if (sessionId) store.setSessionModel(sessionId, id);
  }

  function stop() {
    if (sessionId) useChatStreamingStore.getState().stop(sessionId);
  }

  function retry() {
    if (sessionId) useChatStreamingStore.getState().retry(sessionId);
  }

  // Follow the reply as it streams, unless the reader has scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, stream?.content]);

  useEffect(() => {
    stickToBottom.current = true;
    const t = textareaRef.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, [sessionId]);

  const placeholder = useCyclingPlaceholder(!isLanding || input.length > 0);

  const composer = (
    <Composer
      value={input}
      onChange={onChange}
      onSubmit={submit}
      onStop={stop}
      streaming={!!stream}
      model={model}
      onModelChange={changeModel}
      textareaRef={textareaRef}
      pickerSide={isLanding ? "bottom" : "top"}
      placeholder={isLanding ? placeholder : "Reply, or ask for another take…"}
      autoFocus
      attachments={attachments}
    />
  );

  if (isLanding) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="titlebar-drag h-10 shrink-0" />
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-[12vh]">
          <div className="flex w-full max-w-[680px] flex-col">
            <Mark className="mb-6 size-9 text-ink-3" />
            <h1 className="type-display text-ink">What shall we make?</h1>
            <p className="mt-2 mb-8 text-[15px] text-ink-2">
              Describe an idea, or paste a prompt. You will get back a richer prompt for images or video.
            </p>
            {composer}
            <div className="mt-4 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    onChange(input.trim() ? `${s}:\n${input}` : `${s}: `);
                    textareaRef.current?.focus();
                  }}
                  className="h-7 rounded-full border border-dashed border-rule-strong px-3 text-[12.5px] text-ink-2 transition-colors duration-150 hover:bg-wash hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const modelLabel = (
    <>
      {label}
      {source && ` · ${source}`}
      {unavailable && <span className="text-ochre"> · unavailable</span>}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="titlebar-drag flex h-14 shrink-0 items-end border-b border-rule px-6 pb-3">
        <div className="mx-auto flex w-full max-w-[680px] items-baseline gap-3">
          <h1 className="type-heading min-w-0 truncate text-ink">{session?.title || "Chat"}</h1>
          <span className="shrink-0 text-[12px] text-ink-3">{modelLabel}</span>
        </div>
      </header>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-6"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="mx-auto w-full max-w-[680px] py-8">
          <ChatThread messages={messages} stream={stream} onRetry={retry} />
        </div>
      </div>
      <div className="shrink-0 px-6 pb-5">
        <div className="mx-auto w-full max-w-[680px]">{composer}</div>
      </div>
    </div>
  );
}

// ── Missing chat ─────────────────────────────────────────────────────────────

function MissingChat() {
  const router = useRouter();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 pb-[12vh] text-center">
      <Mark className="mb-2 size-8 text-ink-4" />
      <h1 className="type-title text-ink">This chat no longer exists</h1>
      <p className="max-w-sm text-[14px] text-ink-2">It may have been deleted. Your other chats are in the sidebar.</p>
      <Button variant="primary" className="mt-3" onClick={() => router.replace("/chat")}>
        <PenLine />
        New chat
      </Button>
    </div>
  );
}

// ── Inner page (uses useSearchParams) ────────────────────────────────────────

const subscribeHydration = (onDone: () => void) =>
  useChatSessionStore.persist?.onFinishHydration(onDone) ?? (() => {});

function ChatInner() {
  const idParam = useSearchParams().get("id");
  // false on the server and the first client render (so markup matches), then true once localStorage is read.
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    () => useChatSessionStore.persist?.hasHydrated() ?? false,
    () => false,
  );
  const exists = useChatSessionStore((s) => (idParam ? s.sessions.some((x) => x.id === idParam) : false));

  if (!hydrated) return <div className="flex-1" />;
  if (idParam && !exists) return <MissingChat />;
  return <ChatScreen urlId={idParam} />;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ChatPage() {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <Suspense fallback={<div className="flex-1" />}>
        <ChatInner />
      </Suspense>
    </div>
  );
}
