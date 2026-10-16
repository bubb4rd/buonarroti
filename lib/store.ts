import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { edgeStyle } from "./edgeStyles";
import { VIDEO_MODELS } from "./modelConfig";
import { requestWorkflowSync } from "./workflowSyncBus";
import { NODE_LABELS } from "./nodeTypes";
import type { Artifact } from "./game/artifacts";
import {
  Node,
  Edge,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  NodeChange,
  EdgeChange,
  Connection,
} from "@xyflow/react";

export type NodeStatus = "idle" | "pending" | "running" | "done" | "error";
export type GenerateMode = "t2i" | "t2v" | "i2i" | "i2v";

export interface NodeData extends Record<string, unknown> {
  label: string;
  status?: NodeStatus;
  // shared
  prompt?: string;
  textMode?: "text" | "json" | "yaml"; // initial JSON/YAML toggle state for promptNode (seeded on creation)
  // comment / sticky-note node
  comment?: string;
  // generate node
  mode?: GenerateMode;
  model?: string;
  aspectRatio?: string;
  duration?: number;
  // image (input or output)
  imageUrl?: string;
  inputImage?: string;      // base64 data URL — only kept while session is active
  r2Url?: string;           // R2 CDN URL — durable, used instead of inputImage after upload
  imageNaturalRatio?: string;
  // generation settings
  quality?: string;
  azureQuality?: string;
  azureResolution?: string;
  azureCustomWidth?: number;
  azureCustomHeight?: number;
  // video output
  videoUrl?: string;
  // video model
  videoModel?: string;
  // kling 3.0 settings
  sound?: boolean;
  klingMode?: string;
  count?: number;
  veoMode?: "frames" | "references";
  // grok imagine settings

  grokMode?: string;
  grokResolution?: string;
  // seed (for models that support it)
  seed?: number;
  // error
  errorMsg?: string;
  /** Contract error code of the last failed job ("credits", "interrupted", …). */
  errorCode?: string;
  // validation
  hasError?: boolean;
  locked?: boolean;
  // in-flight job
  taskId?: string;
  /** Idempotency key sent with the POST; kept on interruption so a retry can't double-bill. */
  clientRequestId?: string;
  /** Index into `generations` reserved for the in-flight job at submit time. */
  jobSlot?: number;
  /** Epoch ms the in-flight job was submitted. */
  jobStartedAt?: number;
  // pipeline runner flags (never meaningful across reloads)
  pendingGenerate?: boolean;
  pipelineQueued?: boolean;
  // game-character pipeline nodes (gameTurnaroundNode … gameGltfNode)
  /** The step's typed output; cleared when the node re-runs so downstream sees it as missing. */
  artifact?: Artifact;
  /** glTF export file name (defaults to the node label). */
  name?: string;
  /** Mesh step: character height in meters (default 1.8). */
  heightM?: number;
}

export const INTERRUPTED_MESSAGE = "This generation was interrupted. Retry?";

/**
 * Node ids whose generation POST is currently in flight in this tab. A node in
 * this set is legitimately `running` without a `taskId` yet.
 */
export const inflightSubmits = new Set<string>();

type GenSlot = string | null | { error: string };

/**
 * Make persisted node state honest after a reload / space load:
 * - `pending`, or `running` without a taskId (and no live POST) → interrupted error
 *   (prompt, inputs and clientRequestId are kept so Retry can reuse the request id).
 * - `running` with a taskId is left alone; the node resumes watching it.
 * - Pipeline flags are cleared; the pipeline itself is never persisted.
 * - Pre-rebrand labels ("Image Generator #2", "ASSISTANT") become sentence case.
 * Returns the same array when nothing changed.
 */
export function sanitizeNodes(nodes: Node<NodeData>[]): Node<NodeData>[] {
  let changed = false;
  const out = nodes.map((n) => {
    const d = n.data;
    if (!d) return n;
    const stale = !inflightSubmits.has(n.id) &&
      (d.status === "pending" || (d.status === "running" && !d.taskId));
    const pending = d.status === "pending" && !!d.taskId;
    const label = migrateLabel(d.label);
    if (!stale && !pending && !d.pendingGenerate && !d.pipelineQueued && !label) return n;
    changed = true;
    const data: NodeData = { ...d, pendingGenerate: false, pipelineQueued: false, ...(label ? { label } : {}) };
    if (pending) data.status = "running";
    if (stale) {
      const gens = Array.isArray(d.generations) ? [...(d.generations as GenSlot[])] : [];
      let slot = typeof d.jobSlot === "number" && gens[d.jobSlot] === null ? d.jobSlot : gens.lastIndexOf(null);
      if (slot !== -1) gens[slot] = { error: INTERRUPTED_MESSAGE };
      else slot = (d.currentGenIdx as number | undefined) ?? 0;
      Object.assign(data, {
        status: "error",
        errorMsg: INTERRUPTED_MESSAGE,
        errorCode: "interrupted",
        taskId: undefined,
        jobSlot: undefined,
        jobStartedAt: undefined,
        ...(Array.isArray(d.generations) ? { generations: gens, currentGenIdx: slot, imageUrl: undefined } : {}),
      } satisfies Partial<NodeData>);
    }
    return { ...n, data };
  });
  return changed ? out : nodes;
}

function sanitizeSpace(sp: Space): Space {
  const nodes = sanitizeNodes(sp.nodes);
  return nodes === sp.nodes ? sp : { ...sp, nodes };
}

// ── Persisted key migration (heliosgen-guest → buonarroti-workspace) ─────────

const PERSIST_KEY = "buonarroti-workspace";
const LEGACY_PERSIST_KEY = "heliosgen-guest";

const migratingStorage = {
  getItem: (name: string): string | null => {
    const current = localStorage.getItem(name);
    if (current !== null || name !== PERSIST_KEY) return current;
    const legacy = localStorage.getItem(LEGACY_PERSIST_KEY);
    if (legacy === null) return null;
    localStorage.setItem(PERSIST_KEY, legacy);
    localStorage.removeItem(LEGACY_PERSIST_KEY);
    return legacy;
  },
  setItem: (name: string, value: string) => localStorage.setItem(name, value),
  removeItem: (name: string) => localStorage.removeItem(name),
};

/** Pick only the listed keys from an object; returns null if none are present. */
function filterKeys<T extends object>(obj: T, keys: (keyof T)[]): Partial<T> | null {
  const result: Partial<T> = {};
  let found = false;
  for (const k of keys) {
    if (k in obj) { result[k] = obj[k]; found = true; }
  }
  return found ? result : null;
}

/** Pre-rebrand labels ("Image Generator #2", "ASSISTANT") → sentence case; undefined if already fine. */
function migrateLabel(label: unknown): string | undefined {
  if (typeof label !== "string") return undefined;
  if (label === "ASSISTANT") return NODE_LABELS.assistantNode;
  const m = /^(Image|Video) Generator (#\d+)$/.exec(label);
  return m ? `${m[1]} generator ${m[2]}` : undefined;
}

// ── Space ─────────────────────────────────────────────────────────────────────

export interface Space {
  id: string;
  name: string;
  nodes: Node<NodeData>[];
  edges: Edge[];
  nodeCounters: Record<string, number>;
  createdAt: number;
  updatedAt?: number;
  viewport?: { x: number; y: number; zoom: number };
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function makeSpace(name: string, partial?: Partial<Space>): Space {
  return {
    id:           uid(),
    name,
    nodes:        [],
    edges:        [],
    nodeCounters: {},
    createdAt:    Date.now(),
    ...partial,
  };
}

// Sync the current nodes/edges/nodeCounters back into the spaces array.
// Call this inside every action that mutates those fields.
function syncSpace(
  spaces: Space[],
  activeId: string,
  nodes: Node<NodeData>[],
  edges: Edge[],
  nodeCounters: Record<string, number>,
): Space[] {
  return spaces.map((sp) =>
    sp.id === activeId ? { ...sp, nodes, edges, nodeCounters, updatedAt: Date.now() } : sp
  );
}

// ── Undo / Redo snapshot ───────────────────────────────────────────────────────

interface Snapshot { nodes: Node<NodeData>[]; edges: Edge[] }

const MAX_UNDO = 50;

// ── Store interface ────────────────────────────────────────────────────────────

export interface Toast {
  id:       string;
  message:  string;
  type:     "error" | "success" | "info";
  href?:    string;
  title?:   string;
  preview?: string;
}

/** Sections of the Settings window (components/SettingsModal.tsx). */
export type SettingsSectionId =
  | "appearance" | "api-keys" | "subscriptions" | "codex" | "image-models" | "video-models" | "text-models" | "debug";

interface WorkflowStore {
  // ── Toasts
  toasts:      Toast[];
  addToast:    (message: string, type?: Toast["type"], href?: string, title?: string, preview?: string) => void;
  removeToast: (id: string) => void;

  // ── Kie key status (null = unknown, true = set, false = not set)
  kieKeySet:    boolean | null;
  setKieKeySet: (v: boolean | null) => void;

  // ── Azure key status (null = unknown, true = set, false = not set)
  azureKeySet:    boolean | null;
  setAzureKeySet: (v: boolean | null) => void;

  // ── Spaces
  spaces:        Space[];
  activeSpaceId: string;

  // ── Live state (mirrors the active space; kept in sync on every mutation)
  nodes:        Node<NodeData>[];
  edges:        Edge[];
  isRunning:    boolean;
  debugMode:    boolean;
  nodeCounters: Record<string, number>;

  // ── Undo / Redo
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  pushUndoSnapshot: () => void;
  undo: () => void;
  redo: () => void;

  // ── Space actions
  createSpace:    (name: string, template?: { nodes: Node<NodeData>[]; edges: Edge[]; nodeCounters: Record<string, number> }) => void;
  switchSpace:    (id: string)   => void;
  renameSpace:    (id: string, name: string) => void;
  deleteSpace:    (id: string)   => void;
  duplicateSpace: (id: string)   => void;

  // ── Workflow actions
  onNodesChange:      (changes: NodeChange[]) => void;
  onEdgesChange:      (changes: EdgeChange[]) => void;
  onConnect:          (connection: Connection) => void;
  addNode:            (node: Node<NodeData>) => void;
  insertEdge:         (edge: Edge) => void;
  removeEdgesForHandle: (nodeId: string, handleId: string) => void;
  killEdgesForHandles:  (nodeId: string, handleIds: string[]) => void;
  remapTargetHandle:    (nodeId: string, fromHandle: string, toHandle: string) => void;
  flashEdgeError:       (edgeId: string) => void;
  /** Merge into a node's data. `spaceId` targets a (possibly inactive) space; defaults to the active one. */
  updateNodeData:     (id: string, data: Partial<NodeData>, spaceId?: string) => void;
  updateNodeSize:     (id: string, width: number, height: number) => void;
  setIsRunning:       (v: boolean) => void;
  toggleDebug:        () => void;
  /** The type being dragged during an active connection ("prompt" | "image" | "video" | null) */
  connectingHandleType: string | null;
  setConnectingHandleType: (type: string | null) => void;
  settingsOpen:              boolean;
  /** Section the Settings window shows; pass one to `setSettingsOpen` to jump there. */
  settingsSection:           SettingsSectionId;
  setSettingsOpen:           (v: boolean, section?: SettingsSectionId) => void;
  setSettingsSection:        (section: SettingsSectionId) => void;
  showDashboard:             boolean;
  setShowDashboard:          (v: boolean) => void;
  globalMuted:               boolean;
  setGlobalMuted:            (v: boolean) => void;
  sidebarCollapsed:          boolean;
  setSidebarCollapsed:       (v: boolean) => void;
  saveViewport: (viewport: { x: number; y: number; zoom: number }) => void;
  loadSpacesFromDB: (spaces: Space[]) => void;
  clearLocalData: () => void;

  // ── Per-type node defaults (last-used params)
  nodeDefaults: {
    generateNode:        Partial<NodeData>;
    videoGeneratorNode:  Partial<NodeData>;
  };

  /** Last manually-resized {w,h} per node type — new nodes of that type inherit it. */
  lastNodeSize: Record<string, { w: number; h: number }>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useWorkflowStore = create<WorkflowStore>()(
  persist(
    (set, get) => {
      const defaultSpace = makeSpace("Space 1");

      return {
        spaces:        [defaultSpace],
        activeSpaceId: defaultSpace.id,

        nodes:        [],
        edges:        [],
        isRunning:    false,
        debugMode:    false,
        nodeCounters: {},

        nodeDefaults: { generateNode: {}, videoGeneratorNode: {} },
        lastNodeSize: {},

        undoStack: [],
        redoStack: [],

        pushUndoSnapshot: () =>
          set((s) => ({
            undoStack: [...s.undoStack.slice(-(MAX_UNDO - 1)), { nodes: s.nodes, edges: s.edges }],
            redoStack: [],
          })),

        undo: () =>
          set((s) => {
            if (s.undoStack.length === 0) return {};
            const snap = s.undoStack[s.undoStack.length - 1];
            return {
              nodes:     snap.nodes,
              edges:     snap.edges,
              undoStack: s.undoStack.slice(0, -1),
              redoStack: [...s.redoStack, { nodes: s.nodes, edges: s.edges }],
              spaces:    syncSpace(s.spaces, s.activeSpaceId, snap.nodes, snap.edges, s.nodeCounters),
            };
          }),

        redo: () =>
          set((s) => {
            if (s.redoStack.length === 0) return {};
            const snap = s.redoStack[s.redoStack.length - 1];
            return {
              nodes:     snap.nodes,
              edges:     snap.edges,
              undoStack: [...s.undoStack, { nodes: s.nodes, edges: s.edges }],
              redoStack: s.redoStack.slice(0, -1),
              spaces:    syncSpace(s.spaces, s.activeSpaceId, snap.nodes, snap.edges, s.nodeCounters),
            };
          }),

        // ── Space actions ──────────────────────────────────────────────────

        createSpace: (name, template) =>
          set((s) => {
            const sp = makeSpace(name, template ? {
              nodes:        template.nodes,
              edges:        template.edges,
              nodeCounters: template.nodeCounters,
            } : undefined);
            const spaces = [
              ...syncSpace(s.spaces, s.activeSpaceId, s.nodes, s.edges, s.nodeCounters),
              sp,
            ];
            return {
              spaces,
              activeSpaceId: sp.id,
              nodes:         template?.nodes        ?? [],
              edges:         template?.edges        ?? [],
              nodeCounters:  template?.nodeCounters ?? {},
              undoStack:     [],
              redoStack:     [],
            };
          }),

        switchSpace: (id) =>
          set((s) => {
            if (id === s.activeSpaceId) return {};
            const found = s.spaces.find((sp) => sp.id === id);
            if (!found) return {};
            const target = sanitizeSpace(found);
            const spaces = syncSpace(s.spaces, s.activeSpaceId, s.nodes, s.edges, s.nodeCounters)
              .map((sp) => (sp.id === id ? target : sp));
            return {
              spaces,
              activeSpaceId: id,
              nodes:         target.nodes,
              edges:         target.edges,
              nodeCounters:  target.nodeCounters,
              undoStack:     [],
              redoStack:     [],
            };
          }),

        renameSpace: (id, name) =>
          set((s) => ({
            spaces: s.spaces.map((sp) => (sp.id === id ? { ...sp, name } : sp)),
          })),

        deleteSpace: (id) =>
          set((s) => {
            if (s.spaces.length <= 1) return {}; // must have at least one
            const remaining = s.spaces.filter((sp) => sp.id !== id);
            if (s.activeSpaceId !== id) return { spaces: remaining };
            const next = remaining[0];
            return {
              spaces:        remaining,
              activeSpaceId: next.id,
              nodes:         next.nodes,
              edges:         next.edges,
              nodeCounters:  next.nodeCounters,
            };
          }),

        duplicateSpace: (id) =>
          set((s) => {
            const original = s.spaces.find((sp) => sp.id === id);
            if (!original) return {};
            const copy = makeSpace(`${original.name} (copy)`, {
              nodes:        original.nodes,
              edges:        original.edges,
              nodeCounters: original.nodeCounters,
            });
            const spaces = syncSpace(s.spaces, s.activeSpaceId, s.nodes, s.edges, s.nodeCounters);
            return { spaces: [...spaces, copy] };
          }),

        // ── Workflow actions (each syncs back to spaces) ────────────────────

        onNodesChange: (changes) => {
          set((s) => {
            const nodes = applyNodeChanges(changes, s.nodes) as Node<NodeData>[];
            const removedIds = new Set(
              changes
                .filter((c): c is Extract<NodeChange, { type: "remove" }> => c.type === "remove")
                .map((c) => c.id)
            );
            const edges = removedIds.size > 0
              ? s.edges.filter((e) => !removedIds.has(e.source) && !removedIds.has(e.target))
              : s.edges;

            // A "dimensions" change with resizing === false is the final size of a
            // manual corner-drag resize (as opposed to auto-measurement, which omits
            // `resizing`). Remember it per node type so new nodes inherit the last size.
            let lastNodeSize = s.lastNodeSize;
            for (const c of changes) {
              if (c.type !== "dimensions" || c.resizing !== false || !c.dimensions) continue;
              const nodeType = s.nodes.find((n) => n.id === c.id)?.type;
              if (!nodeType) continue;
              lastNodeSize = {
                ...lastNodeSize,
                [nodeType]: { w: c.dimensions.width, h: c.dimensions.height },
              };
            }

            return {
              nodes,
              edges,
              lastNodeSize,
              spaces: syncSpace(s.spaces, s.activeSpaceId, nodes, edges, s.nodeCounters),
            };
          });
          // Persist discrete edits (node removed, or a manual resize finished)
          // right away; drag/auto-measure churn still rides the debounce.
          const discrete = changes.some(
            (c) => c.type === "remove" || (c.type === "dimensions" && c.resizing === false),
          );
          if (discrete) requestWorkflowSync();
        },

        onEdgesChange: (changes) => {
          set((s) => {
            const edges = applyEdgeChanges(changes, s.edges);
            return {
              edges,
              spaces: syncSpace(s.spaces, s.activeSpaceId, s.nodes, edges, s.nodeCounters),
            };
          });
          if (changes.some((c) => c.type === "remove")) requestWorkflowSync();
        },

        onConnect: (connection) => {
          set((s) => {
            const undoStack = [...s.undoStack.slice(-(MAX_UNDO - 1)), { nodes: s.nodes, edges: s.edges }];
            let colorKey: string | undefined;
            if (connection.targetHandle === "startFrame") {
              const targetNode = s.nodes.find((n) => n.id === connection.target);
              const videoModelId = (targetNode?.data?.videoModel as string | undefined) ?? "";
              const videoModelCfg = VIDEO_MODELS.find((m) => m.id === videoModelId);
              if (videoModelCfg?.apiInput.useMotionControl) colorKey = "character";
            }
            const edges = addEdge(
              {
                ...connection,
                animated: false,
                style: edgeStyle(connection.targetHandle),
                ...(colorKey ? { data: { colorKey } } : {}),
              },
              s.edges
            );
            return {
              edges,
              undoStack,
              redoStack: [],
              spaces: syncSpace(s.spaces, s.activeSpaceId, s.nodes, edges, s.nodeCounters),
            };
          });
          requestWorkflowSync();
        },

        addNode: (node) => {
          set((s) => {
            const undoStack    = [...s.undoStack.slice(-(MAX_UNDO - 1)), { nodes: s.nodes, edges: s.edges }];
            const type         = node.type ?? "unknown";
            const count        = (s.nodeCounters[type] ?? 0) + 1;
            const label        = `${NODE_LABELS[type] ?? "Node"} #${count}`;
            const savedDefaults =
              type === "generateNode"       ? s.nodeDefaults.generateNode :
              type === "videoGeneratorNode" ? s.nodeDefaults.videoGeneratorNode : {};
            const nodes        = [
              ...s.nodes.map((n) => n.selected ? { ...n, selected: false } : n),
              { ...node, selected: true, data: { ...savedDefaults, ...node.data, label } },
            ];
            const nodeCounters = { ...s.nodeCounters, [type]: count };
            return {
              nodes,
              nodeCounters,
              undoStack,
              redoStack: [],
              spaces: syncSpace(s.spaces, s.activeSpaceId, nodes, s.edges, nodeCounters),
            };
          });
          requestWorkflowSync();
        },

        insertEdge: (edge) => {
          set((s) => {
            const undoStack = [...s.undoStack.slice(-(MAX_UNDO - 1)), { nodes: s.nodes, edges: s.edges }];
            const edges = [...s.edges, edge];
            return {
              edges,
              undoStack,
              redoStack: [],
              spaces: syncSpace(s.spaces, s.activeSpaceId, s.nodes, edges, s.nodeCounters),
            };
          });
          requestWorkflowSync();
        },

        removeEdgesForHandle: (nodeId, handleId) =>
          set((s) => {
            const edges = s.edges.filter(
              (e) => !(e.target === nodeId && e.targetHandle === handleId)
            );
            return {
              edges,
              spaces: syncSpace(s.spaces, s.activeSpaceId, s.nodes, edges, s.nodeCounters),
            };
          }),

        killEdgesForHandles: (nodeId, handleIds) => {
          const handleSet = new Set(handleIds);
          // Mark matching edges as dying
          set((s) => ({
            edges: s.edges.map((e) =>
              e.target === nodeId && handleSet.has(e.targetHandle ?? "")
                ? { ...e, data: { ...e.data, dying: true } }
                : e
            ),
          }));
          // Remove after animation
          setTimeout(() => {
            set((s) => {
              const edges = s.edges.filter(
                (e) => !(e.target === nodeId && handleSet.has(e.targetHandle ?? ""))
              );
              return {
                edges,
                spaces: syncSpace(s.spaces, s.activeSpaceId, s.nodes, edges, s.nodeCounters),
              };
            });
          }, 450);
        },

        remapTargetHandle: (nodeId, fromHandle, toHandle) =>
          set((s) => {
            const edges = s.edges.map((e) =>
              e.target === nodeId && e.targetHandle === fromHandle
                ? { ...e, targetHandle: toHandle }
                : e
            );
            return { edges, spaces: syncSpace(s.spaces, s.activeSpaceId, s.nodes, edges, s.nodeCounters) };
          }),

        flashEdgeError: (edgeId) => {
          const setError = (val: boolean) =>
            set((s) => ({
              edges: s.edges.map((e) =>
                e.id === edgeId ? { ...e, data: { ...e.data, error: val } } : e
              ),
            }));
          setError(true);
          setTimeout(() => setError(false), 1400);
        },

        updateNodeData: (id, data, spaceId) =>
          set((s) => {
            // A late write (e.g. a POST resolving after the user switched space)
            // lands in the space the node lives in instead of being dropped.
            if (spaceId && spaceId !== s.activeSpaceId) {
              return {
                spaces: s.spaces.map((sp) =>
                  sp.id !== spaceId ? sp : {
                    ...sp,
                    updatedAt: Date.now(),
                    nodes: sp.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)),
                  }
                ),
              };
            }

            const nodes = s.nodes.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, ...data } } : n
            );

            // Capture param changes into per-type defaults so new nodes inherit them
            const nodeType = s.nodes.find((n) => n.id === id)?.type;
            let nodeDefaults = s.nodeDefaults;
            if (nodeType === "generateNode") {
              const pick = filterKeys(data, ["model", "aspectRatio", "quality", "azureQuality", "azureResolution"]);
              if (pick) nodeDefaults = { ...nodeDefaults, generateNode: { ...nodeDefaults.generateNode, ...pick } };
            } else if (nodeType === "videoGeneratorNode") {
              const pick = filterKeys(data, ["videoModel", "klingMode", "duration", "aspectRatio", "sound", "grokResolution"]);
              if (pick) nodeDefaults = { ...nodeDefaults, videoGeneratorNode: { ...nodeDefaults.videoGeneratorNode, ...pick } };
            }

            return {
              nodes,
              nodeDefaults,
              spaces: syncSpace(s.spaces, s.activeSpaceId, nodes, s.edges, s.nodeCounters),
            };
          }),

        updateNodeSize: (id, width, height) => {
          // Ignore junk sizes — the ResizeObserver that drives this can fire
          // mid-teardown / mid-transition with a collapsed (0 / non-finite)
          // measurement, which must never be persisted as the node's real size.
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;

          // Skip no-op updates — the observer also fires on every layout tick
          // (image loads, CSS transitions); re-writing an identical size just
          // churns `spaces` and keeps re-arming the sync debounce so it never
          // actually flushes.
          const current = get().nodes.find((n) => n.id === id);
          if (current && current.width === width && current.height === height) return;

          set((s) => {
            const GROUP_PADDING = 24;

            // Update the resized node first
            let nodes = s.nodes.map((n) =>
              n.id === id
                ? { ...n, width, height, style: { ...n.style, width, height } }
                : n
            );

            // Expand the group if the resized node now exceeds its bounds (never shrink)
            nodes = nodes.map((g) => {
              if (g.type !== "groupNode") return g;
              const memberIds = g.data?.memberIds as string[] | undefined;
              if (!memberIds?.includes(id)) return g;

              const node = nodes.find((n) => n.id === id);
              if (!node) return g;

              const gx = g.position.x;
              const gy = g.position.y;
              const gw = (g.style?.width  as number | undefined) ?? 0;
              const gh = (g.style?.height as number | undefined) ?? 0;

              // Right and bottom edges the node now occupies
              const nodeR = node.position.x + width;
              const nodeB = node.position.y + height;

              // Required group extents to contain the node (with padding)
              const reqX = Math.min(gx, node.position.x - GROUP_PADDING);
              const reqY = Math.min(gy, node.position.y - GROUP_PADDING);
              const reqR = Math.max(gx + gw, nodeR + GROUP_PADDING);
              const reqB = Math.max(gy + gh, nodeB + GROUP_PADDING);

              if (reqX === gx && reqY === gy && reqR === gx + gw && reqB === gy + gh) return g;

              return {
                ...g,
                position: { x: reqX, y: reqY },
                style: { ...g.style, width: reqR - reqX, height: reqB - reqY },
              };
            });

            return {
              nodes,
              spaces: syncSpace(s.spaces, s.activeSpaceId, nodes, s.edges, s.nodeCounters),
            };
          });
        },

        setIsRunning:     (v) => set({ isRunning: v }),
        toggleDebug:      () => set((s) => ({ debugMode: !s.debugMode })),

        connectingHandleType: null,
        setConnectingHandleType: (type) => set({ connectingHandleType: type }),

        saveViewport: (viewport) =>
          set((s) => ({
            spaces: s.spaces.map((sp) =>
              sp.id === s.activeSpaceId ? { ...sp, viewport } : sp
            ),
          })),

        loadSpacesFromDB: (dbSpaces) =>
          set((s) => {
            if (!dbSpaces.length) return {};

            // Build a lookup of local spaces by id
            const localById = new Map(s.spaces.map((sp) => [sp.id, sp]));

            // For each DB space, prefer whichever version is newer (local wins on tie).
            const merged = dbSpaces.map((dbSp) => {
              const local = localById.get(dbSp.id);
              if (!local) return dbSp;
              const localTs = local.updatedAt ?? local.createdAt ?? 0;
              const dbTs    = dbSp.updatedAt  ?? dbSp.createdAt  ?? 0;
              return localTs >= dbTs ? local : dbSp;
            });

            // Add local-only spaces (not yet in DB).
            // Always keep the active space (it may have just been created and is empty).
            // Skip other empty spaces — those are initialization placeholders.
            const dbIds = new Set(dbSpaces.map((sp) => sp.id));
            for (const sp of s.spaces) {
              if (!dbIds.has(sp.id)) {
                if (sp.id === s.activeSpaceId || sp.nodes.length > 0 || sp.edges.length > 0) {
                  merged.push(sp);
                }
              }
            }

            // If the current active space isn't in the merged set (e.g. it was an
            // empty placeholder), fall back to the first real DB space.
            const spaces   = merged.map(sanitizeSpace);
            const activeId = spaces.find((sp) => sp.id === s.activeSpaceId)?.id ?? spaces[0].id;
            const active   = spaces.find((sp) => sp.id === activeId)!;
            return {
              spaces,
              activeSpaceId: activeId,
              nodes:         active.nodes,
              edges:         active.edges,
              nodeCounters:  active.nodeCounters,
            };
          }),

        clearLocalData: () => {
          const fresh = makeSpace("Space 1");
          set({
            spaces:        [fresh],
            activeSpaceId: fresh.id,
            nodes:         [],
            edges:         [],
            nodeCounters:  {},
            undoStack:     [],
            redoStack:     [],
          });
        },

        toasts: [],
        addToast: (message, type = "error", href, title, preview) =>
          set((s) => {
            const id = Math.random().toString(36).slice(2);
            return { toasts: [...s.toasts, { id, message, type, href, title, preview }] };
          }),
        removeToast: (id) =>
          set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

        kieKeySet:    null,
        setKieKeySet: (v) => set({ kieKeySet: v }),

        azureKeySet:    null,
        setAzureKeySet: (v) => set({ azureKeySet: v }),

        settingsOpen:              false,
        settingsSection:           "appearance",
        setSettingsOpen:           (v, section) => set(section ? { settingsOpen: v, settingsSection: section } : { settingsOpen: v }),
        setSettingsSection:        (section) => set({ settingsSection: section }),
        showDashboard:             true,
        setShowDashboard:          (v) => set({ showDashboard: v }),
        globalMuted:               true,
        setGlobalMuted:            (v) => set({ globalMuted: v }),
        sidebarCollapsed:          false,
        setSidebarCollapsed:       (v: boolean) => set({ sidebarCollapsed: v }),
      };
    },
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => {
        // No localStorage on the server: throwing disables persistence there, as before.
        if (typeof localStorage === "undefined") throw new Error("localStorage unavailable");
        return migratingStorage;
      }),
      partialize: (s) => ({
        spaces: s.spaces.map((sp) => ({
          ...sp,
          viewport: sp.viewport,
          // Strip base64 inputImage — only the durable r2Url survives reload
          nodes: sp.nodes.map((n) => ({
            ...n,
            data: { ...n.data, inputImage: undefined },
          })),
        })),
        activeSpaceId: s.activeSpaceId,
        // Also persist the live copies so a page refresh rehydrates correctly
        nodes: s.nodes.map((n) => ({
          ...n,
          data: { ...n.data, inputImage: undefined },
        })),
        edges:        s.edges,
        nodeCounters: s.nodeCounters,
        debugMode:    s.debugMode,
        sidebarCollapsed: s.sidebarCollapsed,
        nodeDefaults: s.nodeDefaults,
        lastNodeSize: s.lastNodeSize,
      }),

      // Migration: v0 had flat nodes/edges/nodeCounters; wrap them in a space.
      // Also sanitize in-flight job state so nothing is stuck "generating" forever.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Ensure nodeDefaults exists for old stored data
        if (!state.nodeDefaults) {
          state.nodeDefaults = { generateNode: {}, videoGeneratorNode: {} };
        }
        // Ensure lastNodeSize exists for old stored data
        if (!state.lastNodeSize) {
          state.lastNodeSize = {};
        }
        // If there are no spaces (old format), migrate
        if (!state.spaces || state.spaces.length === 0) {
          const sp = makeSpace("Space 1", {
            nodes:        state.nodes        ?? [],
            edges:        state.edges        ?? [],
            nodeCounters: state.nodeCounters ?? {},
          });
          state.spaces        = [sp];
          state.activeSpaceId = sp.id;
        }
        state.spaces = state.spaces.map(sanitizeSpace);
        state.nodes  = sanitizeNodes(state.nodes ?? []);
      },
    }
  )
);
