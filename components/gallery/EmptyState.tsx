import type { SourceFilter, Tab } from "./types";

/**
 * The studio before the first piece: the hands from the Sistine ceiling,
 * framed like a proof on the press bed, and one quiet invitation.
 */
export function EmptyState({ tab, source, inFolder }: { tab: Tab; source: SourceFilter; inFolder: boolean }) {
  const { title, body } =
    source === "uploaded"
      ? { title: "Nothing uploaded yet", body: "Images and videos you add as references will be kept here." }
      : inFolder
        ? { title: "This folder is empty", body: "Drag pieces here from the grid, or generate while the folder is open." }
        : tab === "videos"
          ? { title: "What shall we film?", body: "Describe a scene below, set the length and ratio, then press ⌘↵." }
          : { title: "What shall we make?", body: "Describe an image below. Your first piece will appear here." };

  return (
    <div className="relative flex min-h-full flex-1 items-center justify-center overflow-hidden px-8 pt-6 pb-[240px]">
      <div className="flex max-w-[520px] flex-col items-center text-center">
        <div className="crop-marks mb-9 [--crop-gap:10px] [--crop:16px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/art/the-touch.webp"
            alt="The hands of God and Adam from Michelangelo's Creation of Adam"
            draggable={false}
            className="block h-auto w-[min(440px,72vw)] rounded-[2px] bg-mat shadow-[var(--shadow-md)]"
          />
        </div>
        <h2 className="type-display text-ink">{title}</h2>
        <p className="mt-3 text-[14px] leading-relaxed text-ink-2">{body}</p>
      </div>
    </div>
  );
}
