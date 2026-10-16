"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node, Edge, useUpdateNodeInternals } from "@xyflow/react";
import { MessageSquare, PersonStanding, Box, Bone, Footprints, PackageCheck, Play, Download, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import NodeActionBar from "./NodeActionBar";
import MissingInputWarning from "./MissingInputWarning";
import { GeneratingSlot, JobErrorSlot, StatusChip } from "./JobSlot";
import { useWorkflowStore, NodeData, inflightSubmits } from "@/lib/store";
import { resolveInputs } from "@/lib/executor";
import { useReadOnly } from "@/lib/readOnlyContext";
import { browserNotify, requestNotificationPermission } from "@/lib/browserNotify";
import { requestWorkflowSync } from "@/lib/workflowSyncBus";
import { reportGenerateSubmitted } from "@/lib/usePipelineRunner";
import { useJobStatus, submitGeneration, newClientRequestId, jobErrorCopy, JobSubmitError } from "@/lib/useJobStatus";
import { GAME_NODE_STEP, NODE_LABELS, gameNodeTypeFor, gameOutHandle, type GameNodeType } from "@/lib/nodeTypes";
import { STEP_IO, accepts, blockingFailures, type Artifact, type ArtifactKind, type Check } from "@/lib/game/artifacts";
import { BUILDS, DEFAULT_BUILD } from "@/lib/game/poses";

type GameStepNodeType = Node<NodeData, GameNodeType>;

const DEFAULT_HEIGHT_M = 1.8;

const KIND_ICON: Record<ArtifactKind, LucideIcon> = {
  turnaround: PersonStanding,
  mesh: Box,
  skeleton: Bone,
  animclip: Footprints,
  gltf: PackageCheck,
};

const KIND_NOUN: Record<ArtifactKind, string> = {
  turnaround: "turnaround sheet",
  mesh: "mesh",
  skeleton: "rigged mesh",
  animclip: "walk cycle",
  gltf: "glTF asset",
};

/** Find the node in the given space (active space reads the live copy). */
function readNode(id: string, spaceId: string) {
  const s = useWorkflowStore.getState();
  const list = spaceId === s.activeSpaceId ? s.nodes : s.spaces.find((sp) => sp.id === spaceId)?.nodes;
  return list?.find((n) => n.id === id);
}

type InputCheck =
  | { ok: true; body: { concept: string } | { input: Artifact } }
  | { ok: false; reason: string; edgeId?: string };

/**
 * Whether a game node's artifact still follows from its input: the upstream
 * node's artifact is itself current, belongs to the same run, and is not newer
 * than this one. A turnaround re-run starts a new run, so everything after it
 * goes out of date; a mesh re-run in the same run is newer than the old rig.
 * An out-of-date artifact is shown as such and is never handed downstream.
 */
function artifactIsCurrent(id: string, nodes: Node<NodeData>[], edges: Edge[], depth = 0): boolean {
  const self = nodes.find((n) => n.id === id);
  const own = self?.data.artifact;
  if (!own || depth > 8) return false;
  if (STEP_IO[own.kind].input === "prompt") return true;
  const edge = edges.find((e) => e.target === id);
  const up = edge ? nodes.find((n) => n.id === edge.source)?.data.artifact : undefined;
  return !!up && up.runId === own.runId && Date.parse(up.createdAt) <= Date.parse(own.createdAt) &&
    artifactIsCurrent(edge!.source, nodes, edges, depth + 1);
}

/** Resolve the step's single input from the graph: prompt text (turnaround) or the upstream node's current artifact. */
function checkInput(id: string, step: ArtifactKind, nodes: Node<NodeData>[], edges: Edge[]): InputCheck {
  const need = STEP_IO[step].input;
  const edge = edges.find((e) => e.target === id);
  if (!edge) {
    return {
      ok: false,
      reason: need === "prompt"
        ? "Connect a text node with the character concept"
        : `Connect a ${NODE_LABELS[gameNodeTypeFor(need)]} node`,
    };
  }
  if (need === "prompt") {
    const concept = resolveInputs(id, nodes, edges).prompt?.trim();
    return concept ? { ok: true, body: { concept } } : { ok: false, reason: "The connected text node is empty", edgeId: edge.id };
  }
  const input = nodes.find((n) => n.id === edge.source)?.data.artifact;
  if (input && !artifactIsCurrent(edge.source, nodes, edges)) {
    return { ok: false, reason: `The ${NODE_LABELS[gameNodeTypeFor(need)]} is out of date: run it again first`, edgeId: edge.id };
  }
  const verdict = accepts(input, need);
  return verdict.ok && input ? { ok: true, body: { input } } : { ok: false, reason: verdict.ok ? "" : verdict.reason, edgeId: edge.id };
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
        {g.animation !== undefined && ` · ${g.animation}${g.loop ? " (loops)" : g.loop === false ? " (no loop)" : ""}`}
        {g.frames !== undefined && ` · ${g.frames} frames`}
        {g.maxStretch !== undefined && ` · stretch ${fmt(g.maxStretch)}`}
      </div>
    </div>
  );
}

export default function GameStepNode({ id, type, data, selected }: NodeProps<GameStepNodeType>) {
  const step = GAME_NODE_STEP[type];
  const need = STEP_IO[step].input;
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
  const artifact = data.artifact;
  const failed = artifact ? blockingFailures(artifact) : [];
  const label = data.label;
  const glbName = `${(data.name ?? label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character"}.glb`;

  // ── Input state (live) ─────────────────────────────────────────────────────
  const inputCheck = checkInput(id, step, nodes, edges);
  const inputEdge = edges.find((e) => e.target === id);
  const upstream = inputEdge ? nodes.find((n) => n.id === inputEdge.source) : undefined;
  const upstreamBusy = !!upstream && (
    upstream.data.status === "running" || upstream.data.status === "pending" ||
    !!upstream.data.pendingGenerate || !!upstream.data.pipelineQueued
  );
  const showInputProblem = !inputCheck.ok && !jobRunning && !isQueued && !upstreamBusy;
  /** The artifact shown no longer follows from the input (upstream re-ran, failed or is running). */
  const outOfDate = !!artifact && !jobRunning && !artifactIsCurrent(id, nodes, edges);
  const targetConnected = !!inputEdge;
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

  const saveGlb = useCallback(async () => {
    if (artifact?.kind !== "gltf" || isSaving) return;
    setIsSaving(true);
    try {
      const resp = await fetch(artifact.glbUrl);
      const blob = await resp.blob();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = obj; a.download = glbName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(obj);
    } finally {
      setIsSaving(false);
    }
  }, [artifact, glbName, isSaving]);

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
    const check = checkInput(id, step, s.nodes as Node<NodeData>[], s.edges);
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
      const body = {
        step,
        ...check.body,
        ...(step === "turnaround" ? { build: self.data.build ?? DEFAULT_BUILD } : {}),
        ...(step === "mesh" ? { heightM: self.data.heightM ?? DEFAULT_HEIGHT_M, ...(regenerate ? { regenerate: true } : {}) } : {}),
        ...(step === "gltf" ? { name: self.data.name ?? self.data.label } : {}),
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

  const InputIcon = need === "prompt" ? MessageSquare : KIND_ICON[need];
  const OutputIcon = KIND_ICON[step];
  const outHandle = gameOutHandle(step);

  return (
    <div
      ref={cardRef}
      className={`node-card w-full${jobRunning ? " node-generating" : ""}${isQueued ? " node-queued" : ""}${data.hasError ? " node-error-blink" : ""}`}
      style={{ minWidth: 260 }}
      onAnimationEnd={(e) => { if (e.animationName === "node-error-blink") updateNodeData(id, { hasError: false }); }}
    >
      <NodeActionBar
        visible={!!selected && !data.locked && !parentGroupSelected && !multiSelected && !readOnly}
        hasContent={artifact?.kind === "gltf"}
        isSaving={isSaving}
        onDelete={handleDelete}
        onSave={artifact?.kind === "gltf" ? () => { void saveGlb(); } : undefined}
        onDuplicate={handleDuplicate}
      />
      <span className="node-above-label">{label}</span>
      {showInputProblem && !data.locked && <MissingInputWarning messages={[inputCheck.reason]} />}

      <Handle
        type="target"
        position={Position.Left}
        id={need}
        style={{ top: "50%" }}
        title={need === "prompt" ? "Character concept (text)" : `${KIND_NOUN[need]} input`}
        className={`node-handle-icon ${need === "prompt" ? "node-handle-icon-prompt" : `node-handle-icon-game node-handle-icon-game-in-${need}`}${targetConnected ? " node-handle-connected" : ""}${showInputProblem && data.hasError ? " node-handle-error" : ""}`}
      >
        <InputIcon size={13} strokeWidth={1.8} />
      </Handle>
      {outHandle && (
        <Handle
          type="source"
          position={Position.Right}
          id={outHandle}
          style={{ top: "50%" }}
          data-game-kind={step}
          title={`${KIND_NOUN[step]} output`}
          className={`node-handle-icon node-handle-icon-game node-handle-icon-out-game${sourceConnected ? " node-handle-connected" : ""}`}
        >
          <OutputIcon size={13} strokeWidth={1.8} />
        </Handle>
      )}

      {/* ── Preview ── */}
      <div className="relative aspect-square w-full overflow-hidden rounded-t-[inherit] bg-mat">
        {jobRunning ? (
          <GeneratingSlot startedAt={data.jobStartedAt} label="Running" model={NODE_LABELS[type]} />
        ) : artifact?.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local /generated files
          <img src={artifact.previewUrl} alt={`${KIND_NOUN[step]} preview`} className={`absolute inset-0 size-full object-contain${outOfDate ? " opacity-40" : ""}`} draggable={false} />
        ) : status === "error" && !artifact ? (
          <JobErrorSlot
            message={data.errorMsg ?? jobErrorCopy(undefined)}
            onRetry={readOnly ? undefined : () => { void run(); }}
            retryDisabled={!inputCheck.ok}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center pointer-events-none select-none">
            <span className="text-[12.5px] text-ink-3">The {KIND_NOUN[step]} will appear here.</span>
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
            {artifact.kind === "gltf" && (
              <a
                href={artifact.glbUrl}
                download={glbName}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); void saveGlb(); }}
                onMouseDown={(e) => e.stopPropagation()}
                className="nodrag inline-flex items-center gap-1.5 self-start text-[12px] text-lapis hover:underline underline-offset-4"
              >
                <Download className="size-3" strokeWidth={2} />
                {isSaving ? "Saving…" : glbName}
              </a>
            )}
          </div>
        )}

        {outOfDate && upstream && artifactIsCurrent(upstream.id, nodes, edges) && (
          <p className="text-[11.5px] leading-snug text-ochre">
            Out of date: the {upstream.data.label ?? NODE_LABELS[upstream.type as GameNodeType]} changed since this ran. Run again to update it.
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
            {step === "gltf" && (
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
