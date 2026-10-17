import type { AssistantContext } from "./chatSessionStore";

/**
 * Opening the ⌘K assistant on something from elsewhere in the app (the
 * composer's draft, a generation). The assistant starts a fresh explore chat
 * with `images` attached to its draft and `context` in its instructions.
 */
export interface AssistantLaunch {
  /** Stored `/generated/...` image URLs, at most `MAX_CHAT_IMAGES`, in the order `context.imageRoles` describes. */
  images: string[];
  context: AssistantContext;
}

export const ASSISTANT_LAUNCH_EVENT = "assistant-launch";

export function launchAssistant(launch: AssistantLaunch) {
  window.dispatchEvent(new CustomEvent<AssistantLaunch>(ASSISTANT_LAUNCH_EVENT, { detail: launch }));
}

/** Images the assistant route can read: stored locally, in a format every chat provider takes. */
export function isChatImageUrl(url: string | null | undefined): url is string {
  return !!url && url.startsWith("/generated/") && /\.(png|jpe?g|gif|webp)$/i.test(url.split(/[?#]/)[0]);
}
