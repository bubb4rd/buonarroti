import { MAX_CHAT_IMAGES } from "@/components/chat/useImageAttachments";
import { isChatImageUrl, launchAssistant } from "@/lib/assistantLaunch";
import type { GalleryItem } from "./types";
import type { ComposerState } from "./useComposer";

/** Opens the assistant on the composer's draft: its prompt, model, settings and the images it would send. */
export function askAboutDraft(c: ComposerState) {
  const images = c.mentionableAssets.filter((a) => a.kind === "image" && isChatImageUrl(a.cdnUrl));
  const sent = images.slice(0, MAX_CHAT_IMAGES);
  launchAssistant({
    images: sent.map((a) => a.cdnUrl!),
    context: {
      source: "composer",
      tab: c.tab,
      model: c.modelId,
      aspectRatio: c.aspectRatio,
      ...(c.supportsQuality ? { quality: c.quality } : {}),
      prompt: c.prompt,
      imageRoles: sent.map((a) => `@${a.label}, ${a.role.toLowerCase()}`),
      ...(images.length > sent.length ? { omittedImages: images.length - sent.length } : {}),
    },
  });
}

/**
 * Opens the assistant on a gallery item: the picture itself first (`shownUrl`, the page on screen
 * for multi-image items), then the references it was made with. A video is described, not shown.
 */
export function askAboutItem(item: GalleryItem, shownUrl = item.url) {
  const isVideo = item.mediaType === "video";
  const uploaded = item.source === "upload";
  const subject = !isVideo && isChatImageUrl(shownUrl) ? [shownUrl] : [];
  const refs = (item.referenceImageUrls ?? []).filter(isChatImageUrl);
  const sent = [...subject, ...refs].slice(0, MAX_CHAT_IMAGES);
  const refsSent = sent.length - subject.length;
  launchAssistant({
    images: sent,
    context: {
      source: uploaded ? "upload" : "result",
      tab: isVideo ? "videos" : "images",
      model: item.model,
      aspectRatio: item.aspect_ratio,
      quality: item.quality,
      azureResolution: item.azure_resolution,
      prompt: item.prompt,
      imageRoles: [
        ...subject.map(() => (uploaded ? "the uploaded image" : "the generated result")),
        ...Array.from({ length: refsSent }, (_, i) => `reference ${i + 1} it was made with`),
      ],
      ...(refs.length > refsSent ? { omittedImages: refs.length - refsSent } : {}),
      ...(isVideo ? { resultIsVideo: true } : {}),
      ...(uploaded ? {} : { refUrls: item.referenceImageUrls ?? [] }),
    },
  });
}
