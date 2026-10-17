"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node, Edge, useUpdateNodeInternals } from "@xyflow/react";
import { MessageSquare, Image as ImageIcon, Play, Download, Dices } from "lucide-react";
import { Button } from "@/components/ui/button";
import NodeActionBar from "./NodeActionBar";
import MissingInputWarning from "./MissingInputWarning";
import { GeneratingSlot, JobErrorSlot, StatusChip } from "./JobSlot";
import { useWorkflowStore, NodeData, inflightSubmits } from "@/lib/store";
import { resolveImageUrl, resolveInputs } from "@/lib/executor";
import { useReadOnly } from "@/lib/readOnlyContext";
import { browserNotify, requestNotificationPermission } from "@/lib/browserNotify";
import { requestWorkflowSync } from "@/lib/workflowSyncBus";
import { reportGenerateSubmitted } from "@/lib/usePipelineRunner";
import { useJobStatus, submitGeneration, newClientRequestId, jobErrorCopy, JobSubmitError } from "@/lib/useJobStatus";
import { GAME_GROUPS, GAME_NODES, NODE_LABELS, gameNodeTypeFor, gameOutHandle, gameSpecFor, gameStepOf, type GameNodeType } from "@/lib/nodeTypes";
import { PROP_CATEGORIES, STEP_IO, accepts, blockingFailures, hasCurrentShape, isArtifactPort, type Artifact, type ArtifactKind, type Check, type Port, type StepInputs } from "@/lib/game/artifacts";
import { BUILDS, DEFAULT_BUILD } from "@/lib/game/poses";

type GameStepNodeType = Node<NodeData, GameNodeType>;

const DEFAULT_HEIGHT_M = 1.8;

/** Find the node in the given space (active space reads the live copy). */
function readNode(id: string, spaceId: string) {
  const s = useWorkflowStore.getState();
  const list = spaceId === s.activeSpaceId ? s.nodes : s.spaces.find((sp) => sp.id === spaceId)?.nodes;
  return list?.find((n) => n.id === id);
}

function wiresInto(id: string, port: Port, edges: Edge[]): Edge[] {
  return edges.filter((e) => e.target === id && e.targetHandle === port.id);
}

/**
 * Whether a game node's artifact still follows from its inputs: every wired
 * artifact input is itself current and not newer than this artifact; the
 * primary input is from the same run (a turnaround re-run starts a new run, so
 * everything after it goes out of date; a mesh re-run in the same run is newer
 * than the old rig); and the style wired now is the one it was drawn with.
 * An out-of-date artifact is shown as such and is never handed downstream.
 */
function artifactIsCurrent(id: string, nodes: Node<NodeData>[], edges: Edge[], depth = 0): boolean {
  const own = nodes.find((n) => n.id === id)?.data.artifact;
  if (!own || depth > 8) return false;
  for (const [i, port] of STEP_IO[own.kind].inputs.entries()) {
    if (!isArtifactPort(port)) continue;
    const edge = wiresInto(id, port, edges)[0];
    const up = edge ? nodes.find((n) => n.id === edge.source)?.data.artifact : undefined;
    if (port.kind === "style") {
      if (up?.runId !== own.styleRun) return false;
      if (!up) continue;
    } else if (!up) {
      if (port.optional) continue;
      return false;
    }
    if (i === 0 && up.runId !== own.runId) return false;
    if (Date.parse(up.createdAt) > Date.parse(own.createdAt) || !artifactIsCurrent(edge!.source, nodes, edges, depth + 1)) return false;
  }
  return true;
}

type InputCheck =
  | { ok: true; inputs: StepInputs }
  | { ok: false; reason: string; edgeId?: string };

/** Resolve every port of the step from the graph: text, image references, and upstream nodes' current artifacts. */
function checkInputs(id: string, step: ArtifactKind, nodes: Node<NodeData>[], edges: Edge[]): InputCheck {
  const inputs: StepInputs = { artifacts: {} };
  for (const port of STEP_IO[step].inputs) {
    const wired = wiresInto(id, port, edges);
    if (!wired.length) {
      if (port.optional) continue;
      return {
        ok: false,
        reason: port.kind === "prompt" ? `Connect a text node: ${port.label}`
          : port.kind === "image" ? `Connect at least one image: ${port.label}`
          : `Connect a ${NODE_LABELS[gameNodeTypeFor(port.kind)]} node`,
      };
    }
    if (port.kind === "prompt") {
      const text = resolveInputs(id, nodes, edges).prompt?.trim();
      if (!text && !port.optional) return { ok: false, reason: "The connected text node is empty", edgeId: wired[0].id };
      inputs.text = text || undefined;
    } else if (port.kind === "image") {
      const urls = wired.flatMap((e) => {
        const src = nodes.find((n) => n.id === e.source);
        const url = src ? resolveImageUrl(src, e.sourceHandle) : undefined;
        return url ? [url] : [];
      });
      if (!urls.length && !port.optional) return { ok: false, reason: "The connected image nodes have no picture yet", edgeId: wired[0].id };
      inputs.images = urls;
    } else {
      const edge = wired[0];
      const art = nodes.find((n) => n.id === edge.source)?.data.artifact;
      if (art && !artifactIsCurrent(edge.source, nodes, edges)) {
        return { ok: false, reason: `The ${NODE_LABELS[gameNodeTypeFor(port.kind)]} is out of date: run it again first`, edgeId: edge.id };
      }
      const verdict = accepts(art, port.kind);
      if (!verdict.ok) return { ok: false, reason: verdict.reason, edgeId: edge.id };
      inputs.artifacts[port.id] = art;
    }
  }
  return { ok: true, inputs };
}

function isArtifactOf(x: unknown, kind: ArtifactKind): x is Artifact {
  return typeof x === "object" && x !== null &&
    "kind" in x && x.kind === kind &&
    "checks" in x && Array.isArray(x.checks);
}

function fmt(v: number | string | boolean): string {
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(4)));
  return v;
}

function CheckRow({ check }: { check: Check }) {
  const [tag, tone] = check.pass
    ? ["pass", "text-verdigris"]
    : check.advisory ? ["warn", "text-ochre"] : ["FAIL", "text-sanguine"];
  const measure = check.value !== undefined
    ? `${fmt(check.value)}${check.limit !== undefined ? ` / ${fmt(check.limit)}` : ""}`
    : check.limit !== undefined ? `limit ${fmt(check.limit)}` : "";
  return (
    <li className="flex items-baseline gap-2 text-[11.5px] leading-[1.5]" title={check.detail}>
      <span className={`w-8 shrink-0 font-medium ${tone}`}>{tag}</span>
      <span className="min-w-0 flex-1 truncate text-ink-2">{check.id}</span>
      {measure && <span className="max-w-[45%] shrink-0 truncate tabular-nums text-ink-3">{measure}</span>}
    </li>
  );
}

function GltfSummary({ artifact }: { artifact: Extract<Artifact, { kind: "gltf" }> }) {
  const v = artifact.validator;
  const g = artifact.godot;
  return (
    <div className="flex flex-col gap-0.5 text-[11.5px] leading-[1.5] text-ink-2">
      <div title={`glTF-Validator ${v.version}`}>
        <span className="text-ink-3">Validator </span>
        <span className={v.errors > 0 ? "text-sanguine" : undefined}>{v.errors} errors</span>
        {` · ${v.warnings} warnings · ${v.infos} infos · ${v.hints} hints`}
      </div>
      <div title={g.importIssues.join("\n") || undefined}>
        <span className="text-ink-3">Godot {g.version} </span>
        <span className={g.importIssues.length > 0 ? "text-sanguine" : undefined}>
          {g.importIssues.length === 0 ? "imports clean" : `${g.importIssues.length} import issue${g.importIssues.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {g.clips.map((c) => (
        <div key={c.name} title={`loop seam ${fmt(c.loopSeamDeg)}° · seam gap ${fmt(c.maxSeamGap)} of height`}>
          <span className="text-ink-3">{c.name} </span>
          {`${c.loop ? "loops" : "once"} · ${c.frames} frames · stretch ${fmt(c.maxStretch)}`}
        </div>
      ))}
    </div>
  );
}

function AnimSetSummary({ artifact }: { artifact: Extract<Artifact, { kind: "animclip" }> }) {
  return (
    <div className="flex flex-col gap-0.5 text-[11.5px] leading-[1.5] text-ink-2">
      {artifact.clips.map((c) => (
        <div key={c.name} title={c.source}>
          <span className="text-ink-3">{c.name.replace(/-loop$/, "")} </span>
          {`${c.loop ? "loop" : "one-shot"} · ${c.frames} frames @ ${c.fps} fps`}
        </div>
      ))}
    </div>
  );
}

function StyleSummary({ artifact }: { artifact: Extract<Artifact, { kind: "style" }> }) {
  return (
    <div className="flex flex-col gap-1 text-[11.5px] leading-[1.5] text-ink-2">
      <div className="flex h-3 w-full overflow-hidden rounded-[var(--radius-sm)]" title="Palette measured from the references">
        {artifact.palette.map((c) => <span key={c.hex} style={{ background: c.hex, flexGrow: c.share }} title={`${c.hex} · ${Math.round(c.share * 100)}%`} />)}
      </div>
      <div>
        <span className="text-ink-3">References </span>{artifact.refs.length}
        {artifact.notes && <span className="text-ink-3"> · {artifact.notes}</span>}
      </div>
    </div>
  );
}

function SurfaceSummary({ artifact }: { artifact: Extract<Artifact, { kind: "surface" }> }) {
  const g = artifact.godot;
  return (
    <div className="flex flex-col gap-0.5 text-[11.5px] leading-[1.5] text-ink-2">
      <div>
        <span className="text-ink-3">Tile </span>
        {artifact.size} px over {artifact.tileM} m · albedo, normal, roughness
      </div>
      <div title={g.importIssues.join("\n") || undefined}>
        <span className="text-ink-3">Godot {g.version} </span>
        {`${artifact.renders.length} renders from ${artifact.renders.map((r) => r.heightM).join(" / ")} m`}
        {g.importIssues.length > 0 && <span className="text-sanguine"> · {g.importIssues.length} import issues</span>}
      </div>
    </div>
  );
}

/** One input handle: text and image ports look like the generators' own; artifact ports take the producing family's pigment. */
function PortHandle({ port, top, connected, error }: { port: Port; top: string; connected: boolean; error: boolean }) {
  const artifactSpec = isArtifactPort(port) ? gameSpecFor(port.kind) : undefined;
  const Icon = artifactSpec?.icon ?? (port.kind === "image" ? ImageIcon : MessageSquare);
  const kindClass = port.kind === "prompt" ? "node-handle-icon-prompt"
    : port.kind === "image" ? "node-handle-icon-image"
    : `node-handle-icon-game node-handle-icon-game-in-${port.kind}`;
  return (
    <Handle
      type="target"
      position={Position.Left}
      id={port.id}
      style={{ top, ...(artifactSpec ? { ["--game-accent" as string]: GAME_GROUPS[artifactSpec.group].accent } : {}) }}
      title={`${port.label}${port.optional ? " (optional)" : ""}`}
      className={`node-handle-icon ${kindClass}${connected ? " node-handle-connected" : ""}${error ? " node-handle-error" : ""}`}
    >
      <Icon size={13} strokeWidth={1.8} />
    </Handle>
  );
}

export default function GameStepNode({ id, type, data, selected }: NodeProps<GameStepNodeType>) {
  const step = GAME_NODES[type].step;
  const spec = gameSpecFor(step);
  const ports = STEP_IO[step].inputs;
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const updateNodeSize = useWorkflowStore((s) => s.updateNodeSize);
  const flashEdgeError = useWorkflowStore((s) => s.flashEdgeError);
  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const addNode = useWorkflowStore((s) => s.addNode);
  const insertEdge = useWorkflowStore((s) => s.insertEdge);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const parentGroupSelected = useWorkflowStore((s) => {
    const self = s.nodes.find((n) => n.id === id);
    if (!self?.parentId) return false;
    return s.nodes.find((n) => n.id === self.parentId)?.selected ?? false;
  });
  const multiSelected = useWorkflowStore((s) => s.nodes.filter((n) => n.selected).length > 1);

  const updateNodeInternals = useUpdateNodeInternals();
  const cardRef = useRef<HTMLDivElement>(null);
  const triggeringRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  /** Mesh only: discard the cached raw generation and pay for a new one. */
  const [regenerate, setRegenerate] = useState(false);

  const status = data.status ?? "idle";
  const jobRunning = status === "running" || status === "pending";
  const isQueued = !jobRunning && !!data.pipelineQueued;
  /** An artifact stored by an older version in a shape this code no longer reads shows as not made yet. */
  const artifact = data.artifact && hasCurrentShape(data.artifact) ? data.artifact : undefined;
  const failed = artifact ? blockingFailures(artifact) : [];
  const label = data.label;
  const baseName = (data.name ?? label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character";
  /** The step's downloadable deliverable: Godot .glb, Unreal .fbx, the map / sky PNG, the material .zip, or a prop's .glb / icon .png. */
  const exportFile = useMemo(() => (
    artifact?.kind === "gltf" ? { url: artifact.glbUrl, name: `${baseName}.glb` }
      : artifact?.kind === "unreal" ? { url: artifact.zipUrl, name: `${baseName}_unreal.zip` }
        : artifact?.kind === "worldmap" ? { url: artifact.mapUrl, name: `${baseName}.png` }
          : artifact?.kind === "skybox" ? { url: artifact.panoramaUrl, name: `${baseName}.png` }
            : artifact?.kind === "surface" ? { url: artifact.zipUrl, name: artifact.zipUrl.split("/").pop()! }
              : artifact?.kind === "prop" ? { url: artifact.glbUrl, name: `${baseName}.glb` }
                : artifact?.kind === "icon" ? { url: artifact.pngUrl, name: `${baseName}.png` }
                  : artifact?.kind === "equip" ? { url: artifact.glbUrl, name: `${baseName}.glb` } : undefined
  ), [artifact, baseName]);

  // ── Input state (live) ─────────────────────────────────────────────────────
  const inputCheck = checkInputs(id, step, nodes, edges);
  const upstreams = edges
    .filter((e) => e.target === id)
    .map((e) => nodes.find((n) => n.id === e.source))
    .filter((n): n is Node<NodeData> => !!n);
  const upstreamBusy = upstreams.some((u) =>
    u.data.status === "running" || u.data.status === "pending" || !!u.data.pendingGenerate || !!u.data.pipelineQueued,
  );
  const showInputProblem = !inputCheck.ok && !jobRunning && !isQueued && !upstreamBusy;
  /** The artifact shown no longer follows from its inputs (an upstream re-ran, failed or is running). */
  const outOfDate = !!artifact && !jobRunning && !artifactIsCurrent(id, nodes, edges);
  /** The upstream game node that changed, when it is itself current (named in the out-of-date note). */
  const changedUpstream = outOfDate ? upstreams.find((u) => gameStepOf(u.type) && artifactIsCurrent(u.id, nodes, edges)) : undefined;
  const sourceConnected = edges.some((e) => e.source === id);

  // Re-sync edge anchors whenever the card's content changes size
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      updateNodeSize(id, el.offsetWidth, el.offsetHeight);
      updateNodeInternals(id);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, updateNodeSize, updateNodeInternals]);

  const handleDelete = useCallback(() => {
    onNodesChange([{ type: "remove", id }]);
  }, [id, onNodesChange]);

  const handleDuplicate = useCallback(() => {
    const state = useWorkflowStore.getState();
    const src = state.nodes.find((n) => n.id === id);
    if (!src) return;
    const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const running = src.data.status === "running" || src.data.status === "pending";
    onNodesChange([{ type: "select", id, selected: false }]);
    addNode({
      ...src,
      id: newId,
      position: { x: src.position.x + 20, y: src.position.y + 20 },
      selected: true,
      data: {
        ...src.data,
        // An in-flight job belongs to the original, not the copy.
        ...(running ? { status: "idle" as const, artifact: undefined } : {}),
        taskId: undefined, clientRequestId: undefined, jobStartedAt: undefined,
        hasError: false, pendingGenerate: false, pipelineQueued: false,
      },
    });
    state.edges
      .filter((e) => e.target === id && e.deletable !== false)
      .forEach((e) => insertEdge({
        ...e,
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        target: newId,
      }));
  }, [id, addNode, insertEdge, onNodesChange]);

  const saveFile = useCallback(async () => {
    if (!exportFile || isSaving) return;
    setIsSaving(true);
    try {
      const resp = await fetch(exportFile.url);
      const blob = await resp.blob();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = obj; a.download = exportFile.name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(obj);
    } finally {
      setIsSaving(false);
    }
  }, [exportFile, isSaving]);

  // ── Settle the job ─────────────────────────────────────────────────────────
  const finishJob = useCallback((spaceId: string, outcome: { artifact: Artifact } | { error: string; code?: string }) => {
    const d = readNode(id, spaceId)?.data;
    if (!d) return;
    const clear = { taskId: undefined, clientRequestId: undefined, jobStartedAt: undefined };
    const nodeLabel = d.label ?? NODE_LABELS[type];
    if ("artifact" in outcome) {
      const rejected = blockingFailures(outcome.artifact);
      // A rejected artifact stays on the node so its checks are visible; downstream refuses it.
      updateNodeData(id, {
        ...clear,
        artifact: outcome.artifact,
        status: rejected.length ? "error" : "done",
        errorMsg: rejected.length ? `Rejected: ${rejected.map((c) => c.id).join(", ")}` : undefined,
        errorCode: undefined,
      }, spaceId);
      browserNotify(rejected.length ? `${nodeLabel} rejected` : `${nodeLabel} ready`, rejected.length ? rejected.map((c) => c.id).join(", ") : nodeLabel);
    } else {
      updateNodeData(id, { ...clear, status: "error", errorMsg: outcome.error, errorCode: outcome.code }, spaceId);
      browserNotify(`${nodeLabel} failed`, outcome.error);
    }
    requestWorkflowSync();
  }, [id, type, updateNodeData]);

  useJobStatus(status === "running" ? data.taskId : undefined, {
    startedAt: data.jobStartedAt,
    stream: true,
    onDone: (r) => {
      const spaceId = useWorkflowStore.getState().activeSpaceId;
      finishJob(spaceId, isArtifactOf(r.artifact, step)
        ? { artifact: r.artifact }
        : { error: "The step finished but returned no artifact. Retry?", code: "failed" });
    },
    onError: (f) => finishJob(useWorkflowStore.getState().activeSpaceId, { error: f.message, code: f.code }),
  });

  /**
   * Submit the step. Resolves `true` once a job is running (or already was),
   * `false` if the input check stopped it before anything started.
   */
  const run = useCallback(async (): Promise<boolean> => {
    const s = useWorkflowStore.getState();
    const self = s.nodes.find((n) => n.id === id);
    if (!self) return false;
    if (inflightSubmits.has(id) || self.data.status === "running" || self.data.status === "pending") return true;
    const check = checkInputs(id, step, s.nodes as Node<NodeData>[], s.edges);
    if (!check.ok) {
      // The reason is already shown inline; flag the node and the offending wire.
      updateNodeData(id, { hasError: true });
      if (check.edgeId) flashEdgeError(check.edgeId);
      return false;
    }
    inflightSubmits.add(id);
    try {
      requestNotificationPermission();
      const spaceId = s.activeSpaceId;
      const clientRequestId = self.data.errorCode === "interrupted" && self.data.clientRequestId
        ? self.data.clientRequestId
        : newClientRequestId();
      // A world map without a sketch draws coastlines from the node's seed; a new node picks one and keeps it.
      const seed = step === "worldmap" ? self.data.seed ?? Math.floor(Math.random() * 1_000_000) : undefined;
      const body = {
        step,
        inputs: check.inputs,
        ...(step === "turnaround" ? { build: self.data.build ?? DEFAULT_BUILD } : {}),
        ...(step === "propsheet" ? { category: self.data.category ?? PROP_CATEGORIES[0].id } : {}),
        ...(step === "mesh" ? { heightM: self.data.heightM ?? DEFAULT_HEIGHT_M, ...(regenerate ? { regenerate: true } : {}) } : {}),
        ...(step === "gltf" || step === "unreal" ? { name: self.data.name ?? self.data.label } : {}),
        ...(seed !== undefined ? { seed } : {}),
      };
      // Clear the old artifact first so downstream nodes see this output as missing.
      updateNodeData(id, {
        status: "running",
        artifact: undefined,
        errorMsg: undefined,
        errorCode: undefined,
        taskId: undefined,
        hasError: false,
        clientRequestId,
        jobStartedAt: Date.now(),
        ...(seed !== undefined ? { seed } : {}),
      }, spaceId);
      try {
        const { taskId } = await submitGeneration("/api/game/step", body, clientRequestId);
        updateNodeData(id, { taskId }, spaceId);
      } catch (e: unknown) {
        const err = e instanceof JobSubmitError ? e : new JobSubmitError(jobErrorCopy(undefined, String(e)));
        finishJob(spaceId, { error: err.message, code: err.code });
      }
      return true;
    } finally {
      inflightSubmits.delete(id);
    }
  }, [id, step, regenerate, updateNodeData, flashEdgeError, finishJob]);

  // Pipeline trigger. `pendingGenerate` stays set until the submit phase settles,
  // so the runner can't mistake "not started yet" for "finished".
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);
  useEffect(() => {
    if (!data.pendingGenerate || triggeringRef.current) return;
    triggeringRef.current = true;
    const spaceId = useWorkflowStore.getState().activeSpaceId;
    runRef.current().catch(() => false).then((started) => {
      triggeringRef.current = false;
      reportGenerateSubmitted(id, started);
      updateNodeData(id, { pendingGenerate: false }, spaceId);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.pendingGenerate]);

  const outHandle = gameOutHandle(step);
  const accent = GAME_GROUPS[spec.group].accent;

  return (
    <div
      ref={cardRef}
      className={`node-card w-full${jobRunning ? " node-generating" : ""}${isQueued ? " node-queued" : ""}${data.hasError ? " node-error-blink" : ""}`}
      style={{ minWidth: 260 }}
      onAnimationEnd={(e) => { if (e.animationName === "node-error-blink") updateNodeData(id, { hasError: false }); }}
    >
      <NodeActionBar
        visible={!!selected && !data.locked && !parentGroupSelected && !multiSelected && !readOnly}
        hasContent={!!exportFile}
        isSaving={isSaving}
        onDelete={handleDelete}
        onSave={exportFile ? () => { void saveFile(); } : undefined}
        onDuplicate={handleDuplicate}
      />
      <span className="node-above-label">{label}</span>
      {showInputProblem && !data.locked && <MissingInputWarning messages={[inputCheck.reason]} />}

      {ports.map((port, i) => (
        <PortHandle
          key={port.id}
          port={port}
          top={`${((i + 1) / (ports.length + 1)) * 100}%`}
          connected={edges.some((e) => e.target === id && e.targetHandle === port.id)}
          error={showInputProblem && !!data.hasError}
        />
      ))}
      {outHandle && (
        <Handle
          type="source"
          position={Position.Right}
          id={outHandle}
          style={{ top: "50%", ["--game-accent" as string]: accent }}
          data-game-kind={step}
          title={`${spec.noun} output`}
          className={`node-handle-icon node-handle-icon-game node-handle-icon-out-game${sourceConnected ? " node-handle-connected" : ""}`}
        >
          <spec.icon size={13} strokeWidth={1.8} />
        </Handle>
      )}

      {/* ── Preview ── */}
      <div className="relative aspect-square w-full overflow-hidden rounded-t-[inherit] bg-mat">
        {jobRunning ? (
          <GeneratingSlot startedAt={data.jobStartedAt} label="Running" model={NODE_LABELS[type]} />
        ) : artifact?.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local /generated files
          <img src={artifact.previewUrl} alt={`${spec.noun} preview`} className={`absolute inset-0 size-full object-contain${outOfDate ? " opacity-40" : ""}`} draggable={false} />
        ) : status === "error" && !artifact ? (
          <JobErrorSlot
            message={data.errorMsg ?? jobErrorCopy(undefined)}
            onRetry={readOnly ? undefined : () => { void run(); }}
            retryDisabled={!inputCheck.ok}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center pointer-events-none select-none">
            <span className="text-[12.5px] text-ink-3">The {spec.noun} will appear here.</span>
          </div>
        )}
        {(isQueued || artifact) && !jobRunning && (
          <div className="absolute top-2 left-2 z-30">
            {isQueued
              ? <StatusChip tone="queued">Queued</StatusChip>
              : outOfDate
                ? <StatusChip tone="queued">Out of date</StatusChip>
                : failed.length > 0
                  ? <StatusChip tone="failed">Rejected</StatusChip>
                  : <StatusChip tone="done">Passed</StatusChip>}
          </div>
        )}
      </div>

      {/* ── Results + controls ── */}
      <div className="flex flex-col gap-2 p-3">
        {artifact && (
          <div className={`flex flex-col gap-2${outOfDate ? " opacity-50" : ""}`}>
            {artifact.kind === "gltf" && <GltfSummary artifact={artifact} />}
            {artifact.kind === "animclip" && <AnimSetSummary artifact={artifact} />}
            {artifact.kind === "style" && <StyleSummary artifact={artifact} />}
            {artifact.kind === "surface" && <SurfaceSummary artifact={artifact} />}
            {artifact.kind === "unreal" && (
              <div className="text-[11.5px] leading-[1.5] text-ink-2">
                <span className="text-ink-3">UE5 mannequin </span>
                {artifact.bones.length} bones · {artifact.clips.map((c) => `${c.name.replace(/-loop$/, "")} ${c.frames}`).join(" · ")} frames @ {artifact.fps} fps
                {artifact.unreal ? ` · imported in Unreal ${artifact.unreal.version.replace(/^UE_/, "")}` : " · not imported in Unreal (not installed)"}
              </div>
            )}
            {artifact.kind === "worldmap" && (
              <div className="text-[11.5px] leading-[1.5] text-ink-2">
                <span className="text-ink-3">Coastlines </span>
                {artifact.maskSource === "sketch" ? "from the sketch" : `seed ${artifact.seed}`} · {artifact.width}×{artifact.height}
                {artifact.ocr.version && ` · ${artifact.ocr.version}`}
              </div>
            )}
            {artifact.kind === "skybox" && (
              <div className="text-[11.5px] leading-[1.5] text-ink-2">
                <span className="text-ink-3">Panorama </span>
                {artifact.width}×{artifact.height}{artifact.seamRepaired && " · wrap blended"}
                {artifact.godot.version && ` · Godot ${artifact.godot.version}, ${Object.keys(artifact.godot.views).length} views`}
              </div>
            )}
            {artifact.checks.length > 0 && (
              <ul className="nowheel max-h-[168px] overflow-y-auto">
                {artifact.checks.map((c) => <CheckRow key={c.id} check={c} />)}
              </ul>
            )}
            <div className="flex items-center gap-2 text-[11px] tabular-nums text-ink-3">
              <span>
                {fmt(artifact.cost.seconds)} s
                {artifact.cost.kieCredits !== undefined && ` · ${fmt(artifact.cost.kieCredits)} kie credits`}
                {artifact.cost.gpuProvider && ` · ${artifact.cost.gpuProvider}`}
              </span>
              <span className="ml-auto font-mono" title={`Run ${artifact.runId}`}>run {artifact.runId.slice(0, 8)}</span>
            </div>
            {exportFile && (
              <a
                href={exportFile.url}
                download={exportFile.name}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); void saveFile(); }}
                onMouseDown={(e) => e.stopPropagation()}
                className="nodrag inline-flex items-center gap-1.5 self-start text-[12px] text-lapis hover:underline underline-offset-4"
              >
                <Download className="size-3" strokeWidth={2} />
                {isSaving ? "Saving…" : exportFile.name}
              </a>
            )}
          </div>
        )}

        {outOfDate && (
          <p className="text-[11.5px] leading-snug text-ochre">
            Out of date: {changedUpstream ? `the ${changedUpstream.data.label ?? NODE_LABELS[changedUpstream.type as GameNodeType]}` : "an input"} changed since this ran. Run again to update it.
          </p>
        )}
        {status === "error" && artifact && data.errorMsg && (
          <p className="text-[11.5px] leading-snug text-sanguine">{data.errorMsg}</p>
        )}
        {showInputProblem && (
          <p className="text-[11.5px] leading-snug text-sanguine">{inputCheck.reason}</p>
        )}

        {!readOnly && (
          <div className="flex items-center gap-2" onMouseDown={(e) => e.stopPropagation()}>
            {step === "turnaround" && (
              <label className="flex items-center gap-1.5 text-[11.5px] text-ink-3" title="Body proportions of the mannequin the character is drawn over">
                Build
                <select
                  value={data.build ?? DEFAULT_BUILD}
                  onChange={(e) => updateNodeData(id, { build: e.target.value })}
                  className="nodrag h-6 rounded-[var(--radius-sm)] bg-wash px-1 text-[12px] text-ink outline-none focus:ring-1 focus:ring-lapis"
                >
                  {BUILDS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                </select>
              </label>
            )}
            {step === "propsheet" && (
              <label className="flex items-center gap-1.5 text-[11.5px] text-ink-3" title="Held in a character's closed fist (gets a grip box and can be equipped), or resting on the ground">
                Item
                <select
                  value={data.category ?? PROP_CATEGORIES[0].id}
                  onChange={(e) => updateNodeData(id, { category: e.target.value })}
                  className="nodrag h-6 rounded-[var(--radius-sm)] bg-wash px-1 text-[12px] text-ink outline-none focus:ring-1 focus:ring-lapis"
                >
                  {PROP_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
            )}
            {step === "mesh" && (
              <>
                <label className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                  Height
                  <input
                    type="number"
                    min={0.3}
                    max={5}
                    step={0.05}
                    value={data.heightM ?? DEFAULT_HEIGHT_M}
                    onChange={(e) => {
                      const v = e.target.valueAsNumber;
                      if (Number.isFinite(v) && v > 0) updateNodeData(id, { heightM: v });
                    }}
                    className="nodrag nowheel h-6 w-14 rounded-[var(--radius-sm)] bg-wash px-1.5 text-[12px] tabular-nums text-ink outline-none focus:ring-1 focus:ring-lapis"
                  />
                  m
                </label>
                <label className="flex items-center gap-1 text-[11.5px] text-ink-3" title="Discard the cached generation and pay for a new mesh">
                  <input
                    type="checkbox"
                    checked={regenerate}
                    onChange={(e) => setRegenerate(e.target.checked)}
                    className="nodrag accent-[var(--lapis)]"
                  />
                  New mesh
                </label>
              </>
            )}
            {step === "worldmap" && (
              <label className="flex items-center gap-1.5 text-[11.5px] text-ink-3" title="Seed of the generated coastlines (unused when a layout sketch is wired)">
                Seed
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={data.seed ?? ""}
                  placeholder="random"
                  onChange={(e) => {
                    const v = e.target.valueAsNumber;
                    updateNodeData(id, { seed: Number.isSafeInteger(v) && v >= 0 ? v : undefined });
                  }}
                  className="nodrag nowheel h-6 w-20 rounded-[var(--radius-sm)] bg-wash px-1.5 text-[12px] tabular-nums text-ink outline-none placeholder:text-ink-4 focus:ring-1 focus:ring-lapis"
                />
                <button
                  type="button"
                  title="New coastlines"
                  aria-label="New seed"
                  onClick={() => updateNodeData(id, { seed: Math.floor(Math.random() * 1_000_000) })}
                  className="nodrag inline-flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-ink-3 hover:bg-wash hover:text-ink"
                >
                  <Dices className="size-3.5" strokeWidth={1.8} />
                </button>
              </label>
            )}
            {(step === "gltf" || step === "unreal") && (
              <input
                type="text"
                value={data.name ?? ""}
                placeholder={label}
                aria-label="File name"
                onChange={(e) => updateNodeData(id, { name: e.target.value || undefined })}
                className="nodrag h-6 min-w-0 flex-1 rounded-[var(--radius-sm)] bg-wash px-1.5 text-[12px] text-ink outline-none placeholder:text-ink-4 focus:ring-1 focus:ring-lapis"
              />
            )}
            <Button
              size="sm"
              variant={inputCheck.ok ? "primary" : "outline"}
              onClick={(e) => { e.stopPropagation(); void run(); }}
              disabled={jobRunning || data.locked}
              aria-busy={jobRunning}
              title={inputCheck.ok ? undefined : inputCheck.reason}
              className={`ml-auto h-7 gap-1.5 px-3 text-[12px]${inputCheck.ok ? "" : " text-sanguine"}`}
            >
              <Play className="size-3" strokeWidth={2} />
              {artifact || status === "error" ? "Run again" : "Run"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
