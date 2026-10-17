"use client";

import { useSyncExternalStore } from "react";

/**
 * Small UI preferences shared across screens, stored as one JSON object in
 * localStorage. Each owner reads and writes only its own field; writes merge,
 * so one preference never clobbers another.
 */
export interface UiPrefs {
  quickAssistMinimized?: boolean;
  composerCollapsed?: boolean;
}

const KEY = "buonarroti-ui";
const listeners = new Set<() => void>();

function readAll(): UiPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as UiPrefs) : {};
  } catch {
    return {};
  }
}

export function getUiPref<K extends keyof UiPrefs>(key: K): UiPrefs[K] {
  if (typeof window === "undefined") return undefined;
  return readAll()[key];
}

export function setUiPref<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [key]: value }));
  } catch {
    // Storage full or blocked: the preference lasts for this page only.
  }
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** A persisted UI preference; `fallback` during server rendering and until set. */
export function useUiPref<K extends keyof UiPrefs>(key: K, fallback: NonNullable<UiPrefs[K]>): NonNullable<UiPrefs[K]> {
  return useSyncExternalStore(
    subscribe,
    () => getUiPref(key) ?? fallback,
    () => fallback,
  );
}
