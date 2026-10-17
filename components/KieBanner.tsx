"use client";
import { useWorkflowStore } from "@/lib/store";
import { Notice } from "@/components/ui/notice";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

/** Shown while no kie.ai key is saved; generation needs one. */
export default function KieBanner() {
  const kieKeySet = useWorkflowStore((s) => s.kieKeySet);
  const setSettingsOpen = useWorkflowStore((s) => s.setSettingsOpen);

  if (kieKeySet !== false) return null;

  return (
    <Notice
      tone="ochre"
      action={
        <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true, "api-keys")}>
          Add key <Kbd>⌘,</Kbd>
        </Button>
      }
    >
      <span className="text-ink">Add your kie.ai key to start making.</span>{" "}
      <span className="max-sm:hidden">Generation stays off until it is saved in Settings.</span>
    </Notice>
  );
}
