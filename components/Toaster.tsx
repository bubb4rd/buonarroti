"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Check, Info, AlertTriangle, X } from "lucide-react";
import { useWorkflowStore, Toast } from "@/lib/store";
import { Mark } from "@/components/brand/Mark";
import { cn } from "@/lib/utils";

/** Status pigment per toast type: the left bar and the icon. */
const PIGMENT: Record<Toast["type"], { bar: string; text: string; Icon: typeof Check }> = {
  error:   { bar: "bg-sanguine",  text: "text-sanguine",  Icon: AlertTriangle },
  success: { bar: "bg-verdigris", text: "text-verdigris", Icon: Check },
  info:    { bar: "bg-lapis",     text: "text-lapis",     Icon: Info },
};

const shell =
  "group/toast relative flex w-[340px] overflow-hidden rounded-[var(--radius-lg)] bg-surface-raised text-ink shadow-[var(--shadow-lg)] " +
  "animate-in fade-in-0 slide-in-from-top-2 duration-200 ease-[var(--ease-out)]";

function DismissButton({ onDismiss }: { onDismiss: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onDismiss}
      aria-label="Dismiss"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-ink-4 transition-colors duration-150 hover:bg-wash hover:text-ink-2"
    >
      <X className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}

// Rich notification — used when a toast has a title and a preview line.
function RichToastItem({ toast, onDismiss, onClick }: { toast: Toast; onDismiss: (e: React.MouseEvent) => void; onClick: () => void }) {
  const p = PIGMENT[toast.type];
  return (
    <div onClick={onClick} role="status" className={cn(shell, "cursor-pointer")}>
      <span aria-hidden className={cn("w-[3px] shrink-0", p.bar)} />
      <div className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-2 pl-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius)] bg-paper text-ink shadow-[var(--shadow-sm)]">
          <Mark className="size-6" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium leading-snug text-ink">{toast.title}</span>
          <span className="truncate text-[12.5px] leading-snug text-ink-3">{toast.preview}</span>
        </div>
        <DismissButton onDismiss={onDismiss} />
      </div>
    </div>
  );
}

// Simple toast — errors, info, generic success.
function SimpleToastItem({ toast, onDismiss, onClick }: { toast: Toast; onDismiss: (e: React.MouseEvent) => void; onClick: () => void }) {
  const p = PIGMENT[toast.type];
  return (
    <div
      onClick={onClick}
      role={toast.type === "error" ? "alert" : "status"}
      className={cn(shell, toast.href ? "cursor-pointer" : "cursor-default")}
    >
      <span aria-hidden className={cn("w-[3px] shrink-0", p.bar)} />
      <div className="flex min-w-0 flex-1 items-start gap-2.5 py-2.5 pr-2 pl-3">
        <p.Icon className={cn("mt-[3px] size-[15px] shrink-0", p.text)} strokeWidth={1.75} />
        <span className="flex-1 pt-px text-[13px] leading-[1.45] text-ink">{toast.message}</span>
        <DismissButton onDismiss={onDismiss} />
      </div>
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useWorkflowStore((s) => s.removeToast);
  const router = useRouter();
  const isRich = !!(toast.title && toast.preview);
  const dismissDuration = isRich ? null : toast.href ? 8000 : 4000;

  useEffect(() => {
    if (dismissDuration === null) return;
    const t = setTimeout(() => removeToast(toast.id), dismissDuration);
    return () => clearTimeout(t);
  }, [toast.id, removeToast, dismissDuration]);

  function handleClick() {
    if (toast.href) {
      removeToast(toast.id);
      router.push(toast.href);
    }
  }

  function handleDismiss(e: React.MouseEvent) {
    e.stopPropagation();
    removeToast(toast.id);
  }

  if (isRich) {
    return <RichToastItem toast={toast} onDismiss={handleDismiss} onClick={handleClick} />;
  }

  return <SimpleToastItem toast={toast} onDismiss={handleDismiss} onClick={handleClick} />;
}

export default function Toaster() {
  const toasts = useWorkflowStore((s) => s.toasts);

  return (
    <div
      aria-live="polite"
      className={cn(
        "fixed top-[calc(var(--titlebar-h)+16px)] right-4 z-[99999] flex flex-col gap-2",
        toasts.length ? "pointer-events-auto" : "pointer-events-none",
      )}
    >
      {toasts.map((t) => <ToastItem key={t.id} toast={t} />)}
    </div>
  );
}
