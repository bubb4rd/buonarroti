"use client";
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Hint,
  ProviderBrandIcon,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  StatusChip,
  linkClass,
} from "./primitives";

export type CodexStatus =
  | { kind: "unknown" }
  | { kind: "ready" }
  | { kind: "not_ready"; installed: boolean; authFound: boolean };

type CodexLoginFlow =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "pending"; url: string; code: string }
  | { status: "error"; error: string };

const CLI_LINK = (
  <a href="https://github.com/jdmnk/codex-imagegen-cli" target="_blank" rel="noreferrer" className={linkClass}>
    codex-imagegen-cli
  </a>
);

/** Codex CLI: uses the server's local `codex login` session — no per-user key. */
export function CodexPanel({
  codexStatus,
  onCodexLoginSuccess,
}: {
  codexStatus: CodexStatus;
  onCodexLoginSuccess: () => void;
}) {
  const [loginFlow, setLoginFlow] = useState<CodexLoginFlow>({ status: "idle" });
  const [codeCopied, setCodeCopied] = useState(false);

  const handleConnectCodex = async () => {
    setLoginFlow({ status: "starting" });
    try {
      const res = await fetch("/api/settings/codex-login", { method: "POST" });
      const d = await res.json();
      if (d.status === "pending") setLoginFlow({ status: "pending", url: d.url, code: d.code });
      else setLoginFlow({ status: "error", error: d.error ?? "Sign-in could not start. Try again." });
    } catch (e: unknown) {
      setLoginFlow({ status: "error", error: e instanceof Error ? e.message : "Sign-in could not start. Try again." });
    }
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCodeCopied(true);
        setTimeout(() => setCodeCopied(false), 1500);
      })
      .catch(() => {});
  };

  /* Poll while a device-code login is pending, until it resolves */
  useEffect(() => {
    if (loginFlow.status !== "pending") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/settings/codex-login");
        const d = await res.json();
        if (d.status === "success") {
          setLoginFlow({ status: "idle" });
          onCodexLoginSuccess();
        } else if (d.status === "error") {
          // The login-store verdict can race the credential write. Before showing
          // an error, confirm against codex-status (which checks auth.json on disk).
          let recovered = false;
          try {
            const s = await fetch("/api/settings/codex-status").then((r) => r.json());
            if (s.ready || s.authFound) recovered = true;
          } catch { /* fall through to error */ }
          if (recovered) {
            setLoginFlow({ status: "idle" });
            onCodexLoginSuccess();
          } else {
            setLoginFlow({ status: "error", error: d.error ?? "Sign-in didn't finish. Try again." });
          }
        }
        // "pending" → keep polling
      } catch { /* network hiccup — keep polling */ }
    }, 2500);
    return () => clearInterval(interval);
  }, [loginFlow.status, onCodexLoginSuccess]);

  const idle = loginFlow.status === "idle";

  return (
    <SettingsSection
      title="Codex"
      description={
        <>
          Codex image models use this server&apos;s local <code className="font-mono text-[12px]">codex login</code>{" "}
          session, so there is no key to paste.
        </>
      }
    >
      <SettingsGroup>
        <SettingsRow
          icon={<ProviderBrandIcon id="codex" size={15} />}
          label="Codex CLI"
          description={
            codexStatus.kind === "ready"
              ? "Signed in on this server."
              : codexStatus.kind === "unknown"
                ? "Checking this server…"
                : "Not set up on this server yet."
          }
          control={
            codexStatus.kind === "unknown" ? (
              <StatusChip tone="running">Checking</StatusChip>
            ) : codexStatus.kind === "ready" ? (
              <StatusChip tone="done">Ready</StatusChip>
            ) : (
              <StatusChip tone="queued">Not set up</StatusChip>
            )
          }
        />

        {/* auth.json can exist but hold a stale refresh token ("session has ended"
            401). The status check only sees the file, so offer a manual reauth. */}
        {codexStatus.kind === "ready" && idle && (
          <SettingsRow
            label="Sign in again"
            description="Seeing “session has ended” or a 401 error? Signing in again usually fixes it."
            control={<Button onClick={handleConnectCodex}>Reauthenticate</Button>}
          />
        )}

        {/* Starting a login invalidates any existing session on this host, so only
            offer it when auth is actually missing. */}
        {codexStatus.kind === "not_ready" && !codexStatus.authFound && idle && (
          <SettingsRow
            label="Connect Codex"
            description={<>Needs {CLI_LINK} installed on this server.</>}
            control={
              <Button variant="primary" onClick={handleConnectCodex}>
                Connect
              </Button>
            }
          />
        )}

        {codexStatus.kind === "not_ready" && codexStatus.authFound && !codexStatus.installed && idle && (
          <div className="px-4 py-3.5">
            <Hint>
              You&apos;re signed in, but {CLI_LINK} isn&apos;t installed on this server yet. Codex images will fail
              until it is.
            </Hint>
          </div>
        )}

        {loginFlow.status === "starting" && (
          <div className="px-4 py-3.5">
            <Hint>Starting sign-in…</Hint>
          </div>
        )}

        {loginFlow.status === "pending" && (
          <div className="flex flex-col gap-3 px-4 py-4">
            <ol className="m-0 flex list-decimal flex-col gap-1 pl-4 text-[13px] leading-relaxed text-ink-2">
              <li>
                Open{" "}
                <a href={loginFlow.url} target="_blank" rel="noreferrer" className={`${linkClass} break-all`}>
                  {loginFlow.url}
                </a>
              </li>
              <li>Enter this one-time code:</li>
            </ol>
            <div className="flex items-center gap-2">
              <span className="rounded-[var(--radius)] bg-paper-sunk px-3 py-1.5 font-mono text-[16px] font-semibold tracking-[0.08em] text-ink shadow-[inset_0_0_0_1px_var(--rule)]">
                {loginFlow.code}
              </span>
              <Button size="sm" onClick={() => handleCopyCode(loginFlow.code)}>
                {codeCopied ? "Copied" : "Copy"}
              </Button>
            </div>
            <Hint>Waiting for you to confirm. The code expires in 15 minutes.</Hint>
          </div>
        )}

        {loginFlow.status === "error" && (
          <SettingsRow
            label="Sign-in didn't finish"
            description={<span className="text-sanguine">{loginFlow.error}</span>}
            control={<Button onClick={handleConnectCodex}>Try again</Button>}
          />
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
