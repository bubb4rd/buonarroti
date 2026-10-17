"use client";

import { Fragment, type ReactNode } from "react";
import { ChevronDown, Settings2 } from "lucide-react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { KEYED_SECTION_LABEL, MODEL_GROUPS, MODELS, keyProviderFor, type ModelId } from "@/lib/models";
import { toAcpModelId, type AgentInfo, type AgentStatus } from "@/lib/agentModels";
import { resolveAcpModel, useAgents, type ResolvedAcpModel } from "@/lib/useAgents";
import { useWorkflowStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Short status phrase for an agent that can't take a prompt right now. */
export const AGENT_STATUS_PHRASE: Record<Exclude<AgentStatus, "ready">, string> = {
  needs_login: "sign in needed",
  not_installed: "not installed",
  error: "couldn't start",
  checking: "checking…",
};

export interface ModelReadiness {
  /** Whether a message can be sent with this model. `null` = still checking. */
  ready: boolean | null;
  azureReady: boolean;
  /** Set for `acp:` (subscription) models. */
  acp: ResolvedAcpModel | null;
}

/** Whether the chosen model can send: kie/Azure models need their key, subscription models a ready agent. */
export function useModelReady(model: ModelId): ModelReadiness {
  const kieKeySet = useWorkflowStore((s) => s.kieKeySet);
  const azureKeySet = useWorkflowStore((s) => s.azureKeySet);
  const { agents, fetched } = useAgents();
  const azureReady = azureKeySet === true;
  const acp = resolveAcpModel(agents, model);
  if (!acp) {
    return { ready: keyProviderFor(model) === "azure" ? azureKeySet : kieKeySet, azureReady, acp };
  }
  let ready: boolean | null;
  if (acp.model) ready = true;
  else if (!acp.agent) ready = fetched ? false : null;
  else ready = acp.agent.status === "checking" ? null : false;
  return { ready, azureReady, acp };
}

export interface ModelLabel {
  label: string;
  /** Agent name for subscription models ("Claude"). */
  source?: string;
  /** A stored subscription model the agent no longer offers (or the agent isn't ready). */
  unavailable: boolean;
}

/** Display name for any stored text-model id; never swaps an unknown id for another model. */
export function useModelLabel(model: ModelId): ModelLabel {
  const { agents, fetched } = useAgents();
  const acp = resolveAcpModel(agents, model);
  if (!acp) return { label: MODELS.find((m) => m.id === model)?.label ?? model, unavailable: false };
  if (acp.model) return { label: acp.model.name, source: acp.agent?.name, unavailable: false };
  return {
    label: acp.modelValue,
    source: acp.agent?.name ?? acp.agentId,
    unavailable: acp.agent ? acp.agent.status !== "checking" : fetched,
  };
}

/** Renders `code` spans in a setup hint ("Run `claude` once…") in mono. */
export function HintText({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="font-mono text-[0.92em] text-ink-2">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function AgentGroupLabel({ agent }: { agent: AgentInfo }) {
  return (
    <DropdownMenuLabel className="gap-1 text-[11.5px] font-normal">
      <span className="text-ink-2">{agent.name}</span>
      <span className="text-ink-3">· {agent.via}</span>
    </DropdownMenuLabel>
  );
}

export function ModelPicker({
  model,
  onChange,
  side = "top",
  variant = "composer",
  disabled,
  className,
}: {
  model: ModelId;
  onChange: (id: ModelId) => void;
  side?: "top" | "bottom";
  /** `node`: the 11px text trigger used on canvas nodes. */
  variant?: "composer" | "node";
  disabled?: boolean;
  className?: string;
}) {
  const { agents, fetched } = useAgents();
  const { azureReady } = useModelReady(model);
  const { label, source, unavailable } = useModelLabel(model);
  const setSettingsOpen = useWorkflowStore((s) => s.setSettingsOpen);
  const readyAgents = agents.filter((a) => a.status === "ready" && a.models.length > 0);
  const otherAgents = agents.filter((a) => !readyAgents.includes(a));

  const triggerLabel: ReactNode = (
    <>
      <span className="truncate">{label}</span>
      {source && <span className="text-ink-3">· {source}</span>}
      {unavailable && <span className="text-ochre">unavailable</span>}
    </>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          variant === "node" ? (
            <button
              type="button"
              className={cn(
                "flex min-w-0 items-center gap-1 text-[11px] text-ink-2 transition-colors hover:text-ink disabled:pointer-events-none",
                className,
              )}
            />
          ) : (
            <Button variant="ghost" size="sm" className={cn("min-w-0 gap-1 text-ink-2", className)} />
          )
        }
        aria-label="Choose model"
      >
        {triggerLabel}
        <ChevronDown className={cn("shrink-0 text-ink-3", variant === "node" ? "size-2.5" : "size-3")} />
      </DropdownMenuTrigger>
      {/* Own positioner so the menu layers above the ⌘K panel (z-[1001]). */}
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          className="isolate z-[1100] outline-none"
          side={side}
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          <MenuPrimitive.Popup className="max-h-(--available-height) w-[300px] origin-(--transform-origin) overflow-y-auto rounded-[var(--radius)] bg-surface-raised p-1 text-ink shadow-[var(--shadow-lg)] outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0">
            <DropdownMenuRadioGroup value={model} onValueChange={(v) => onChange(String(v))}>
              {/* ── Tier 1: the user's own subscriptions (ACP agents) ── */}
              <DropdownMenuLabel className="text-[11.5px] font-medium text-ink-2">Your subscriptions</DropdownMenuLabel>
              {agents.length === 0 && (
                <div className="px-2 pb-1.5 text-[12px] text-ink-3">
                  {fetched ? "Couldn't check your subscriptions." : "Looking for your subscriptions…"}
                </div>
              )}
              {readyAgents.map((agent) => (
                <DropdownMenuGroup key={agent.id}>
                  <AgentGroupLabel agent={agent} />
                  {agent.models.map((m) => {
                    const id = toAcpModelId(agent.id, m.id);
                    return (
                      <DropdownMenuRadioItem key={id} value={id} closeOnClick className="py-1">
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-[13px] text-ink">{m.name}</span>
                          {m.description && (
                            <span className="truncate text-[11.5px] leading-4 text-ink-3" title={m.description}>
                              {m.description}
                            </span>
                          )}
                        </span>
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuGroup>
              ))}
              {otherAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="flex min-h-[30px] flex-col justify-center px-2 py-1"
                  title={agent.setupHint ?? agent.detail}
                >
                  <span className="text-[12.5px] text-ink-3">
                    {agent.name} · {agent.status === "ready" ? "no models offered" : AGENT_STATUS_PHRASE[agent.status]}
                  </span>
                  {agent.status !== "checking" && (agent.setupHint || agent.detail) && (
                    <span className="text-[11.5px] leading-4 text-ink-4">
                      <HintText text={agent.setupHint ?? agent.detail ?? ""} />
                    </span>
                  )}
                </div>
              ))}

              {/* ── Tier 2: keyed models (kie.ai, Azure) ── */}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11.5px] font-medium text-ink-2">{KEYED_SECTION_LABEL}</DropdownMenuLabel>
              {MODEL_GROUPS.map((group) => (
                <DropdownMenuGroup key={group.label}>
                  <DropdownMenuLabel className="text-[11.5px] font-normal text-ink-3">{group.label}</DropdownMenuLabel>
                  {group.models.map((m) => {
                    const needsKey = group.provider === "azure" && !azureReady;
                    return (
                      <DropdownMenuRadioItem key={m.id} value={m.id} disabled={needsKey} closeOnClick className="gap-3 text-[13px]">
                        <span className="text-ink">{m.label}</span>
                        <span className="ml-auto text-[11.5px] text-ink-3">{needsKey ? "Needs Azure key" : m.desc}</span>
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuGroup>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-ink-2" onClick={() => setSettingsOpen(true, "subscriptions")}>
              <Settings2 className="size-3.5 text-ink-3" />
              Manage in Settings
            </DropdownMenuItem>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </DropdownMenu>
  );
}
