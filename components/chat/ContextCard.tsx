"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AssistantContext } from "@/lib/chatSessionStore";
import { IMAGE_MODELS, VIDEO_MODELS } from "@/lib/modelConfig";
import { cn } from "@/lib/utils";

const HEADINGS: Record<AssistantContext["source"], string> = {
  composer: "Your draft in the composer",
  result: "An image you made",
  upload: "An image you uploaded",
};

/**
 * What a chat was opened about: the assistant reads the same facts in its
 * instructions, so the user can see (and drop) what it is working from.
 */
export function ContextCard({
  context,
  onDetach,
  compact = false,
}: {
  context: AssistantContext;
  onDetach?: () => void;
  compact?: boolean;
}) {
  const model = (context.tab === "videos" ? VIDEO_MODELS : IMAGE_MODELS).find((m) => m.id === context.model);
  const heading = context.resultIsVideo ? "A video you made" : HEADINGS[context.source];
  const meta = [model?.name, context.aspectRatio && context.aspectRatio !== "auto" ? context.aspectRatio : null]
    .filter(Boolean)
    .join(" · ");
  const prompt = context.prompt?.replace(/\s+/g, " ").trim();

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-[var(--radius-lg)] bg-surface shadow-[var(--shadow-sm)]",
        compact ? "py-2 pr-1.5 pl-3" : "py-2.5 pr-2 pl-3.5",
      )}
    >
      <div className="min-w-0 flex-1 py-0.5">
        <p className="truncate text-[12px] text-ink-3">
          <span className="text-ink-2">{heading}</span>
          {meta && ` · ${meta}`}
        </p>
        {prompt && <p className="mt-0.5 line-clamp-2 text-[13px] leading-[1.45] text-ink-2">{prompt}</p>}
      </div>
      {onDetach && (
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" className="text-ink-3" aria-label="Stop using this context" onClick={onDetach} />}
          >
            <X />
          </TooltipTrigger>
          <TooltipContent>Stop using this context</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
