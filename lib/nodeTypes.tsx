// Shared node type definitions — imported by both Sidebar and NodePickerMenu
import React from "react";
import { MessageSquare, Image, Film, Sparkles, Bot, Clapperboard, StickyNote, PersonStanding, Box, Bone, Footprints, PackageCheck } from "lucide-react";
import { STEP_IO, type ArtifactKind } from "./game/artifacts";

export type NodeCategory = "generators" | "resources";

// ── Game-character pipeline: one node type per step ─────────────────────────

/** Node type → the pipeline step it runs (lib/game/artifacts.ts STEP_IO). */
export const GAME_NODE_STEP = {
  gameTurnaroundNode: "turnaround",
  gameMeshNode:       "mesh",
  gameSkeletonNode:   "skeleton",
  gameAnimNode:       "animclip",
  gameGltfNode:       "gltf",
} as const satisfies Record<string, ArtifactKind>;

export type GameNodeType = keyof typeof GAME_NODE_STEP;

export const GAME_NODE_TYPES = Object.keys(GAME_NODE_STEP) as GameNodeType[];

/** The step a node type runs, or undefined for non-game nodes. */
export function gameStepOf(type: string | null | undefined): ArtifactKind | undefined {
  return type && type in GAME_NODE_STEP ? GAME_NODE_STEP[type as GameNodeType] : undefined;
}

/** The node type that runs `step`. */
export function gameNodeTypeFor(step: ArtifactKind): GameNodeType {
  return GAME_NODE_TYPES.find((t) => GAME_NODE_STEP[t] === step)!;
}

/** Source handle id of a game node: `${outputKind}Out`; gltf has none. */
export function gameOutHandle(step: ArtifactKind): string | undefined {
  return step === "gltf" ? undefined : `${STEP_IO[step].output}Out`;
}

/** Node types allowed to feed a game node's single input. */
export function gameSourceTypes(step: ArtifactKind): string[] {
  const need = STEP_IO[step].input;
  return need === "prompt" ? ["promptNode", "assistantNode"] : [gameNodeTypeFor(need)];
}

/** The game node type that consumes `step`'s output, if any. */
export function gameNextType(step: ArtifactKind): GameNodeType | undefined {
  const next = (Object.keys(STEP_IO) as ArtifactKind[]).find((k) => STEP_IO[k].input === STEP_IO[step].output);
  return next ? gameNodeTypeFor(next) : undefined;
}

/** Per-type accent (a categorical handle pigment from globals.css) + picker icon. */
export const NODE_META: Record<string, { accent: string; bigIcon: React.ReactNode }> = {
  promptNode:         { accent: "var(--handle-prompt)",    bigIcon: <MessageSquare size={18} strokeWidth={1.7} /> },
  imageInputNode:     { accent: "var(--handle-image)",     bigIcon: <Image         size={18} strokeWidth={1.7} /> },
  videoInputNode:     { accent: "var(--handle-video)",     bigIcon: <Film          size={18} strokeWidth={1.7} /> },
  generateNode:       { accent: "var(--handle-image)",     bigIcon: <Sparkles      size={18} strokeWidth={1.7} /> },
  assistantNode:      { accent: "var(--handle-assistant)", bigIcon: <Bot           size={18} strokeWidth={1.7} /> },
  videoGeneratorNode: { accent: "var(--handle-video)",     bigIcon: <Clapperboard  size={18} strokeWidth={1.7} /> },
  commentNode:        { accent: "var(--handle-audio)",     bigIcon: <StickyNote    size={18} strokeWidth={1.7} /> },
  gameTurnaroundNode: { accent: "var(--handle-character)", bigIcon: <PersonStanding size={18} strokeWidth={1.7} /> },
  gameMeshNode:       { accent: "var(--handle-character)", bigIcon: <Box            size={18} strokeWidth={1.7} /> },
  gameSkeletonNode:   { accent: "var(--handle-character)", bigIcon: <Bone           size={18} strokeWidth={1.7} /> },
  gameAnimNode:       { accent: "var(--handle-character)", bigIcon: <Footprints     size={18} strokeWidth={1.7} /> },
  gameGltfNode:       { accent: "var(--handle-character)", bigIcon: <PackageCheck   size={18} strokeWidth={1.7} /> },
};

export const NODES: Array<{
  type: string;
  category: NodeCategory;
  canReceiveConnection: boolean;
  icon: React.ReactNode;
  label: string;
  description: string;
}> = [
    /* ── Generators ─────────────────────────────────────────────────────────── */
    {
      type: "assistantNode",
      category: "generators",
      canReceiveConnection: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
          <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
        </svg>
      ),
      label: "Assistant",
      description: "Rewrites and refines your text",
    },
    {
      type: "videoGeneratorNode",
      category: "generators",
      canReceiveConnection: true,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect width="18" height="14" x="3" y="5" rx="2" />
          <path d="m16 10-4-2.5v5L16 10z" fill="currentColor" stroke="none" />
        </svg>
      ),
      label: "Video",
      description: "Make video from words and frames",
    },
    {
      type: "generateNode",
      category: "generators",
      canReceiveConnection: true,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="m3 9 4-4 4 4 4-4 4 4" />
          <path d="M3 15h18" />
        </svg>
      ),
      label: "Image",
      description: "Make images from words and references",
    },

    /* ── Resources ──────────────────────────────────────────────────────────── */
    {
      type: "promptNode",
      category: "resources",
      canReceiveConnection: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      ),
      label: "Text",
      description: "A prompt you can wire into generators",
    },
    {
      type: "imageInputNode",
      category: "resources",
      canReceiveConnection: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        </svg>
      ),
      label: "Reference image",
      description: "Upload or paste a link",
    },
    {
      type: "videoInputNode",
      category: "resources",
      canReceiveConnection: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect width="18" height="14" x="3" y="5" rx="2" />
          <path d="m16 10-4-2.5v5L16 10z" fill="currentColor" stroke="none" />
          <path d="M12 2v3M12 19v3M4 12H2M22 12h-2" strokeWidth="1.2" />
        </svg>
      ),
      label: "Reference video",
      description: "Upload a video · max 100 MB",
    },
    {
      type: "commentNode",
      category: "resources",
      canReceiveConnection: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      ),
      label: "Comment",
      description: "A sticky note you can place anywhere",
    },

    /* ── Game character ─────────────────────────────────────────────────────── */
    {
      type: "gameTurnaroundNode",
      category: "generators",
      canReceiveConnection: true,
      icon: <PersonStanding size={14} strokeWidth={1.5} />,
      label: "Turnaround sheet",
      description: "Front, side and back views from a concept",
    },
    {
      type: "gameMeshNode",
      category: "generators",
      canReceiveConnection: true,
      icon: <Box size={14} strokeWidth={1.5} />,
      label: "Image to 3D mesh",
      description: "A textured mesh from the turnaround sheet",
    },
    {
      type: "gameSkeletonNode",
      category: "generators",
      canReceiveConnection: true,
      icon: <Bone size={14} strokeWidth={1.5} />,
      label: "Auto-rig",
      description: "A humanoid skeleton bound to the mesh",
    },
    {
      type: "gameAnimNode",
      category: "generators",
      canReceiveConnection: true,
      icon: <Footprints size={14} strokeWidth={1.5} />,
      label: "Walk cycle",
      description: "A looping in-place walk on the rig",
    },
    {
      type: "gameGltfNode",
      category: "generators",
      canReceiveConnection: true,
      icon: <PackageCheck size={14} strokeWidth={1.5} />,
      label: "glTF export",
      description: "A validated .glb that plays in Godot",
    },
  ];

/** Sentence-case display name per node type; new nodes are labelled "Image generator #2". */
export const NODE_LABELS: Record<string, string> = {
  promptNode: "Text",
  imageInputNode: "Image",
  videoInputNode: "Video",
  generateNode: "Image generator",
  videoGeneratorNode: "Video generator",
  assistantNode: "Assistant",
  commentNode: "Comment",
  gameTurnaroundNode: "Turnaround sheet",
  gameMeshNode: "Image to 3D mesh",
  gameSkeletonNode: "Auto-rig",
  gameAnimNode: "Walk cycle",
  gameGltfNode: "glTF export",
};

/** Label for a new node of `type`: its display name plus the next per-type count. */
export function nextNodeLabel(type: string, nodes: Array<{ type?: string | null }>): string {
  const count = nodes.filter((n) => n.type === type).length + 1;
  return `${NODE_LABELS[type] ?? type} #${count}`;
}

/** Icon tile tinted with a pigment (a node type's `NODE_META.accent`) — node menus and the empty canvas. */
export function TypeBadge({
  accent = "var(--ink-3)",
  icon,
  size = 32,
}: { accent?: string; icon: React.ReactNode; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[var(--radius)]"
      style={{
        width: size,
        height: size,
        color: accent,
        background: `color-mix(in srgb, ${accent} 10%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} 22%, transparent)`,
      }}
    >
      {icon}
    </span>
  );
}

const GEN_NODE_SETTINGS: Record<string, string[]> = {
  generateNode: ["model", "aspectRatio", "quality", "azureQuality", "azureResolution"],
  videoGeneratorNode: ["videoModel", "klingMode", "grokResolution", "duration", "aspectRatio", "sound"],
};

/** Returns settings from the last existing node of `type` to seed a newly created one. */
export function getLastNodeSettings(
  type: string,
  nodes: Array<{ type?: string | null; data: Record<string, unknown> }>,
): Record<string, unknown> {
  const keys = GEN_NODE_SETTINGS[type];
  if (!keys) return {};
  const matching = nodes.filter((n) => n.type === type);
  if (!matching.length) return {};
  const last = matching[matching.length - 1];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (last.data[k] !== undefined) out[k] = last.data[k];
  }
  return out;
}

// Rough pixel footprint per node type — used for placement + collision detection
export const NODE_SIZE: Record<string, { w: number; h: number }> = {
  assistantNode: { w: 280, h: 200 },
  videoGeneratorNode: { w: 320, h: 220 }, // Safe default for 16:9 + controls
  generateNode: { w: 280, h: 280 },       // 1:1 default
  promptNode: { w: 520, h: 250 },
  imageInputNode: { w: 200, h: 160 },
  videoInputNode: { w: 220, h: 180 },
  commentNode: { w: 260, h: 160 },
  gameTurnaroundNode: { w: 300, h: 420 },
  gameMeshNode: { w: 300, h: 440 },
  gameSkeletonNode: { w: 300, h: 420 },
  gameAnimNode: { w: 300, h: 420 },
  gameGltfNode: { w: 300, h: 460 },
};

export const FALLBACK_SIZE = { w: 280, h: 280 };

/** Size to use for a newly created node: last manually-resized size for this type, else the static default. */
export function getDefaultNodeSize(
  type: string,
  lastNodeSize: Record<string, { w: number; h: number }>,
): { w: number; h: number } {
  return lastNodeSize[type] ?? NODE_SIZE[type] ?? FALLBACK_SIZE;
}
