"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useShallow } from "zustand/react/shallow";
import { useWorkflowStore } from "@/lib/store";
import { workflowActivity } from "@/lib/workflowActivity";
import { markTabSeen, resumePending, usePendingGenerations } from "@/components/gallery/generationStore";
import { isEmptySession, useChatSessionStore, type ChatSession } from "@/lib/chatSessionStore";
import { useFolderStore, type Folder as FolderT } from "@/lib/folderStore";
import {
  Workflow,
  Image as ImageIcon,
  Clapperboard,
  MessageSquare,
  Settings,
  MoreHorizontal,
  Trash2,
  Folder,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  ChevronRight,
  SquarePen,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { Mark, Wordmark } from "@/components/brand/Mark";
import { AgentBrandIcon, ProviderBrandIcon } from "@/components/settings/primitives";
import { AGENT_IDS } from "@/lib/agentModels";
import { useAgents } from "@/lib/useAgents";

const KIE_TOP_UP_URL = "https://kie.ai?ref=25abb3f2236cbff9780ab9c2f84479ec";

// ── Module-level drag tracker (avoids stale closures across re-renders) ──────
let _dragFolderId: string | null = null;

/**
 * Folder colours are user data, not chrome: a muted pigment set that reads on
 * both Paper and Ink (DESIGN.md § Categorical colours).
 */
const FOLDER_COLORS: { color: string | null; label: string }[] = [
  { color: null, label: "None" },
  { color: "#2d4db0", label: "Lapis" },
  { color: "#b0442a", label: "Sanguine" },
  { color: "#3b7a5a", label: "Verdigris" },
  { color: "#a8741f", label: "Ochre" },
  { color: "#7a5a3a", label: "Umber" },
  { color: "#5b6b7a", label: "Slate" },
  { color: "#a4506a", label: "Rose madder" },
  { color: "#6a5a9a", label: "Violet" },
];

/** Colours saved by the old palette, shown as their nearest pigment. */
const LEGACY_FOLDER_COLORS: Record<string, string> = {
  "#3b82f6": "#2d4db0", // blue → lapis
  "#2dd4bf": "#5b6b7a", // cyan → slate
  "#a855f7": "#6a5a9a", // purple → violet
  "#ec4899": "#a4506a", // pink → rose madder
  "#ef4444": "#b0442a", // red → sanguine
  "#f97316": "#7a5a3a", // orange → umber
  "#eab308": "#a8741f", // yellow → ochre
  "#22c55e": "#3b7a5a", // green → verdigris
};

function folderColor(c: string | null | undefined): string | null {
  if (!c) return null;
  return LEGACY_FOLDER_COLORS[c.toLowerCase()] ?? c;
}

// ── Clean failed pending generations from localStorage + notify gallery page ──
function cleanFailedJobs(folderId: string | null) {
  try {
    const stored = localStorage.getItem("aiui-pending-gens");
    if (stored) {
      const parsed = JSON.parse(stored) as Array<{ error?: string; folderId?: string | null }>;
      const cleaned = parsed.filter(pg => {
        if (!pg.error) return true;
        if (folderId === null) return false;
        return pg.folderId !== folderId;
      });
      localStorage.setItem("aiui-pending-gens", JSON.stringify(cleaned));
    }
  } catch {}
  window.dispatchEvent(new CustomEvent("clean-failed-jobs", { detail: { folderId } }));
}

function relTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Shared row styles ─────────────────────────────────────────────────────────
const rowBase =
  "group/row flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] text-left select-none transition-colors duration-150";
const rowState = (active: boolean) =>
  active ? "bg-wash-strong text-ink" : "text-ink-2 hover:bg-wash hover:text-ink";

/** A small icon action that appears on row hover (⋯, delete). */
const rowAction =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-[var(--radius-xs)] text-ink-3 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 hover:bg-wash-strong hover:text-ink focus-visible:opacity-100";

/** Running: an ink dot breathing. Unseen: a still lapis dot. */
function ActivityDot({ generating, unseen }: { generating?: boolean; unseen?: boolean }) {
  if (generating) {
    return <span aria-label="Generating" className="size-1.5 shrink-0 animate-pulse rounded-full bg-ink-2" />;
  }
  if (unseen) {
    return <span aria-label="New" className="size-1.5 shrink-0 rounded-full bg-lapis" />;
  }
  return null;
}

// ── Floating row menu (fixed-position to escape overflow clipping) ───────────
function useRowMenu() {
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!pos) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setPos(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPos(null);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pos]);

  const openAtButton = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ x: r.left, y: r.bottom + 4 });
  };
  const openAtPointer = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPos({ x: e.clientX, y: e.clientY });
  };
  return { pos, menuRef, openAtButton, openAtPointer, close: () => setPos(null) };
}

function RowMenu({
  pos,
  menuRef,
  children,
}: {
  pos: { x: number; y: number };
  menuRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={menuRef}
      role="menu"
      onMouseDown={e => e.preventDefault()}
      style={{ left: Math.min(pos.x, window.innerWidth - 200), top: Math.min(pos.y, window.innerHeight - 180) }}
      className="fixed z-[9999] min-w-[184px] rounded-[var(--radius)] bg-surface-raised p-1 text-ink shadow-[var(--shadow-lg)] animate-in fade-in-0 zoom-in-[0.98] duration-150"
    >
      {children}
    </div>
  );
}

function MenuItem({
  onClick,
  danger,
  children,
}: {
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex h-7 w-full items-center rounded-[var(--radius-sm)] px-2 text-left text-[13px] transition-colors duration-100",
        danger ? "text-sanguine hover:bg-sanguine/10" : "text-ink hover:bg-wash-strong",
      )}
    >
      {children}
    </button>
  );
}

// ── FolderRow — module level so React never remounts it on parent re-renders ──
interface FolderRowProps {
  folder: FolderT;
  allFolders: FolderT[];
  depth: number;
  expandedIds: Set<string>;
  selectedFolderId: string | null;
  onToggleExpand: (id: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onColorChange: (id: string, color: string | null) => void;
  onMove: (id: string, newParentId: string | null, newOrderIndex: number) => void;
  creatingInFolderId: string | null;
  newFolderName: string;
  onNameChange: (v: string) => void;
  onNameKeyDown: (e: React.KeyboardEvent) => void;
  onNameBlur: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  getCount: (id: string) => number;
  generatingFolderIds: string[];
  unseenFolderIds: string[];
}

const nameInputCls =
  "min-w-0 flex-1 rounded-[var(--radius-xs)] bg-surface-raised px-1.5 py-0.5 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--rule-strong)] outline-none placeholder:text-ink-4 focus:shadow-[inset_0_0_0_1px_var(--lapis),var(--focus-ring)]";

const FolderRow = React.memo(function FolderRow({
  folder, allFolders, depth, expandedIds, selectedFolderId,
  onToggleExpand, onSelect, onDelete, onRename, onColorChange, onMove,
  creatingInFolderId, newFolderName, onNameChange, onNameKeyDown, onNameBlur, inputRef,
  getCount, generatingFolderIds, unseenFolderIds,
}: FolderRowProps) {
  const [drop, setDrop] = React.useState<"before" | "after" | "inside" | null>(null);
  const [isRenaming, setIsRenaming] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState("");
  const menu = useRowMenu();
  const renameInputRef = React.useRef<HTMLInputElement>(null);

  // Focus rename input once it mounts
  React.useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  function startRename() {
    menu.close();
    setRenameValue(folder.name);
    setIsRenaming(true);
  }

  function confirmRename() {
    const name = renameValue.trim();
    if (name && name !== folder.name) onRename(folder.id, name);
    setIsRenaming(false);
  }

  const children = allFolders
    .filter(f => f.parentId === folder.id)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const hasChildren = children.length > 0;
  const isCreatingHere = creatingInFolderId === folder.id;
  const isExpanded = expandedIds.has(folder.id);
  const isActive = selectedFolderId === folder.id;
  const color = folderColor(folder.color);
  const count = getCount(folder.id);

  function getPos(e: React.DragEvent<HTMLDivElement>): "before" | "after" | "inside" {
    const { top, height } = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientY - top) / height;
    return pct < 0.3 ? "before" : pct > 0.7 ? "after" : "inside";
  }

  const isGenerating = generatingFolderIds.includes(folder.id);
  const hasUnseen = unseenFolderIds.includes(folder.id);

  const sharedChildProps = {
    allFolders, expandedIds, selectedFolderId,
    onToggleExpand, onSelect, onDelete, onRename, onColorChange, onMove,
    creatingInFolderId, newFolderName, onNameChange, onNameKeyDown, onNameBlur, inputRef,
    getCount, generatingFolderIds, unseenFolderIds,
  };

  const indent = { paddingLeft: `${6 + depth * 14}px` };
  const FolderGlyph = isActive ? FolderOpen : Folder;

  return (
    <React.Fragment>
      {drop === "before" && <div className="pointer-events-none mx-2 h-px rounded-full bg-lapis" />}
      <div
        draggable={!isRenaming}
        onDragStart={e => {
          _dragFolderId = folder.id;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", folder.id);
        }}
        onDragOver={e => {
          e.preventDefault();
          e.stopPropagation();
          if (_dragFolderId === folder.id) return;
          setDrop(getPos(e));
        }}
        onDragLeave={e => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
        }}
        onDrop={e => {
          e.preventDefault();
          e.stopPropagation();
          const dragged = _dragFolderId;
          setDrop(null);
          _dragFolderId = null;
          if (!dragged || dragged === folder.id) return;
          const pos = getPos(e);
          if (pos === "inside") {
            const sibs = allFolders.filter(f => f.parentId === folder.id).sort((a, b) => a.orderIndex - b.orderIndex);
            onMove(dragged, folder.id, sibs.length > 0 ? Math.max(...sibs.map(f => f.orderIndex)) + 1 : 0);
          } else {
            const sibs = allFolders.filter(f => f.parentId === folder.parentId && f.id !== dragged).sort((a, b) => a.orderIndex - b.orderIndex);
            const idx = sibs.findIndex(f => f.id === folder.id);
            onMove(dragged, folder.parentId, pos === "before" ? idx : idx + 1);
          }
        }}
        onDragEnd={() => { _dragFolderId = null; setDrop(null); }}
        onClick={() => !isRenaming && onSelect(folder.id)}
        onContextMenu={menu.openAtPointer}
        style={indent}
        className={cn(
          rowBase, rowState(isActive),
          "h-7 cursor-pointer pr-1.5 text-[13px]",
          drop === "inside" && "shadow-[inset_0_0_0_1px_var(--lapis)] bg-lapis-soft",
        )}
      >
        {/* Expand toggle */}
        <button
          onClick={e => { e.stopPropagation(); onToggleExpand(folder.id); }}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          tabIndex={hasChildren || isCreatingHere ? 0 : -1}
          className={cn(
            "-mr-1 inline-flex size-3.5 shrink-0 items-center justify-center text-ink-3 hover:text-ink",
            hasChildren || isCreatingHere ? "" : "pointer-events-none opacity-0",
          )}
        >
          <ChevronRight
            className={cn("size-3 transition-transform duration-150", isExpanded && "rotate-90")}
            strokeWidth={2}
          />
        </button>

        <FolderGlyph
          className={cn("size-[15px] shrink-0", !color && (isActive ? "text-ink-2" : "text-ink-3"))}
          style={color ? { color } : undefined}
          strokeWidth={1.75}
        />

        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); confirmRename(); }
              if (e.key === "Escape") { e.stopPropagation(); setIsRenaming(false); }
            }}
            onBlur={confirmRename}
            onClick={e => e.stopPropagation()}
            aria-label="Folder name"
            className={nameInputCls}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate leading-tight">{folder.name}</span>
        )}

        {!isRenaming && <ActivityDot generating={isGenerating} unseen={hasUnseen} />}
        {!isRenaming && count > 0 && (
          <span className="shrink-0 text-[11.5px] tabular-nums text-ink-3 group-hover/row:hidden">{count}</span>
        )}
        {!isRenaming && (
          <button onClick={menu.openAtButton} aria-label={`${folder.name} options`} className={rowAction}>
            <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
          </button>
        )}
      </div>

      {menu.pos && (
        <RowMenu pos={menu.pos} menuRef={menu.menuRef}>
          <div className="type-label px-2 pt-1.5 pb-1">Colour</div>
          <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
            {FOLDER_COLORS.map(({ color: c, label }) => {
              const selected = c === null ? !color : color === c;
              return (
                <button
                  key={label}
                  title={label}
                  aria-label={label}
                  aria-pressed={selected}
                  onClick={e => { e.stopPropagation(); menu.close(); onColorChange(folder.id, c); }}
                  style={c ? { background: c } : undefined}
                  className={cn(
                    "relative size-4 shrink-0 rounded-full transition-transform duration-100 hover:scale-110",
                    c === null && "bg-wash-strong shadow-[inset_0_0_0_1px_var(--rule-strong)]",
                    selected && "shadow-[0_0_0_2px_var(--surface-raised),0_0_0_3.5px_var(--ink-2)]",
                  )}
                >
                  {c === null && (
                    <svg viewBox="0 0 16 16" className="absolute inset-0 size-4 text-ink-3" aria-hidden>
                      <line x1="4.5" y1="11.5" x2="11.5" y2="4.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
          <div className="-mx-1 my-1 h-px bg-rule" />
          <MenuItem onClick={e => { e.stopPropagation(); startRename(); }}>Rename</MenuItem>
          <MenuItem onClick={e => { e.stopPropagation(); menu.close(); cleanFailedJobs(folder.id); }}>Clear failed jobs</MenuItem>
          <div className="-mx-1 my-1 h-px bg-rule" />
          <MenuItem danger onClick={e => { e.stopPropagation(); menu.close(); onDelete(folder.id); }}>Delete folder</MenuItem>
        </RowMenu>
      )}

      {drop === "after" && <div className="pointer-events-none mx-2 h-px rounded-full bg-lapis" />}
      {isExpanded && (hasChildren || isCreatingHere) && (
        <>
          {children.map(child => (
            <FolderRow key={child.id} folder={child} depth={depth + 1} {...sharedChildProps} />
          ))}
          {isCreatingHere && (
            <div className="flex h-7 items-center gap-2.5 pr-1.5" style={{ paddingLeft: `${6 + (depth + 1) * 14 + 14}px` }}>
              <Folder className="size-[15px] shrink-0 text-ink-3" strokeWidth={1.75} />
              <input
                ref={inputRef}
                value={newFolderName}
                onChange={e => onNameChange(e.target.value)}
                onKeyDown={onNameKeyDown}
                onBlur={onNameBlur}
                placeholder="Folder name"
                aria-label="New folder name"
                className={nameInputCls}
              />
            </div>
          )}
        </>
      )}
    </React.Fragment>
  );
});

// ── AllAssetsRow — "All assets" with its own menu ────────────────────────────
const AllAssetsRow = React.memo(function AllAssetsRow({
  isActive, count, onSelect, isGenerating, hasUnseen,
}: {
  isActive: boolean;
  count: number;
  onSelect: () => void;
  isGenerating?: boolean;
  hasUnseen?: boolean;
}) {
  const menu = useRowMenu();
  return (
    <React.Fragment>
      <div
        onClick={onSelect}
        onContextMenu={menu.openAtPointer}
        className={cn(rowBase, rowState(isActive), "h-7 cursor-pointer pr-1.5 pl-[22px] text-[13px]")}
      >
        <LayoutGrid className={cn("size-[15px] shrink-0", isActive ? "text-ink-2" : "text-ink-3")} strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate leading-tight">All assets</span>
        <ActivityDot generating={isGenerating} unseen={hasUnseen} />
        {count > 0 && (
          <span className="shrink-0 text-[11.5px] tabular-nums text-ink-3 group-hover/row:hidden">{count}</span>
        )}
        <button onClick={menu.openAtButton} aria-label="All assets options" className={rowAction}>
          <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      {menu.pos && (
        <RowMenu pos={menu.pos} menuRef={menu.menuRef}>
          <MenuItem onClick={e => { e.stopPropagation(); menu.close(); cleanFailedJobs(null); }}>Clear failed jobs</MenuItem>
        </RowMenu>
      )}
    </React.Fragment>
  );
});

// ── Nav-row activity: what is generating, and what needs the user ────────────
interface NavActivity {
  generating: number;
  attention: number;
  /** Results arrived while the user was elsewhere. */
  fresh?: boolean;
  /** What the counts count, for the summary ("2 workflows generating"). */
  noun: string;
}

type ActivityTone = "attention" | "generating" | "fresh";

/** One tone per row: what needs the user outranks what is still running. */
function activityTone(a: NavActivity | undefined): ActivityTone | null {
  if (!a) return null;
  if (a.attention) return "attention";
  if (a.generating) return "generating";
  return a.fresh ? "fresh" : null;
}

function activitySummary(a: NavActivity | undefined): string | null {
  if (!a) return null;
  const n = (count: number) => `${count} ${a.noun}${count === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (a.generating) parts.push(`${n(a.generating)} generating`);
  if (a.attention) parts.push(`${n(a.attention)} ${a.attention === 1 ? "needs" : "need"} attention`);
  if (a.fresh) parts.push("new results");
  return parts.length ? parts.join(" · ") : null;
}

const TONE_LABEL: Record<ActivityTone, string> = { attention: "Needs attention", generating: "Generating", fresh: "New" };
const TONE_TEXT: Record<ActivityTone, string> = { attention: "text-sanguine", generating: "text-ink-3", fresh: "text-lapis" };
const TONE_DOT: Record<ActivityTone, string> = { attention: "bg-sanguine", generating: "animate-pulse bg-ink-2", fresh: "bg-lapis" };

/** `useSyncExternalStore` subscribe for a value that never changes after hydration. */
const noopSubscribe = () => () => {};
const NO_IDS: string[] = [];

// ── Primary nav row: full row when expanded, a tooltip'd square when collapsed ──
function NavRow({
  label,
  icon: Icon,
  href,
  active,
  onClick,
  hint,
  activity,
}: {
  label: string;
  icon: LucideIcon;
  href?: string;
  active?: boolean;
  onClick?: () => void;
  hint?: React.ReactNode;
  activity?: NavActivity;
}) {
  const { state, isMobile } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;
  const tone = activityTone(activity);
  const summary = activitySummary(activity);
  const cls = cn(
    rowBase, rowState(!!active),
    "relative h-[30px] px-2 text-[13.5px]",
    "group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-9 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0",
  );
  const body = (
    <>
      <Icon className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="flex-1 truncate group-data-[collapsible=icon]:hidden">{label}</span>
      {tone && (
        <>
          {/* Expanded: dot and word. Collapsed: the dot alone, on the icon's corner. */}
          <span
            aria-hidden
            title={summary ?? undefined}
            className={cn("flex shrink-0 items-center gap-1.5 text-[11.5px] group-data-[collapsible=icon]:hidden", TONE_TEXT[tone])}
          >
            <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
            {TONE_LABEL[tone]}
          </span>
          <span
            aria-hidden
            className={cn("absolute top-1.5 right-1.5 hidden size-1.5 rounded-full group-data-[collapsible=icon]:block", TONE_DOT[tone])}
          />
          <span className="sr-only">({summary})</span>
        </>
      )}
      {hint && <span className="group-data-[collapsible=icon]:hidden">{hint}</span>}
    </>
  );
  const name = collapsed ? (summary ? `${label}, ${summary}` : label) : undefined;
  const el = href
    ? <Link href={href} aria-current={active ? "page" : undefined} aria-label={name} className={cls}>{body}</Link>
    : <button type="button" onClick={onClick} aria-label={name} className={cls}>{body}</button>;

  if (!collapsed) return el;
  return (
    <Tooltip>
      <TooltipTrigger render={el} />
      <TooltipContent side="right">
        {label}
        {summary && <span className="opacity-70"> · {summary}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function SectionHeader({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between pr-1 pl-2">
      <span className="text-[11.5px] text-ink-3">{label}</span>
      {action}
    </div>
  );
}

const sectionAction =
  "inline-flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-ink-3 transition-colors duration-150 hover:bg-wash-strong hover:text-ink";

// ── Connections: signed-in subscriptions and keys, then kie.ai credits ───────
function ConnectionsStatus({ balance, onOpenSettings }: { balance: number | null; onOpenSettings: () => void }) {
  const kieKeySet = useWorkflowStore((s) => s.kieKeySet);
  const azureKeySet = useWorkflowStore((s) => s.azureKeySet);
  const { agents } = useAgents();
  const { state, isMobile } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;

  const connected = [
    ...AGENT_IDS.flatMap((id) => {
      const agent = agents.find((a) => a.id === id && a.status === "ready");
      return agent ? [{ key: id, name: agent.name, icon: <AgentBrandIcon id={id} size={13} /> }] : [];
    }),
    ...(azureKeySet === true ? [{ key: "azure", name: "Azure Foundry", icon: <ProviderBrandIcon id="azure" size={13} /> }] : []),
  ];

  const kieConnected = kieKeySet === true;
  const kieText =
    kieKeySet === false ? "Add your key"
    : kieKeySet === null ? "Checking"
    : balance !== null ? `${balance.toLocaleString()} credits`
    : "Connected";
  const text = [...connected.map((c) => c.name), `kie.ai · ${kieText.toLowerCase()}`].join(" · ");

  const line = (
    <button
      type="button"
      onClick={onOpenSettings}
      aria-label={text}
      className={cn(
        "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[12px] text-ink-3 transition-colors duration-150 hover:bg-wash hover:text-ink-2",
        "group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-9 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0",
      )}
    >
      {connected.length > 0 && (
        <>
          <span aria-hidden className="flex shrink-0 items-center gap-1.5 group-data-[collapsible=icon]:hidden">
            {connected.map((c) => (
              <span key={c.key} title={c.name} className="flex">{c.icon}</span>
            ))}
          </span>
          <span aria-hidden className="h-3 w-px shrink-0 bg-rule group-data-[collapsible=icon]:hidden" />
        </>
      )}
      <span
        aria-hidden
        title="kie.ai"
        className={cn("flex shrink-0", kieKeySet === false ? "text-ochre" : kieConnected ? undefined : "text-ink-4")}
      >
        <ProviderBrandIcon id="kie" size={14} />
      </span>
      <span aria-hidden className="truncate tabular-nums group-data-[collapsible=icon]:hidden">{kieText}</span>
    </button>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger render={line} />
        <TooltipContent side="right">{text}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <div className="group/status flex items-center gap-1">
      {line}
      {kieConnected && (
        <a
          href={KIE_TOP_UP_URL}
          target="_blank"
          rel="noreferrer"
          className="hidden shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[11.5px] text-ink-3 group-focus-within/status:block group-hover/status:block hover:text-lapis"
        >
          Top up
        </a>
      )}
    </div>
  );
}

// ── Sidebar component ─────────────────────────────────────────────────────────
export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") ?? "images";
  const activeChatId = searchParams.get("id");

  const [balance, setBalance] = React.useState<number | null>(null);

  const setSettingsOpen   = useWorkflowStore((s) => s.setSettingsOpen);
  const setKieKeySet      = useWorkflowStore((s) => s.setKieKeySet);
  const setAzureKeySet    = useWorkflowStore((s) => s.setAzureKeySet);

  React.useEffect(() => {
    fetch("/api/settings/kie-key")
      .then((r) => r.json())
      .then((d) => setKieKeySet(!!d.hasToken))
      .catch(() => setKieKeySet(null));
    fetch("/api/settings/azure-key")
      .then((r) => r.json())
      .then((d) => setAzureKeySet(!!d.hasToken))
      .catch(() => setAzureKeySet(null));
  }, [setKieKeySet, setAzureKeySet]);

  React.useEffect(() => {
    const fetchBalance = async () => {
      try {
        const res = await fetch("/api/credit");
        if (!res.ok) return;
        const data = await res.json();
        const val = typeof data?.data === "number"
          ? data.data
          : (data?.data?.balance ?? data?.balance ?? null);
        setBalance(val);
      } catch { /* the status line falls back to "connected" */ }
    };
    fetchBalance();
    const id = setInterval(fetchBalance, 60_000);
    window.addEventListener("credits-refresh", fetchBalance);
    return () => { clearInterval(id); window.removeEventListener("credits-refresh", fetchBalance); };
  }, []);

  // ⌘, opens Settings (the macOS convention).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "," && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        // With no kie.ai key yet, ⌘, (the banner's hint) goes straight to API keys.
        setSettingsOpen(true, useWorkflowStore.getState().kieKeySet === false ? "api-keys" : undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSettingsOpen]);

  const sessions = useChatSessionStore((s) => s.sessions);
  const deleteSession = useChatSessionStore((s) => s.deleteSession);

  // Recent: sessions with messages or an unsent draft, newest first.
  const recent = React.useMemo(
    () =>
      sessions
        .filter((s: ChatSession) => !isEmptySession(s))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  const {
    folders, selectedFolderId,
    createFolder, deleteFolder, selectFolder,
    updateFolder, moveFolder, folderItemCount,
    galleryImageCount, galleryVideoCount,
    loadFromServer, generatingFolderIds, unseenFolderIds,
    generatingAllAssets, unseenAllAssets,
  } = useFolderStore();
  const [creatingFolder, setCreatingFolder] = React.useState(false);
  const [newFolderName, setNewFolderName] = React.useState("");
  const newFolderInputRef = React.useRef<HTMLInputElement>(null);
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    loadFromServer();
  }, [loadFromServer]);

  // Gallery generations run at module scope: pick up any that were in flight
  // before a reload, whichever page opened first, so the nav status is live.
  React.useEffect(() => {
    resumePending();
  }, []);

  React.useEffect(() => {
    if (pathname === "/gallery") markTabSeen(tab === "videos" ? "videos" : "images");
  }, [pathname, tab]);

  // Activity comes from localStorage, which the server render can't see: show it
  // only after hydration so the first client render matches the server HTML.
  const hydrated = React.useSyncExternalStore(noopSubscribe, () => true, () => false);

  // Workflows count once each, however many of their nodes are busy or failed.
  const workflows = useWorkflowStore(useShallow((s) => {
    let generating = 0;
    let attention = 0;
    for (const sp of s.spaces) {
      const a = workflowActivity(sp.nodes);
      if (a.generating) generating++;
      if (a.attention) attention++;
    }
    return { generating, attention };
  }));

  const gallery = usePendingGenerations(useShallow((s) => {
    const c = { images: 0, imagesFailed: 0, videos: 0, videosFailed: 0 };
    for (const pg of s.pending) {
      if (pg.tab === "videos") {
        if (pg.error) c.videosFailed++;
        else c.videos++;
      } else if (pg.error) c.imagesFailed++;
      else c.images++;
    }
    return { ...c, unseenImages: s.unseenTabs.includes("images"), unseenVideos: s.unseenTabs.includes("videos") };
  }));

  function handleDeleteChat(id: string, isActive: boolean) {
    deleteSession(id);
    if (isActive) {
      const next = recent.find(s => s.id !== id);
      router.push(next ? `/chat?id=${next.id}` : "/chat");
    }
  }

  function handleCreateFolder() {
    setCreatingFolder(true);
    setNewFolderName("");
    // Auto-expand parent folder so the inline input is visible
    if (selectedFolderId) {
      setExpandedIds(prev => new Set([...prev, selectedFolderId]));
    }
    setTimeout(() => newFolderInputRef.current?.focus(), 50);
  }

  function confirmCreateFolder() {
    const name = newFolderName.trim();
    if (name) {
      // If a folder is currently selected, create subfolder under it
      createFolder(name, selectedFolderId ?? null);
    }
    setCreatingFolder(false);
    setNewFolderName("");
  }

  function handleFolderKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") confirmCreateFolder();
    if (e.key === "Escape") { setCreatingFolder(false); setNewFolderName(""); }
  }

  const rootFolders = folders
    .filter((f) => f.parentId === null)
    .sort((a, b) => a.orderIndex - b.orderIndex);

  const handleToggleExpand = React.useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const handleRename = React.useCallback((id: string, name: string) => updateFolder(id, { name }), [updateFolder]);
  const handleColor = React.useCallback((id: string, color: string | null) => updateFolder(id, { color }), [updateFolder]);

  const folderParam = selectedFolderId ? `&folder=${selectedFolderId}` : "";
  const navItems: { label: string; href: string; icon: LucideIcon; active: boolean; activity?: NavActivity }[] = [
    {
      label: "Images", href: `/gallery?tab=images${folderParam}`, icon: ImageIcon, active: pathname === "/gallery" && tab === "images",
      activity: hydrated ? { generating: gallery.images, attention: gallery.imagesFailed, fresh: gallery.unseenImages, noun: "image" } : undefined,
    },
    {
      label: "Video", href: `/gallery?tab=videos${folderParam}`, icon: Clapperboard, active: pathname === "/gallery" && tab === "videos",
      activity: hydrated ? { generating: gallery.videos, attention: gallery.videosFailed, fresh: gallery.unseenVideos, noun: "video" } : undefined,
    },
    {
      label: "Workflows", href: "/workflow", icon: Workflow, active: pathname === "/workflow" || pathname.startsWith("/workflow/"),
      activity: hydrated ? { ...workflows, noun: "workflow" } : undefined,
    },
    { label: "Chat", href: "/chat", icon: MessageSquare, active: pathname === "/chat" },
  ];

  return (
    <Sidebar collapsible="icon" className="border-0">

      {/* ── Header: traffic-light inset (desktop) + mark ── */}
      <SidebarHeader data-tauri-drag-region className="titlebar-drag gap-0 p-0">
        <div aria-hidden data-tauri-drag-region className="h-[var(--titlebar-h)] shrink-0" />
        <div
          data-tauri-drag-region
          className="flex h-12 items-center justify-between pr-2 pl-4 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <div className="pointer-events-none flex items-center gap-2 text-ink group-data-[collapsible=icon]:hidden">
            <Mark className="size-[22px]" />
            <Wordmark className="text-[18px]" />
          </div>
          {/* Collapsed: the mark yields to the toggle on hover */}
          <div className="group/logo relative hidden size-9 items-center justify-center group-data-[collapsible=icon]:flex">
            <Mark className="pointer-events-none size-[22px] text-ink transition-opacity duration-150 group-hover/logo:opacity-0" />
            <SidebarTrigger className="absolute inset-0 size-9 text-ink-2 opacity-0 transition-opacity duration-150 group-hover/logo:opacity-100 focus-visible:opacity-100" />
          </div>
          <Tooltip>
            <TooltipTrigger
              render={<SidebarTrigger className="text-ink-3 hover:text-ink group-data-[collapsible=icon]:hidden" />}
            />
            <TooltipContent side="bottom">
              Hide sidebar <Kbd>⌘B</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      </SidebarHeader>

      {/* ── Nav + folders + recent ── */}
      <SidebarContent className="gap-0">
        <nav className="flex shrink-0 flex-col gap-px px-2 pt-1 pb-3">
          {navItems.map((item) => (
            <NavRow key={item.label} {...item} />
          ))}
        </nav>

        {/* Folders */}
        <section className="flex shrink-0 flex-col px-2 pb-3 group-data-[collapsible=icon]:hidden">
          <SectionHeader
            label="Folders"
            action={
              <button onClick={handleCreateFolder} title="New folder" aria-label="New folder" className={sectionAction}>
                <FolderPlus className="size-3.5" strokeWidth={1.75} />
              </button>
            }
          />
          <div className="flex max-h-[calc(8*28px)] flex-col gap-px overflow-y-auto">
            <AllAssetsRow
              isActive={selectedFolderId === null}
              count={pathname === "/gallery" ? (tab === "videos" ? galleryVideoCount : galleryImageCount) : 0}
              onSelect={() => selectFolder(null)}
              isGenerating={hydrated && generatingAllAssets}
              hasUnseen={hydrated && unseenAllAssets}
            />

            {/* Recursive tree — root folders here, children rendered inside FolderRow */}
            {rootFolders.map((folder) => (
              <FolderRow
                key={folder.id}
                folder={folder}
                allFolders={folders}
                depth={0}
                expandedIds={expandedIds}
                selectedFolderId={selectedFolderId}
                onToggleExpand={handleToggleExpand}
                onSelect={selectFolder}
                onDelete={deleteFolder}
                onRename={handleRename}
                onColorChange={handleColor}
                onMove={moveFolder}
                creatingInFolderId={creatingFolder ? selectedFolderId : null}
                newFolderName={newFolderName}
                onNameChange={setNewFolderName}
                onNameKeyDown={handleFolderKeyDown}
                onNameBlur={confirmCreateFolder}
                inputRef={newFolderInputRef}
                getCount={folderItemCount}
                generatingFolderIds={hydrated ? generatingFolderIds : NO_IDS}
                unseenFolderIds={hydrated ? unseenFolderIds : NO_IDS}
              />
            ))}

            {/* Root-level new folder input — when no folder is selected */}
            {creatingFolder && selectedFolderId === null && (
              <div className="flex h-7 items-center gap-2.5 pr-1.5 pl-[22px]">
                <Folder className="size-[15px] shrink-0 text-ink-3" strokeWidth={1.75} />
                <input
                  ref={newFolderInputRef}
                  value={newFolderName}
                  onChange={e => setNewFolderName(e.target.value)}
                  onKeyDown={handleFolderKeyDown}
                  onBlur={confirmCreateFolder}
                  placeholder="Folder name"
                  aria-label="New folder name"
                  className={nameInputCls}
                />
              </div>
            )}
          </div>
        </section>

        {/* Recent chats */}
        <section className="flex min-h-0 flex-1 flex-col px-2 pb-2 group-data-[collapsible=icon]:hidden">
          <SectionHeader
            label="Recent"
            action={
              <Link href="/chat" title="New chat" aria-label="New chat" className={sectionAction}>
                <SquarePen className="size-3.5" strokeWidth={1.75} />
              </Link>
            }
          />
          <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
            {recent.length === 0 ? (
              <p className="px-2 py-1.5 text-[12.5px] text-ink-4">Your conversations will gather here.</p>
            ) : recent.map(sess => (
              <RecentRow
                key={sess.id}
                session={sess}
                active={pathname === "/chat" && sess.id === activeChatId}
                onDelete={handleDeleteChat}
              />
            ))}
          </div>
        </section>
      </SidebarContent>

      {/* ── Footer: settings, status ── */}
      <SidebarFooter className="gap-px px-2 pt-2 pb-3">
        <NavRow label="Settings" icon={Settings} onClick={() => setSettingsOpen(true)} hint={<Kbd>⌘,</Kbd>} />
        <div className="mx-2 my-1.5 h-px bg-rule group-data-[collapsible=icon]:mx-3" />
        <ConnectionsStatus balance={balance} onOpenSettings={() => setSettingsOpen(true, "api-keys")} />
      </SidebarFooter>

    </Sidebar>
  );
}

const RecentRow = React.memo(function RecentRow({
  session,
  active,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onDelete: (id: string, isActive: boolean) => void;
}) {
  const isDraft = session.messages.length === 0;
  return (
    <Link
      href={`/chat?id=${session.id}`}
      aria-current={active ? "page" : undefined}
      className={cn(rowBase, rowState(active), "h-7 pr-1 pl-2 text-[13px]")}
    >
      <span className={cn("min-w-0 flex-1 truncate leading-tight", isDraft && !active && "text-ink-3")}>{session.title}</span>
      {isDraft && (
        <span className="inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-[11px] text-ink-3 shadow-[inset_0_0_0_1px_var(--rule-strong)]">
          Draft
        </span>
      )}
      <span className="shrink-0 text-[11.5px] tabular-nums text-ink-4 group-hover/row:hidden">
        {relTime(session.updatedAt)}
      </span>
      <button
        onClick={e => { e.preventDefault(); e.stopPropagation(); onDelete(session.id, active); }}
        aria-label="Delete chat"
        title="Delete chat"
        className={cn(rowAction, "hidden group-hover/row:inline-flex hover:bg-sanguine/10 hover:text-sanguine")}
      >
        <Trash2 className="size-3.5" strokeWidth={1.75} />
      </button>
    </Link>
  );
});
