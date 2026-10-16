"use client";
import React, { useState } from "react";
import { Check, Copy, RotateCw } from "lucide-react";
import { AGENT_IDS, type AgentId, type AgentInfo } from "@/lib/agentModels";
import { useAgents } from "@/lib/useAgents";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { HintText } from "@/components/chat/ModelPicker";
import { Hint, SettingsGroup, SettingsRow, SettingsSection, StatusChip } from "./primitives";

/** Shown until the server has answered once (no cached probe yet). */
const PLACEHOLDER: Record<AgentId, Pick<AgentInfo, "name" | "via">> = {
  claude: { name: "Claude", via: "Claude Code subscription" },
  codex: { name: "Codex", via: "ChatGPT / Codex" },
  gemini: { name: "Gemini", via: "Gemini CLI" },
};

function AgentChip({ agent, checking }: { agent: AgentInfo | undefined; checking: boolean }) {
  if (checking || !agent || agent.status === "checking") {
    return <StatusChip tone="running">Checking</StatusChip>;
  }
  switch (agent.status) {
    case "ready": {
      const n = agent.models.length;
      return <StatusChip tone="done">Ready · {n} {n === 1 ? "model" : "models"}</StatusChip>;
    }
    case "needs_login":
      return <StatusChip tone="queued">Sign in needed</StatusChip>;
    case "not_installed":
      return <StatusChip tone="idle">Not installed</StatusChip>;
    case "error":
      return <StatusChip tone="failed">Error</StatusChip>;
  }
}

/** The setup hint as a sentence, with its first `command` offered as a copyable mono line. */
function SetupHint({ hint }: { hint: string }) {
  const [copied, setCopied] = useState(false);
  const command = hint.split("`")[1]?.trim();

  const copy = () => {
    if (!command) return;
    navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="flex flex-col gap-2 pl-11">
      <Hint>
        <HintText text={hint} />
      </Hint>
      {command && (
        <div className="flex items-center gap-2">
          <code className="min-w-0 truncate rounded-[var(--radius)] bg-paper-sunk px-2.5 py-1 font-mono text-[12px] text-ink shadow-[inset_0_0_0_1px_var(--rule)]">
            {command}
          </code>
          <Button variant="ghost" size="sm" onClick={copy} aria-label={`Copy ${command}`}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** ACP agents: the user's own Claude Code / Codex / Gemini sign-ins, probed by the server. */
export function SubscriptionsPanel() {
  const { agents, loading, fetched, refresh } = useAgents();
  const checking = loading && (!fetched || agents.length === 0);

  return (
    <SettingsSection
      title="Subscriptions"
      description="Buonarroti talks to these through the Agent Client Protocol using your existing sign-in. Tools are switched off; they only write prompts."
    >
      <SettingsGroup>
        {AGENT_IDS.map((id) => {
          const agent = agents.find((a) => a.id === id);
          const { name, via } = agent ?? PLACEHOLDER[id];
          const rowChecking = checking || (loading && agent?.status !== "ready");
          const notReady = !!agent && agent.status !== "ready" && agent.status !== "checking" && !rowChecking;
          return (
            <SettingsRow
              key={id}
              icon={<span className="font-serif text-[15px] leading-none text-ink-2">{name.charAt(0)}</span>}
              label={name}
              description={
                <>
                  {via}
                  {notReady && agent.detail && <span className="text-ink-3"> · {agent.detail}</span>}
                  {!agent && fetched && !loading && <span className="text-ink-3"> · Not reported by this server</span>}
                </>
              }
              control={
                <>
                  <AgentChip agent={agent} checking={rowChecking} />
                  <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
                    <RotateCw className={cn("size-3.5", loading && "animate-spin")} />
                    Check again
                  </Button>
                </>
              }
            >
              {notReady && agent.setupHint && <SetupHint hint={agent.setupHint} />}
              {agent?.status === "ready" && agent.models.length > 0 && (
                <div className="pl-11">
                  <Hint>{agent.models.map((m) => m.name).join(" · ")}</Hint>
                </div>
              )}
            </SettingsRow>
          );
        })}
      </SettingsGroup>
    </SettingsSection>
  );
}
