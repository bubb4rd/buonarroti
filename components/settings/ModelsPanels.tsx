"use client";
import React from "react";
import { IMAGE_MODELS, VIDEO_MODELS } from "@/lib/modelConfig";
import { MODEL_GROUPS } from "@/lib/models";
import { PROVIDERS, type ProviderId } from "@/lib/providers";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import {
  FieldLabel,
  Hint,
  KeyStatus,
  ProviderBrandIcon,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  StatusChip,
} from "./primitives";

interface RoutedModel {
  id: string;
  name: string;
  provider: string;
  hasAzureDeployment: boolean;
}

interface RoutingProps {
  providers: Record<string, ProviderId>;
  onProviderChange: (modelId: string, v: ProviderId) => void;
  azureDeployments: Record<string, string>;
  onDeploymentChange: (modelId: string, v: string) => void;
}

const PROVIDER_OPTIONS = PROVIDERS.map((p) => ({
  value: p.id,
  label: p.label,
  icon: <ProviderBrandIcon id={p.id} size={12} />,
}));

function ModelRoutingList({
  models,
  kind,
  providers,
  onProviderChange,
  azureDeployments,
  onDeploymentChange,
}: RoutingProps & { models: RoutedModel[]; kind: string }) {
  return (
    <SettingsGroup>
      {models.map((m) => {
        const value = providers[m.id] ?? "kie";
        return (
          <SettingsRow
            key={m.id}
            label={m.name}
            description={`${m.provider} · ${kind}`}
            control={
              // Provider choice only for models with more than one backend.
              m.hasAzureDeployment ? (
                <Segmented
                  size="sm"
                  aria-label={`Provider for ${m.name}`}
                  value={value}
                  onChange={(v) => onProviderChange(m.id, v)}
                  options={PROVIDER_OPTIONS}
                />
              ) : undefined
            }
          >
            {m.hasAzureDeployment && value === "azure" && (
              <div className="flex flex-col gap-1.5 rounded-[var(--radius)] bg-paper-sunk p-3">
                <FieldLabel htmlFor={`azure-deploy-${m.id}`}>Deployment name</FieldLabel>
                <Input
                  id={`azure-deploy-${m.id}`}
                  type="text"
                  spellCheck={false}
                  placeholder={`e.g. ${m.id}`}
                  value={azureDeployments[m.id] ?? ""}
                  onChange={(e) => onDeploymentChange(m.id, e.target.value)}
                  className="font-mono text-[12.5px] tabular-nums"
                />
                <Hint>The deployment inside your Azure resource. Combined with the base URL under API keys.</Hint>
              </div>
            )}
          </SettingsRow>
        );
      })}
    </SettingsGroup>
  );
}

export function ImageModelsPanel(props: RoutingProps) {
  const models = IMAGE_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    hasAzureDeployment: !!m.azureSizeMap,
  }));
  return (
    <SettingsSection
      title="Image models"
      description="Choose which provider serves each image model. When you pick Azure, add the deployment name."
    >
      <ModelRoutingList {...props} models={models} kind="Image" />
    </SettingsSection>
  );
}

export function VideoModelsPanel(props: RoutingProps) {
  const models = VIDEO_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    hasAzureDeployment: false,
  }));
  return (
    <SettingsSection title="Video models" description="Every video model is served by kie.ai.">
      <ModelRoutingList {...props} models={models} kind="Video" />
    </SettingsSection>
  );
}

export function TextModelsPanel({
  azureKeyStatus,
  azureBaseUrl,
  azureTextDeployment,
  azureTextModelName,
  onDeploymentChange,
  onModelNameChange,
}: {
  azureKeyStatus: KeyStatus;
  azureBaseUrl: string;
  azureTextDeployment: string;
  azureTextModelName: string;
  onDeploymentChange: (v: string) => void;
  onModelNameChange: (v: string) => void;
}) {
  const azureReady = azureKeyStatus === "set" && !!azureBaseUrl.trim();
  const kieGroups = MODEL_GROUPS.filter((g) => g.label !== "Azure");

  return (
    <SettingsSection
      title="Text models"
      description="The models the assistant can chat with. Azure Auto uses your Azure Foundry key and base URL."
    >
      {kieGroups.map((group) => (
        <SettingsGroup key={group.label} label={group.label}>
          {group.models.map((m) => (
            <SettingsRow
              key={m.id}
              label={m.label}
              description={m.desc}
              control={<span className="text-[12px] text-ink-3">kie.ai</span>}
            />
          ))}
        </SettingsGroup>
      ))}

      <SettingsGroup label="Azure">
        <SettingsRow
          icon={<ProviderBrandIcon id="azure" size={15} />}
          label="Azure Auto"
          description="Model router. Picks a suitable model for each request."
          control={
            azureReady ? <StatusChip tone="done">Ready</StatusChip> : <StatusChip tone="queued">Not set up</StatusChip>
          }
        >
          {!azureReady && (
            <Hint>
              {azureKeyStatus !== "set"
                ? "Add your Azure Foundry key under API keys to use this model."
                : "Add your Azure Foundry base URL under API keys to use this model."}
            </Hint>
          )}
        </SettingsRow>
        <div className="grid grid-cols-2 gap-3 px-4 py-3.5">
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="azure-text-model-name">Model name</FieldLabel>
            <Input
              id="azure-text-model-name"
              type="text"
              spellCheck={false}
              placeholder="model-router"
              value={azureTextModelName}
              onChange={(e) => onModelNameChange(e.target.value)}
              className="font-mono text-[12.5px]"
            />
            <Hint>
              Sent as <code className="font-mono">model</code> in the request body.
            </Hint>
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="azure-text-deployment">Deployment</FieldLabel>
            <Input
              id="azure-text-deployment"
              type="text"
              spellCheck={false}
              placeholder="auto-model"
              value={azureTextDeployment}
              onChange={(e) => onDeploymentChange(e.target.value)}
              className="font-mono text-[12.5px]"
            />
            <Hint>
              Used in the path <code className="font-mono">/deployments/{"{deployment}"}</code>.
            </Hint>
          </div>
        </div>
        <SettingsRow
          label="API version"
          control={<code className="font-mono text-[12px] text-ink-3">2024-04-01-preview</code>}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
