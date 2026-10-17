/**
 * Local media storage. Buonarroti writes all generated and uploaded media to
 * disk under `MEDIA_DIR` (see `lib/guest/paths.ts`) and serves it same-origin
 * at `/generated/...` (`app/generated/[...path]/route.ts`). SHA-256 dedupe and
 * the hash index live in the local SQLite DB (`lib/guest/db.ts`).
 *
 * Thin, stable facade over `lib/guest/localStorage.ts`.
 */
export {
  uploadBuffer,
  uploadDataUrl,
  mirrorToStorage,
  ensureStorage,
  readMediaBuffer,
} from "./guest/localStorage";
