/**
 * Image files carried by a paste event. Covers screenshots (⌘⇧⌃4), "Copy
 * Image" from a browser or Preview, and image files copied in Finder.
 * Returns [] when the clipboard holds no image, so callers can let the
 * default text paste proceed untouched.
 */
export function imageFilesFromClipboard(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  // `items` and `files` mirror the same images; read `items` and fall back to
  // `files` only when a browser exposes nothing there. Never dedupe by
  // name/size: every clipboard image is "image.png", so distinct images would
  // collapse into one.
  let sources = Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile());
  if (sources.length === 0) sources = Array.from(data.files);
  const stamp = Date.now();
  return sources
    .filter((file): file is File => !!file && file.type.startsWith("image/"))
    .map((file, i) =>
      // Give generic clipboard names a unique one so uploads and chips don't collide.
      file.name && file.name !== "image.png"
        ? file
        : new File([file], `pasted-${stamp}-${i + 1}.${file.type.split("/")[1] || "png"}`, { type: file.type }),
    );
}
