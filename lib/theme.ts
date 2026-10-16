"use client";

import { useSyncExternalStore } from "react";

/** User-facing appearance choice. "paper" = light, "ink" = dark. */
export type ThemePreference = "paper" | "ink" | "system";
export type ResolvedTheme = "paper" | "ink";

export const THEME_STORAGE_KEY = "buonarroti-theme";

/**
 * Runs before hydration (inlined in <head>) so the first paint already has
 * the right ground — no flash of the wrong theme. Keep it dependency-free.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_STORAGE_KEY}")||"system";var d=p==="ink"||(p==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"ink":"paper";document.documentElement.dataset.themePref=p;}catch(e){document.documentElement.dataset.theme="paper";}})();`;

const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  if (typeof document === "undefined") return "system";
  const p = document.documentElement.dataset.themePref;
  return p === "paper" || p === "ink" ? p : "system";
}

function resolve(pref: ThemePreference): ResolvedTheme {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "ink" : "paper";
}

function apply(pref: ThemePreference) {
  const root = document.documentElement;
  root.dataset.themePref = pref;
  root.dataset.theme = resolve(pref);
  listeners.forEach((l) => l());
}

let mediaBound = false;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!mediaBound && typeof window !== "undefined") {
    mediaBound = true;
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (readPreference() === "system") apply("system");
      });
    window.addEventListener("storage", (e) => {
      if (e.key === THEME_STORAGE_KEY) apply((e.newValue as ThemePreference) || "system");
    });
  }
  return () => listeners.delete(listener);
}

export function setThemePreference(pref: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Storage full or unavailable: the choice still applies for this session.
  }
  apply(pref);
}

/** Current preference and the theme actually painted. */
export function useTheme(): { preference: ThemePreference; theme: ResolvedTheme } {
  const preference = useSyncExternalStore(subscribe, readPreference, () => "system" as const);
  const theme = useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme === "ink" ? "ink" : "paper") as ResolvedTheme,
    () => "paper" as const,
  );
  return { preference, theme };
}
