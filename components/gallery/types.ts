import type { GalleryItem } from "@/lib/galleryUtils";

export type { GalleryItem };

export type Tab = "images" | "videos";
export type SourceFilter = "generated" | "uploaded";

/** An attached reference (image, video or audio) in the composer. */
export interface RefImage {
  id: string;
  objectUrl: string;
  cdnUrl: string | null;
  uploading: boolean;
  error: boolean;
}

export interface TaggedImage {
  label: string;
  refId: string;
  url: string;
  kind?: "image" | "video" | "audio";
}

export interface KlingElement {
  id: string;
  name: string;
  description: string;
  imageUrls: string[];
}

export type GenerateEndpoint = "/api/generate" | "/api/generate-video";

/** Error codes from the generation status contract, plus client-side ones. */
export type GenerationErrorCode =
  | "credits"
  | "auth"
  | "invalid"
  | "upstream"
  | "rate_limited"
  | "interrupted"
  | "timeout"
  | "failed"
  | "rejected"
  /** Client-side: the server could not be reached. Retrying resumes the same job. */
  | "network";

/**
 * An in-flight or failed generation, persisted in localStorage so it survives
 * navigation and reloads. The request body is stored so the exact same request
 * can be resumed (same `clientRequestId`, deduped server-side) or retried.
 */
export interface PendingGen {
  id: string;
  aspectRatio: string;
  prompt: string;
  /** Display name of the model, for the in-flight tile. */
  modelName?: string;
  referenceImageUrls?: string[];
  error?: string;
  errorCode?: GenerationErrorCode;
  taskId?: string;
  createdAt?: string;
  tab?: Tab;
  /** Inside the 3-second cancel window; nothing has been sent yet. */
  prePending?: boolean;
  retried?: boolean;
  folderId?: string | null;
  /** Idempotency key sent with the POST; persisted before the POST is made. */
  clientRequestId?: string;
  endpoint?: GenerateEndpoint;
  /** Full JSON request body (without clientRequestId). */
  request?: Record<string, unknown>;
  /** Set once the POST has been dispatched. */
  postedAt?: string;
}

export interface DownloadTask {
  id: string;
  filename: string;
  status: "preparing" | "ready" | "error";
}

/** Settings a generation was made with, restored alongside its prompt. */
export interface ReuseMeta { model?: string; aspectRatio?: string; quality?: string; azureResolution?: string }

/** Signature of the "reuse prompt" action (lightbox, cards, failed tiles). */
export type ReusePromptFn = (prompt: string, refUrls?: string[], meta?: ReuseMeta) => void;
