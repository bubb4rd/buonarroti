"use client";
import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProviderId } from "@/lib/providers";
import type { AgentId } from "@/lib/agentModels";

export type KeyStatus = "unknown" | "set" | "unset";

/* ─── Section: serif title, ink-2 lede, hairline-divided rows ───────────── */

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <h2 className="type-title text-[22px] text-ink">{title}</h2>
        {description && <p className="max-w-[52ch] text-[13px] leading-relaxed text-ink-2">{description}</p>}
      </header>
      {children}
    </section>
  );
}

/** A card holding rows separated by hairlines. */
export function SettingsGroup({ label, children }: { label?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {label && <div className="text-[11.5px] font-medium text-ink-3">{label}</div>}
      <div className="divide-y divide-rule rounded-[var(--radius-lg)] bg-surface shadow-[var(--shadow-sm)]">
        {children}
      </div>
    </div>
  );
}

/** Label + ink-3 description on the left, control on the right. */
export function SettingsRow({
  label,
  description,
  icon,
  control,
  children,
  htmlFor,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
  htmlFor?: string;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex items-center gap-3">
        {icon && (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius)] bg-wash text-ink-2">
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <Label htmlFor={htmlFor} className="block truncate text-[13.5px] font-medium text-ink">
            {label}
          </Label>
          {description && <div className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{description}</div>}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children}
    </div>
  );
}

/* ─── Status chip (DESIGN.md § Status chips) ────────────────────────────── */

export function StatusChip({
  tone,
  children,
}: {
  tone: "done" | "queued" | "failed" | "running" | "idle";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap",
        tone === "done" && "bg-verdigris/10 text-verdigris",
        tone === "queued" && "bg-ochre/12 text-ochre",
        tone === "failed" && "bg-sanguine/10 text-sanguine",
        tone === "running" && "bg-wash text-ink-2",
        tone === "idle" && "bg-wash text-ink-3"
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full bg-current",
          tone === "running" && "animate-pulse"
        )}
      />
      {children}
    </span>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-[12px] font-medium text-ink-2">
      {children}
    </label>
  );
}

export function Hint({ children, tone = "quiet" }: { children: React.ReactNode; tone?: "quiet" | "error" }) {
  return (
    <p className={cn("m-0 text-[12px] leading-relaxed", tone === "error" ? "text-sanguine" : "text-ink-3")}>
      {children}
    </p>
  );
}

export const linkClass = "text-lapis underline-offset-4 hover:underline";

/* ─── Provider marks ───────────────────────────────────────────────────── */

export function ProviderBrandIcon({ id, size = 14 }: { id: ProviderId; size?: number }) {
  if (id === "kie") {
    // The kie.ai mark (public/brand/kie-mark.png) used as an alpha mask, so it takes the text colour.
    return (
      <span
        aria-hidden
        className="shrink-0 bg-current"
        style={{
          width: size,
          height: size,
          mask: "url(/brand/kie-mark.png) center / contain no-repeat",
          WebkitMask: "url(/brand/kie-mark.png) center / contain no-repeat",
        }}
      />
    );
  }
  if (id === "codex") {
    return (
      <svg className="shrink-0" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd">
        <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
      </svg>
    );
  }
  if (id === "azure") {
    return (
      <svg className="shrink-0" width={size} height={size} viewBox="0 0 256 199" fill="currentColor">
        <path d="M118.432 187.698c32.89-5.81 60.055-10.618 60.367-10.684l.568-.12l-31.052-36.935c-17.078-20.314-31.051-37.014-31.051-37.11c0-.182 32.063-88.477 32.243-88.792c.06-.105 21.88 37.567 52.893 91.32c29.035 50.323 52.973 91.815 53.195 92.203l.405.707l-98.684-.012l-98.684-.013l59.8-10.564zM0 176.435c0-.052 14.631-25.451 32.514-56.442l32.514-56.347l37.891-31.799C123.76 14.358 140.867.027 140.935.001c.069-.026-.205.664-.609 1.534s-18.919 40.582-41.145 88.25l-40.41 86.67l-29.386.037c-16.162.02-29.385-.005-29.385-.057z" />
      </svg>
    );
  }
  return null;
}

/** Subscription agents (Claude Code, Codex, Gemini CLI); Codex shares the OpenAI mark with the Codex CLI backend. */
export function AgentBrandIcon({ id, size = 14 }: { id: AgentId; size?: number }) {
  if (id === "codex") return <ProviderBrandIcon id="codex" size={size} />;
  if (id === "claude") {
    return (
      <svg aria-hidden className="shrink-0" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd">
        <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
      </svg>
    );
  }
  return (
    <svg aria-hidden className="shrink-0" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" />
    </svg>
  );
}

/* ─── Masked secret field: paste → Save, or saved → Remove ──────────────── */

export function SecretField({
  id,
  status,
  placeholder,
  onSave,
  onRemove,
}: {
  id: string;
  status: KeyStatus;
  placeholder: string;
  onSave: (value: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const v = value.trim();
    if (!v || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(v);
      setValue("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "The key could not be saved. Check it and try again.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await onRemove();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "The key could not be removed. Try again.");
    } finally {
      setRemoving(false);
    }
  };

  if (status === "unknown") {
    return (
      <div className="flex gap-2" aria-busy>
        <div className="ink-shimmer h-8 flex-1 rounded-[var(--radius)]" />
        <div className="ink-shimmer h-8 w-[72px] rounded-[var(--radius)]" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {status === "set" ? (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="password"
            value="••••••••••••••••"
            readOnly
            aria-label="Saved key"
            className="flex-1 cursor-default bg-paper-sunk text-ink-3"
          />
          <Button variant="danger" onClick={remove} disabled={removing}>
            {removing ? "Removing…" : "Remove"}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={value}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            className="flex-1 font-mono placeholder:font-sans"
          />
          <Button variant="primary" onClick={save} disabled={!value.trim() || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
      {error && <Hint tone="error">{error}</Hint>}
    </div>
  );
}
