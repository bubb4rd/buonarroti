"use client";
import React from "react";
import { Input } from "@/components/ui/input";
import {
  FieldLabel,
  Hint,
  KeyStatus,
  ProviderBrandIcon,
  SecretField,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  StatusChip,
  linkClass,
} from "./primitives";

/** API keys: kie.ai (images + video) and Azure Foundry. Keys live on the server. */
export function ProvidersPanel({
  kieKeyStatus,
  onKieKeySave,
  onKieKeyDelete,
  azureKeyStatus,
  onAzureKeySave,
  onAzureKeyDelete,
  azureBaseUrl,
  onBaseUrlChange,
}: {
  kieKeyStatus: KeyStatus;
  onKieKeySave: (token: string) => Promise<void>;
  onKieKeyDelete: () => Promise<void>;
  azureKeyStatus: KeyStatus;
  onAzureKeySave: (key: string) => Promise<void>;
  onAzureKeyDelete: () => Promise<void>;
  azureBaseUrl: string;
  onBaseUrlChange: (v: string) => void;
}) {
  return (
    <SettingsSection
      title="API keys"
      description="Keys are stored on this machine's server and never sent to the browser."
    >
      <SettingsGroup>
        <SettingsRow
          icon={<ProviderBrandIcon id="kie" size={15} />}
          label="kie.ai"
          description="Makes every image and video."
          htmlFor="kie-api-key"
          control={<KeyChip status={kieKeyStatus} />}
        >
          <SecretField
            id="kie-api-key"
            status={kieKeyStatus}
            placeholder="Paste your kie.ai API key"
            onSave={onKieKeySave}
            onRemove={onKieKeyDelete}
          />
          {kieKeyStatus === "unset" && (
            <Hint>
              No key yet? Get one at{" "}
              <a href="https://kie.ai/api-key" target="_blank" rel="noreferrer" className={linkClass}>
                kie.ai/api-key
              </a>
              , then paste it here.
            </Hint>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          icon={<ProviderBrandIcon id="azure" size={15} />}
          label="Azure Foundry"
          description="Key and base URL shared by every model you route to Azure."
          htmlFor="azure-api-key"
          control={<KeyChip status={azureKeyStatus} />}
        >
          <SecretField
            id="azure-api-key"
            status={azureKeyStatus}
            placeholder="Paste your Azure Foundry API key"
            onSave={onAzureKeySave}
            onRemove={onAzureKeyDelete}
          />
        </SettingsRow>
        <div className="flex flex-col gap-1.5 px-4 py-3.5">
          <FieldLabel htmlFor="azure-global-base-url">Base URL</FieldLabel>
          <Input
            id="azure-global-base-url"
            type="url"
            spellCheck={false}
            placeholder="https://<resource>.cognitiveservices.azure.com"
            value={azureBaseUrl}
            onChange={(e) => onBaseUrlChange(e.target.value)}
            className="font-mono text-[12.5px]"
          />
          <Hint>Combined with each model&apos;s deployment name under Image models.</Hint>
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}

function KeyChip({ status }: { status: KeyStatus }) {
  if (status === "unknown") return <StatusChip tone="running">Checking</StatusChip>;
  if (status === "set") return <StatusChip tone="done">Connected</StatusChip>;
  return <StatusChip tone="queued">No key</StatusChip>;
}
