/**
 * Text models reached through an API key (kie.ai, Azure). The picker lists them
 * under one "kie.ai" section, below the user's own subscriptions (ACP agents,
 * see lib/agentModels.ts and lib/useAgents.ts), with the maker as sub-label.
 */
export interface Model {
  id: string;
  label: string;
  desc: string;
}

export type KeyProvider = "kie" | "azure";

export interface ModelGroup {
  /** Maker sub-label shown inside the section ("Anthropic", "Google"…). */
  label: string;
  /** Which key the group's models need. */
  provider: KeyProvider;
  models: Model[];
}

/** Section heading the picker shows above the keyed groups. */
export const KEYED_SECTION_LABEL = "kie.ai";

export const MODEL_GROUPS: ModelGroup[] = [
  {
    label: "Anthropic",
    provider: "kie",
    models: [
      { id: "claude-opus-4-7",   label: "Opus 4.7",       desc: "Best"     },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6",     desc: "Powerful" },
      { id: "claude-haiku-4-5",  label: "Haiku 4.5",      desc: "Fast"     },
    ],
  },
  {
    label: "Google",
    provider: "kie",
    models: [
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", desc: "Pro"  },
      { id: "gemini-3-flash", label: "Gemini Flash",   desc: "Fast" },
    ],
  },
  {
    label: "OpenAI",
    provider: "kie",
    models: [
      { id: "gpt-5-2", label: "GPT 5.2", desc: "Latest" },
    ],
  },
  {
    label: "Azure",
    provider: "azure",
    models: [
      { id: "azure-auto", label: "Azure Auto", desc: "Router" },
    ],
  },
];

export const MODELS: Model[] = MODEL_GROUPS.flatMap(g => g.models);
export type ModelId = string;

/** Which key a keyed model needs; `undefined` for ids that are not kie/Azure models. */
export function keyProviderFor(id: ModelId): KeyProvider | undefined {
  return MODEL_GROUPS.find((g) => g.models.some((m) => m.id === id))?.provider;
}
