"use client";
import React from "react";
import { setThemePreference, useTheme, type ThemePreference } from "@/lib/theme";
import { useWorkflowStore } from "@/lib/store";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow, SettingsSection } from "./primitives";

/** A tiny window drawn in the target theme's own tokens (scoped via data-theme). */
function ThemeSwatch({ theme }: { theme: "paper" | "ink" }) {
  return (
    <span
      data-theme={theme}
      aria-hidden
      className="flex h-11 w-16 overflow-hidden rounded-[var(--radius-sm)] bg-paper-sunk shadow-[inset_0_0_0_1px_var(--rule-strong)]"
    >
      <span className="flex w-4 flex-col gap-1 p-1">
        <span className="h-0.5 rounded-full bg-ink-4" />
        <span className="h-0.5 rounded-full bg-ink-4" />
        <span className="h-0.5 rounded-full bg-ink-4" />
      </span>
      <span className="my-1 mr-1 flex flex-1 flex-col gap-1 rounded-[3px] bg-paper p-1.5 shadow-[var(--shadow-sm)]">
        <span className="h-1 w-3/4 rounded-full bg-ink" />
        <span className="h-0.5 w-1/2 rounded-full bg-ink-3" />
        <span className="mt-auto h-1.5 w-1/3 self-end rounded-full bg-lapis" />
      </span>
    </span>
  );
}

const THEME_CHOICES: { value: ThemePreference; label: string; hint: string }[] = [
  { value: "paper", label: "Paper", hint: "Warm off-white" },
  { value: "ink", label: "Ink", hint: "Low light" },
  { value: "system", label: "System", hint: "Follows macOS" },
];

export function AppearancePanel() {
  const { preference } = useTheme();

  return (
    <SettingsSection title="Appearance" description="Choose how Buonarroti looks. Changes apply right away.">
      <SettingsGroup>
        <SettingsRow
          label="Theme"
          description="Paper for daylight, Ink for evenings, or follow your system."
          control={
            <Segmented
              aria-label="Theme"
              value={preference}
              onChange={setThemePreference}
              options={THEME_CHOICES.map(({ value, label }) => ({ value, label }))}
            />
          }
        >
          <div className="grid grid-cols-3 gap-3 pt-1">
            {THEME_CHOICES.map((c) => {
              const active = preference === c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setThemePreference(c.value)}
                  className={cn(
                    "flex flex-col items-start gap-2 rounded-[var(--radius-lg)] p-2.5 text-left transition-[background-color,box-shadow] duration-150 outline-none focus-visible:shadow-[var(--focus-ring)]",
                    active
                      ? "bg-lapis-soft shadow-[inset_0_0_0_1.5px_var(--lapis)]"
                      : "shadow-[inset_0_0_0_1px_var(--rule)] hover:bg-wash"
                  )}
                >
                  {c.value === "system" ? (
                    <span className="flex">
                      <span className="w-8 overflow-hidden">
                        <ThemeSwatch theme="paper" />
                      </span>
                      <span className="flex w-8 justify-end overflow-hidden">
                        <ThemeSwatch theme="ink" />
                      </span>
                    </span>
                  ) : (
                    <ThemeSwatch theme={c.value} />
                  )}
                  <span className="flex flex-col">
                    <span className={cn("text-[13px] font-medium", active ? "text-lapis" : "text-ink")}>{c.label}</span>
                    <span className="text-[11.5px] text-ink-3">{c.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}

/** Only mounted when NEXT_PUBLIC_DEBUG=true. */
export function DebugPanel() {
  const debugMode = useWorkflowStore((s) => s.debugMode);
  const toggleDebug = useWorkflowStore((s) => s.toggleDebug);

  return (
    <SettingsSection
      title="Debug"
      description={
        <>
          Visible because <code className="font-mono text-[12px]">NEXT_PUBLIC_DEBUG=true</code>.
        </>
      }
    >
      <SettingsGroup>
        <SettingsRow
          label="Simulate generation"
          description="Skip the real API call. Fakes a five-second generation and logs the payload to the server console."
          control={<Switch checked={debugMode} onCheckedChange={() => toggleDebug()} aria-label="Simulate generation" />}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
