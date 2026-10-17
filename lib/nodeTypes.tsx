// Shared node type definitions — imported by both Sidebar and NodePickerMenu
import React from "react";
import { MessageSquare, Image, Film, Sparkles, Bot, Clapperboard, StickyNote, PersonStanding, Box, Bone, Footprints, PackageCheck, Gamepad2, Palette, BrickWall, Map as MapIcon, CloudSun, Swords, Hammer, Gem, Grab, type LucideIcon } from "lucide-react";
import { STEP_IO, type ArtifactKind, type Port } from "./game/artifacts";

export type NodeCategory = "generators" | "resources";

// ── Game-asset pipelines: one node type per step ────────────────────────────

/** Menu section and handle pigment (globals.css) of each family of game nodes. */
export const GAME_GROUPS = {
  style: { label: "Game style", accent: "var(--handle-style)" },
  character: { label: "Game character", accent: "var(--handle-character)" },
  surface: { label: "Game surfaces", accent: "var(--handle-surface)" },
  maps: { label: "Game maps", accent: "var(--handle-map)" },
  prop: { label: "Game props", accent: "var(--handle-prop)" },
} as const satisfies Record<string, { label: string; accent: string }>;

export type GameGroup = keyof typeof GAME_GROUPS;

interface GameNodeSpec {
  /** The pipeline step it runs (lib/game/artifacts.ts STEP_IO). */
  step: ArtifactKind;
  group: GameGroup;
  label: string;
  description: string;
  /** The output in words: "The {noun} will appear here.", "{noun} output". */
  noun: string;
  icon: LucideIcon;
  /** Placement footprint for new nodes. */
  size: { w: number; h: number };
}

export const GAME_NODES = {
  gameStyleNode:      { step: "style",      group: "style",     label: "Style guide",      description: "Reference pictures every game asset is drawn to match", noun: "style guide", icon: Palette, size: { w: 300, h: 440 } },
  gameTurnaroundNode: { step: "turnaround", group: "character", label: "Turnaround sheet", description: "Front, side and back views from a concept", noun: "turnaround sheet", icon: PersonStanding, size: { w: 300, h: 420 } },
  gameMeshNode:       { step: "mesh",       group: "character", label: "Image to 3D mesh", description: "A textured mesh from the turnaround sheet", noun: "mesh", icon: Box, size: { w: 300, h: 440 } },
  gameSkeletonNode:   { step: "skeleton",   group: "character", label: "Auto-rig",         description: "A humanoid skeleton bound to the mesh", noun: "rigged mesh", icon: Bone, size: { w: 300, h: 420 } },
  gameAnimNode:       { step: "animclip",   group: "character", label: "Animation set",    description: "Idle, walk, run and jump retargeted onto the rig", noun: "animation set", icon: Footprints, size: { w: 300, h: 420 } },
  gameGltfNode:       { step: "gltf",       group: "character", label: "glTF export",      description: "A validated .glb that plays in Godot", noun: "glTF asset", icon: PackageCheck, size: { w: 300, h: 460 } },
  gameUnrealNode:     { step: "unreal",     group: "character", label: "Unreal export",    description: "An FBX on the UE5 mannequin skeleton", noun: "Unreal FBX", icon: Gamepad2, size: { w: 300, h: 460 } },
  gameSurfaceNode:    { step: "surface",    group: "surface",   label: "Seamless material", description: "A tiling PBR ground or wall material, checked in Godot", noun: "material", icon: BrickWall, size: { w: 300, h: 460 } },
  gameWorldMapNode:   { step: "worldmap",   group: "maps",      label: "World map",        description: "An illustrated map for the map screen, coastlines from a seed or sketch, no baked text", noun: "world map", icon: MapIcon, size: { w: 300, h: 460 } },
  gameSkyboxNode:     { step: "skybox",     group: "maps",      label: "Skybox",           description: "A seamless 360° sky panorama, checked in Godot", noun: "skybox", icon: CloudSun, size: { w: 300, h: 460 } },
  gamePropSheetNode:  { step: "propsheet",  group: "prop",      label: "Prop sheet",       description: "Front, side and back of an item, drawn to a ruler and a grip box", noun: "prop sheet", icon: Swords, size: { w: 300, h: 440 } },
  gamePropNode:       { step: "prop",       group: "prop",      label: "Prop mesh",        description: "A game-ready item with a collision hull, checked in Godot", noun: "prop", icon: Hammer, size: { w: 300, h: 460 } },
  gameIconNode:       { step: "icon",       group: "prop",      label: "Inventory icon",   description: "A 512 and 64 px icon rendered from the prop's mesh", noun: "icon", icon: Gem, size: { w: 300, h: 440 } },
  gameEquipNode:      { step: "equip",      group: "prop",      label: "Equip",            description: "A handheld prop in a character's right fist, walked in Godot", noun: "equipped character", icon: Grab, size: { w: 300, h: 460 } },
} as const satisfies Record<string, GameNodeSpec>;

export type GameNodeType = keyof typeof GAME_NODES;

export const GAME_NODE_TYPES = Object.keys(GAME_NODES) as GameNodeType[];

/** The step a node type runs, or undefined for non-game nodes. */
export function gameStepOf(type: string | null | undefined): ArtifactKind | undefined {
  return type && type in GAME_NODES ? GAME_NODES[type as GameNodeType].step : undefined;
}

/** The node type that runs `step`. */
export function gameNodeTypeFor(step: ArtifactKind): GameNodeType {
  return GAME_NODE_TYPES.find((t) => GAME_NODES[t].step === step)!;
}

/** Spec of the node that runs `step`. */
export function gameSpecFor(step: ArtifactKind): GameNodeSpec {
  return GAME_NODES[gameNodeTypeFor(step)];
}

/** Source handle id of a game node: `${outputKind}Out`; steps nothing consumes (exports) have none. */
export function gameOutHandle(step: ArtifactKind): string | undefined {
  return gameNextTypes(step).length ? `${STEP_IO[step].output}Out` : undefined;
}

/** Node types allowed to feed `port`: text nodes, image nodes, or the node that makes its artifact. */
export function gamePortSources(port: Port): string[] {
  if (port.kind === "prompt") return ["promptNode", "assistantNode"];
  if (port.kind === "image") return ["imageInputNode", "generateNode"];
  return [gameNodeTypeFor(port.kind)];
}

/** The game node types with a port that takes `step`'s output (the walk feeds both exports). */
export function gameNextTypes(step: ArtifactKind): GameNodeType[] {
  const out = STEP_IO[step].output;
  return GAME_NODE_TYPES.filter((t) => STEP_IO[GAME_NODES[t].step].inputs.some((p) => p.kind === out));
}

/**
 * The port of `targetStep` a wire from `sourceType` (out of `sourceHandle`)
 * lands on, or undefined if none takes it. Game sources must leave by their
 * artifact handle.
 */
export function gamePortFor(targetStep: ArtifactKind, sourceType: string | null | undefined, sourceHandle: string | null | undefined): Port | undefined {
  const srcStep = gameStepOf(sourceType);
  if (srcStep && sourceHandle !== gameOutHandle(srcStep)) return undefined;
  return STEP_IO[targetStep].inputs.find((p) => gamePortSources(p).includes(sourceType ?? ""));
}

/** One entry per game node type, for the per-type tables below. */
function gameEntries<T>(make: (spec: GameNodeSpec) => T): Record<string, T> {
  return Object.fromEntries(GAME_NODE_TYPES.map((t) => [t, make(GAME_NODES[t])]));
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
  ...gameEntries((s) => ({ accent: GAME_GROUPS[s.group].accent, bigIcon: <s.icon size={18} strokeWidth={1.7} /> })),
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

    /* ── Game assets ────────────────────────────────────────────────────────── */
    ...GAME_NODE_TYPES.map((type) => {
      const s: GameNodeSpec = GAME_NODES[type];
      return { type, category: "generators" as const, canReceiveConnection: true, icon: <s.icon size={14} strokeWidth={1.5} />, label: s.label, description: s.description };
    }),
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
  ...gameEntries((s) => s.label),
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
  ...gameEntries((s) => s.size),
};

export const FALLBACK_SIZE = { w: 280, h: 280 };

/** Size to use for a newly created node: last manually-resized size for this type, else the static default. */
export function getDefaultNodeSize(
  type: string,
  lastNodeSize: Record<string, { w: number; h: number }>,
): { w: number; h: number } {
  return lastNodeSize[type] ?? NODE_SIZE[type] ?? FALLBACK_SIZE;
}
