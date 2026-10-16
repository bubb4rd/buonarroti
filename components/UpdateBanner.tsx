"use client";
import { useEffect, useState } from "react";
import { Notice } from "@/components/ui/notice";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * "A new version is ready" notice. Polls `/api/update-check` (GitHub latest
 * release vs the bundled version); "What's new" opens the release notes with a
 * Download link. No self-install — Download opens the release page in the OS
 * browser (caught by {@link DesktopLinkHandler}).
 */

const DISMISS_KEY = "buonarroti-update-dismissed"; // holds the version the user dismissed

type UpdateInfo = {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  name?: string;
  notes?: string;
  url?: string;
  publishedAt?: string;
};

export default function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/update-check")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: UpdateInfo | null) => {
        if (!alive || !d?.updateAvailable) return;
        try {
          if (localStorage.getItem(DISMISS_KEY) === d.latestVersion) setDismissed(true);
        } catch {
          /* private mode — just show it */
        }
        setInfo(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!info?.updateAvailable) return null;

  const dismiss = () => {
    try {
      if (info.latestVersion) localStorage.setItem(DISMISS_KEY, info.latestVersion);
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <>
      {!dismissed && (
        <Notice
          tone="lapis"
          onDismiss={dismiss}
          action={
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              What&rsquo;s new
            </Button>
          }
        >
          <span className="text-ink">
            Buonarroti {info.latestVersion ?? "update"} is ready.
          </span>{" "}
          <span className="max-sm:hidden">You have {info.currentVersion}.</span>
        </Notice>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(92vw,560px)]">
          <DialogHeader>
            <DialogTitle>{info.name || `What’s new in ${info.latestVersion ?? "this release"}`}</DialogTitle>
            <DialogDescription className="tabular-nums">
              {info.currentVersion} → {info.latestVersion}
              {info.publishedAt ? ` · ${new Date(info.publishedAt).toLocaleDateString()}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-6">
            <Notes text={info.notes || "No release notes were published for this version."} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Later
            </Button>
            {/* No target="_blank": DesktopLinkHandler intercepts the click and
                hands the URL to the OS browser via /api/open-external. A _blank
                would also trigger Tauri's own (unpermitted) shell.open. */}
            <a
              href={info.url}
              onClick={() => setOpen(false)}
              className={buttonVariants({ variant: "primary" })}
            >
              Download
            </a>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Minimal, safe Markdown-ish renderer for a GitHub release body. */
function Notes({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return (
    <div className="text-[13px] leading-[1.6] text-ink-2">
      {lines.map((raw, i) => {
        const line = raw.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1");
        const heading = line.match(/^#{1,6}\s+(.*)/);
        if (heading) {
          return (
            <div key={i} className="type-heading text-[16px] text-ink first:mt-0 mt-4 mb-1">
              {heading[1]}
            </div>
          );
        }
        const bullet = line.match(/^\s*[-*]\s+(.*)/);
        if (bullet) {
          return (
            <div key={i} className="flex gap-2.5 py-px">
              <span aria-hidden className="mt-[9px] size-1 shrink-0 rounded-full bg-ink-4" />
              <span>{bullet[1]}</span>
            </div>
          );
        }
        if (!line.trim()) return <div key={i} className="h-2" />;
        return (
          <div key={i} className="py-px">
            {line}
          </div>
        );
      })}
    </div>
  );
}
