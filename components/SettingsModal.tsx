"use client";
import React, { useCallback, useEffect, useState } from "react";
import { KeyRound, Image as ImageIcon, Clapperboard, MessageSquare, Palette, Plug, TerminalSquare, Bug } from "lucide-react";
import { useWorkflowStore, type SettingsSectionId } from "@/lib/store";
import { ProviderId, loadModelProviders, saveModelProviders } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { KeyStatus } from "@/components/settings/primitives";
import { ProvidersPanel } from "@/components/settings/ProvidersPanel";
import { CodexPanel, type CodexStatus } from "@/components/settings/CodexPanel";
import { ImageModelsPanel, TextModelsPanel, VideoModelsPanel } from "@/components/settings/ModelsPanels";
import { AppearancePanel, DebugPanel } from "@/components/settings/AppearancePanel";
import { SubscriptionsPanel } from "@/components/settings/SubscriptionsPanel";

/* ─── Persistence ───────────────────────────────────────────────────────────── */

const AZURE_DEPLOYS_KEY      = "aiui-azure-endpoints";       // per-model deployment names
const AZURE_BASE_KEY         = "aiui-azure-base-url";        // global Foundry base URL
const AZURE_TEXT_DEPLOY_KEY  = "aiui-azure-text-deployment"; // text model deployment (URL path)
const AZURE_TEXT_MODEL_KEY   = "aiui-azure-text-model";      // text model name (request body)

/** Per-model deployment name map (e.g. { "gpt-image-2": "gpt-image-2" }). */
export function loadAzureEndpoints(): Record<string, string> {
  try {
    const raw = localStorage.getItem(AZURE_DEPLOYS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveAzureEndpoints(map: Record<string, string>) {
  try {
    localStorage.setItem(AZURE_DEPLOYS_KEY, JSON.stringify(map));
  } catch { /* noop */ }
}

/** Returns the deployment name for a given model, or "" if unset. */
export function getAzureDeployment(modelId: string): string {
  return loadAzureEndpoints()[modelId] ?? "";
}

/** Global Azure Cognitive Services base URL (shared across all models). */
export function loadAzureBaseUrl(): string {
  try {
    return localStorage.getItem(AZURE_BASE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveAzureBaseUrl(url: string) {
  try {
    localStorage.setItem(AZURE_BASE_KEY, url);
  } catch { /* noop */ }
}

/** Deployment name — used in the URL path (defaults to "auto-model"). */
export function loadAzureTextDeployment(): string {
  try {
    return localStorage.getItem(AZURE_TEXT_DEPLOY_KEY) ?? "auto-model";
  } catch {
    return "auto-model";
  }
}

export function saveAzureTextDeployment(name: string) {
  try {
    localStorage.setItem(AZURE_TEXT_DEPLOY_KEY, name);
  } catch { /* noop */ }
}

/** Model name — passed in the request body (defaults to "model-router"). */
export function loadAzureTextModelName(): string {
  try {
    return localStorage.getItem(AZURE_TEXT_MODEL_KEY) ?? "model-router";
  } catch {
    return "model-router";
  }
}

export function saveAzureTextModelName(name: string) {
  try {
    localStorage.setItem(AZURE_TEXT_MODEL_KEY, name);
  } catch { /* noop */ }
}


/* ─── Sections ──────────────────────────────────────────────────────────────── */

const IS_DEBUG = process.env.NEXT_PUBLIC_DEBUG === "true";

type NavId = SettingsSectionId;

const NAV: { id: NavId; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }> }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "api-keys", label: "API keys", icon: KeyRound },
  { id: "subscriptions", label: "Subscriptions", icon: Plug },
  { id: "codex", label: "Codex", icon: TerminalSquare },
  { id: "image-models", label: "Image models", icon: ImageIcon },
  { id: "video-models", label: "Video models", icon: Clapperboard },
  { id: "text-models", label: "Text models", icon: MessageSquare },
  ...(IS_DEBUG ? [{ id: "debug" as const, label: "Debug", icon: Bug }] : []),
];

/* ─── Modal ─────────────────────────────────────────────────────────────────── */

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const section = useWorkflowStore((s) => s.settingsSection);
  const setActiveNav = useWorkflowStore((s) => s.setSettingsSection);
  const activeNav: NavId = section === "debug" && !IS_DEBUG ? "appearance" : section;
  // Mounted only while open (client-side), so localStorage can seed state directly.
  const [modelProviders, setModelProviders] = useState<Record<string, ProviderId>>(loadModelProviders);
  const [azureDeployments, setAzureDeployments] = useState<Record<string, string>>(loadAzureEndpoints);
  const [azureBaseUrl, setAzureBaseUrl] = useState(loadAzureBaseUrl);
  const [azureTextDeployment, setAzureTextDeployment] = useState(loadAzureTextDeployment);
  const [azureTextModelName, setAzureTextModelName] = useState(loadAzureTextModelName);
  const [kieKeyStatus, setKieKeyStatus] = useState<KeyStatus>("unknown");
  const [azureKeyStatus, setAzureKeyStatus] = useState<KeyStatus>("unknown");
  const [codexStatus, setCodexStatus] = useState<CodexStatus>({ kind: "unknown" });
  const setKieKeySet = useWorkflowStore((s) => s.setKieKeySet);
  const setAzureKeySet = useWorkflowStore((s) => s.setAzureKeySet);

  const refreshCodexStatus = useCallback(() => {
    fetch("/api/settings/codex-status")
      .then((r) => r.json())
      .then((d: { ready: boolean; installed: boolean; authFound: boolean }) =>
        setCodexStatus(d.ready ? { kind: "ready" } : { kind: "not_ready", installed: d.installed, authFound: d.authFound })
      )
      .catch(() => setCodexStatus({ kind: "not_ready", installed: false, authFound: false }));
  }, []);

  /* Ask the server which keys and logins it has */
  useEffect(() => {
    fetch("/api/settings/kie-key")
      .then((r) => r.json())
      .then((d) => setKieKeyStatus(d.hasToken ? "set" : "unset"))
      .catch(() => setKieKeyStatus("unset"));
    fetch("/api/settings/azure-key")
      .then((r) => r.json())
      .then((d) => setAzureKeyStatus(d.hasToken ? "set" : "unset"))
      .catch(() => setAzureKeyStatus("unset"));
    refreshCodexStatus();
  }, [refreshCodexStatus]);

  const handleProviderChange = (modelId: string, v: ProviderId) => {
    const next = { ...modelProviders, [modelId]: v };
    saveModelProviders(next);
    setModelProviders(next);
  };

  const handleDeploymentChange = (modelId: string, v: string) => {
    setAzureDeployments((prev) => {
      const next = { ...prev, [modelId]: v };
      saveAzureEndpoints(next);
      return next;
    });
  };

  const handleBaseUrlChange = (v: string) => {
    setAzureBaseUrl(v);
    saveAzureBaseUrl(v);
  };

  const saveKey = async (path: string, body: Record<string, string>) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? "The key could not be saved. Check it and try again.");
    }
  };

  const deleteKey = async (path: string) => {
    const res = await fetch(path, { method: "DELETE" });
    if (!res.ok) throw new Error("The key could not be removed. Try again.");
  };

  const handleKieKeySave = async (token: string) => {
    await saveKey("/api/settings/kie-key", { kieApiToken: token });
    setKieKeyStatus("set");
    setKieKeySet(true);
  };

  const handleKieKeyDelete = async () => {
    await deleteKey("/api/settings/kie-key");
    setKieKeyStatus("unset");
    setKieKeySet(false);
  };

  const handleAzureKeySave = async (key: string) => {
    await saveKey("/api/settings/azure-key", { azureApiKey: key });
    setAzureKeyStatus("set");
    setAzureKeySet(true);
  };

  const handleAzureKeyDelete = async () => {
    await deleteKey("/api/settings/azure-key");
    setAzureKeyStatus("unset");
    setAzureKeySet(false);
  };

  const handleAzureTextDeploymentChange = (v: string) => {
    setAzureTextDeployment(v);
    saveAzureTextDeployment(v);
  };

  const handleAzureTextModelNameChange = (v: string) => {
    setAzureTextModelName(v);
    saveAzureTextModelName(v);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        id="settings-modal"
        className="max-h-none w-[min(92vw,860px)] h-[min(86vh,660px)] flex-row"
      >
        {/* ── Section list ── */}
        <nav className="flex w-[196px] shrink-0 flex-col gap-0.5 bg-paper-sunk px-2.5 pt-5 pb-3" aria-label="Settings sections">
          <DialogTitle className="px-2.5 pb-4 text-[19px]">Settings</DialogTitle>
          {NAV.map(({ id, label, icon: Icon }) => {
            const active = activeNav === id;
            return (
              <button
                key={id}
                id={`settings-nav-${id}`}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => setActiveNav(id)}
                className={cn(
                  "flex h-[30px] w-full items-center gap-2.5 rounded-[var(--radius)] px-2.5 text-left text-[13.5px] transition-colors duration-150 outline-none focus-visible:shadow-[var(--focus-ring)]",
                  active ? "bg-wash-strong text-ink" : "text-ink-2 hover:bg-wash hover:text-ink"
                )}
              >
                <Icon className={cn("size-4 shrink-0", active ? "text-ink" : "text-ink-3")} strokeWidth={1.75} />
                {label}
              </button>
            );
          })}
          <div className="mt-auto flex items-center gap-2 px-2.5 text-[12px] text-ink-3">
            <span
              className={cn(
                "size-1.5 rounded-full",
                kieKeyStatus === "set" ? "bg-verdigris" : kieKeyStatus === "unset" ? "bg-ochre" : "bg-ink-4"
              )}
            />
            {kieKeyStatus === "set" ? "kie.ai · connected" : kieKeyStatus === "unset" ? "kie.ai · no key" : "kie.ai · checking"}
          </div>
        </nav>

        {/* ── Pane ── */}
        <div className="min-w-0 flex-1 overflow-y-auto border-l border-rule bg-surface-raised px-8 pt-7 pb-10">
          {activeNav === "appearance" && <AppearancePanel />}
          {activeNav === "api-keys" && (
            <ProvidersPanel
              kieKeyStatus={kieKeyStatus}
              onKieKeySave={handleKieKeySave}
              onKieKeyDelete={handleKieKeyDelete}
              azureKeyStatus={azureKeyStatus}
              onAzureKeySave={handleAzureKeySave}
              onAzureKeyDelete={handleAzureKeyDelete}
              azureBaseUrl={azureBaseUrl}
              onBaseUrlChange={handleBaseUrlChange}
            />
          )}
          {activeNav === "subscriptions" && <SubscriptionsPanel />}
          {activeNav === "codex" && (
            <CodexPanel codexStatus={codexStatus} onCodexLoginSuccess={refreshCodexStatus} />
          )}
          {activeNav === "image-models" && (
            <ImageModelsPanel
              providers={modelProviders}
              onProviderChange={handleProviderChange}
              azureDeployments={azureDeployments}
              onDeploymentChange={handleDeploymentChange}
            />
          )}
          {activeNav === "video-models" && (
            <VideoModelsPanel
              providers={modelProviders}
              onProviderChange={handleProviderChange}
              azureDeployments={azureDeployments}
              onDeploymentChange={handleDeploymentChange}
            />
          )}
          {activeNav === "text-models" && (
            <TextModelsPanel
              azureKeyStatus={azureKeyStatus}
              azureBaseUrl={azureBaseUrl}
              azureTextDeployment={azureTextDeployment}
              azureTextModelName={azureTextModelName}
              onDeploymentChange={handleAzureTextDeploymentChange}
              onModelNameChange={handleAzureTextModelNameChange}
            />
          )}
          {activeNav === "debug" && IS_DEBUG && <DebugPanel />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
