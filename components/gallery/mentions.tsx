import React from "react";
import { thumbSrc } from "@/lib/galleryUtils";
import type { RefImage, TaggedImage } from "./types";

/**
 * @-mentions of attached references, prompt syntax highlighting (JSON/YAML)
 * and the tag bookkeeping that keeps `@imageN` labels consistent when
 * references are removed or reordered.
 */

type MentionHandlers = {
  onEnter: (tag: TaggedImage, rect: DOMRect) => void;
  onLeave: () => void;
  /** Mouse-down on a chip; `chip` is the chip element (to find its textarea). */
  onMouseDown: (tag: TaggedImage, chip: HTMLElement) => void;
};

/** Syntax colours for JSON/YAML prompts — pigments, so they read in both themes. */
const SYNTAX = {
  key: "var(--lapis)",
  string: "var(--verdigris)",
  number: "var(--ochre)",
  literal: "var(--sanguine)",
  punct: "var(--ink-3)",
  comment: "var(--ink-4)",
  plain: "var(--ink)",
} as const;

const MENTION_CLASS =
  "pointer-events-auto cursor-text select-none rounded-[3px] bg-lapis-soft font-medium text-lapis shadow-[0_0_0_2px_var(--lapis-soft)]";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces `@label` mentions with positional `<<<image N>>>` (or `@imageN ` for Grok) markers. */
export function resolveGalleryMentions(
  text: string,
  tagged: TaggedImage[],
  tagFormat: "default" | "grok" = "default",
): { resolvedPrompt: string; extraUrls: string[]; extraAssets: { url: string; kind: "image" | "video" | "audio" }[] } {
  if (!tagged.length) return { resolvedPrompt: text, extraUrls: [], extraAssets: [] };
  type Span = { start: number; end: number; url: string; kind: "image" | "video" | "audio" };
  const spans: Span[] = [];
  const claimed = new Set<number>();
  for (const t of [...tagged].sort((a, b) => b.label.length - a.label.length)) {
    const re = new RegExp(`@${escapeRe(t.label)}(?!\\w)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!claimed.has(m.index)) {
        spans.push({ start: m.index, end: m.index + m[0].length, url: t.url, kind: t.kind || "image" });
        claimed.add(m.index);
      }
    }
  }
  spans.sort((a, b) => a.start - b.start);
  if (!spans.length) return { resolvedPrompt: text, extraUrls: [], extraAssets: [] };
  const extraUrls: string[] = [];
  const extraAssets: { url: string; kind: "image" | "video" | "audio" }[] = [];
  const seenUrlIndex = new Map<string, number>(); // url → 1-based slot already assigned
  let resolvedPrompt = "";
  let lastEnd = 0;
  let n = 1;
  for (const span of spans) {
    resolvedPrompt += text.slice(lastEnd, span.start);
    let slot = seenUrlIndex.get(span.url);
    if (slot === undefined) {
      slot = n++;
      seenUrlIndex.set(span.url, slot);
      extraUrls.push(span.url);
      extraAssets.push({ url: span.url, kind: span.kind });
    }
    resolvedPrompt += tagFormat === "grok" ? `@image${slot} ` : `<<<image ${slot}>>>`;
    lastEnd = span.end;
  }
  resolvedPrompt += text.slice(lastEnd);
  return { resolvedPrompt, extraUrls, extraAssets };
}

function splitByMentions(
  text: string,
  baseColor: string | undefined,
  tagged: TaggedImage[],
  keyStart: number,
  h: MentionHandlers,
): { nodes: React.ReactNode[]; nextKey: number } {
  const style = baseColor ? { color: baseColor } : undefined;
  if (!tagged.length) return { nodes: [<span key={keyStart} style={style}>{text}</span>], nextKey: keyStart + 1 };
  const sorted = [...tagged].sort((a, b) => b.label.length - a.label.length);
  const nodes: React.ReactNode[] = [];
  let k = keyStart;
  let rest = text;
  while (rest.length > 0) {
    let earliest: { idx: number; tag: TaggedImage } | null = null;
    for (const tag of sorted) {
      const idx = rest.indexOf(`@${tag.label}`);
      if (idx !== -1 && (earliest === null || idx < earliest.idx)) earliest = { idx, tag };
    }
    if (!earliest) { nodes.push(<span key={k++} style={style}>{rest}</span>); break; }
    if (earliest.idx > 0) nodes.push(<span key={k++} style={style}>{rest.slice(0, earliest.idx)}</span>);
    const tag = earliest.tag;
    nodes.push(
      <span
        key={k++}
        className={MENTION_CLASS}
        onMouseEnter={e => h.onEnter(tag, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={h.onLeave}
        onMouseDown={e => { e.preventDefault(); h.onMouseDown(tag, e.currentTarget); }}
      >
        @{tag.label}
      </span>,
    );
    rest = rest.slice(earliest.idx + tag.label.length + 1);
  }
  return { nodes, nextKey: k };
}

/** Plain-text prompt with @mentions rendered as lapis chips (the textarea overlay). */
export function renderGalleryMentions(text: string, tagged: TaggedImage[], h: MentionHandlers): React.ReactNode {
  if (!text) return null;
  return <>{splitByMentions(text, undefined, tagged, 0, h).nodes}</>;
}

export function syntaxHighlightJson(json: string, tagged?: TaggedImage[], h?: MentionHandlers): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let k = 0;
  const push = (from: number, to: number, color?: string) => {
    if (from >= to) return;
    const text = json.slice(from, to);
    if (tagged?.length && h) {
      const { nodes, nextKey } = splitByMentions(text, color, tagged, k, h);
      parts.push(...nodes);
      k = nextKey;
    } else {
      parts.push(<span key={k++} style={color ? { color } : undefined}>{text}</span>);
    }
  };
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}\[\],])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json)) !== null) {
    push(last, m.index);
    if (m[1] !== undefined) {
      if (m[2] !== undefined) {
        push(m.index, m.index + m[1].length, SYNTAX.key);
        push(m.index + m[1].length, m.index + m[0].length, SYNTAX.punct);
      } else {
        push(m.index, m.index + m[1].length, SYNTAX.string);
      }
    } else if (m[3] !== undefined) {
      push(m.index, m.index + m[3].length, SYNTAX.number);
    } else if (m[4] !== undefined) {
      push(m.index, m.index + m[4].length, SYNTAX.literal);
    } else if (m[5] !== undefined) {
      push(m.index, m.index + m[5].length, SYNTAX.punct);
    }
    last = re.lastIndex;
  }
  push(last, json.length);
  return <>{parts}</>;
}

export function syntaxHighlightYaml(yaml: string, tagged?: TaggedImage[], h?: MentionHandlers): React.ReactNode {
  const lines = yaml.split("\n");
  const parts: React.ReactNode[] = [];
  let k = 0;
  lines.forEach((line, i) => {
    if (/^---/.test(line) || /^\.\.\.$/.test(line)) {
      parts.push(<span key={k++} style={{ color: SYNTAX.punct }}>{line}</span>);
    } else {
      const keyMatch = line.match(/^(\s*(?:-\s+)?)([\w\-./]+)(\s*:)(.*)/);
      if (keyMatch) {
        const [, indent, key, colon, rest] = keyMatch;
        parts.push(<span key={k++}>{indent}</span>);
        parts.push(<span key={k++} style={{ color: SYNTAX.key }}>{key}</span>);
        parts.push(<span key={k++} style={{ color: SYNTAX.punct }}>{colon}</span>);
        parts.push(<span key={k++}>{colorYamlValue(rest, k, tagged, h)}</span>);
        k++;
      } else {
        const listMatch = line.match(/^(\s*-\s+)(.*)/);
        if (listMatch) {
          parts.push(<span key={k++} style={{ color: SYNTAX.punct }}>{listMatch[1]}</span>);
          parts.push(<span key={k++}>{colorYamlValue(listMatch[2], k, tagged, h)}</span>);
          k++;
        } else if (tagged?.length && h) {
          const { nodes, nextKey } = splitByMentions(line, undefined, tagged, k, h);
          parts.push(...nodes);
          k = nextKey;
        } else {
          parts.push(<span key={k++}>{line}</span>);
        }
      }
    }
    if (i < lines.length - 1) parts.push(<span key={k++}>{"\n"}</span>);
  });
  return <>{parts}</>;
}

function colorYamlValue(value: string, baseKey: number, tagged?: TaggedImage[], h?: MentionHandlers): React.ReactNode {
  const commentIdx = value.search(/#/);
  const main = commentIdx >= 0 ? value.slice(0, commentIdx) : value;
  const comment = commentIdx >= 0 ? value.slice(commentIdx) : "";
  let k = baseKey * 100;
  const out: React.ReactNode[] = [];
  const trimmed = main.trim();

  const pushValue = (text: string, color?: string) => {
    if (tagged?.length && h) {
      const { nodes, nextKey } = splitByMentions(text, color, tagged, k, h);
      out.push(...nodes);
      k = nextKey;
    } else {
      out.push(<span key={k++} style={color ? { color } : undefined}>{text}</span>);
    }
  };

  if (/^(true|false|yes|no|on|off|null|~)$/i.test(trimmed)) pushValue(main, SYNTAX.literal);
  else if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed) || /^0x[\da-fA-F]+$/.test(trimmed)) pushValue(main, SYNTAX.number);
  else if (/^['"]/.test(trimmed)) pushValue(main, SYNTAX.string);
  else if (trimmed !== "") pushValue(main, SYNTAX.plain);
  else pushValue(main);
  if (comment) out.push(<span key={k++} style={{ color: SYNTAX.comment }}>{comment}</span>);
  return <>{out}</>;
}

/** Stored prompt with `<<<image N>>>` markers rendered as small reference chips. */
export function renderStoredPrompt(text: string, refUrls: string[] | undefined): React.ReactNode {
  if (!refUrls?.length) return text;
  const parts: React.ReactNode[] = [];
  let lastEnd = 0;
  let key = 0;
  const re = /<<<image (\d+)>>>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastEnd) parts.push(<span key={key++}>{text.slice(lastEnd, m.index)}</span>);
    const n = parseInt(m[1]);
    const imgUrl = refUrls[n - 1];
    parts.push(
      <span
        key={key++}
        className="mx-px inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-wash-strong py-px pr-1.5 pl-0.5 align-middle text-[12px] leading-5 font-medium text-ink"
      >
        {imgUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbSrc(imgUrl, 20)} alt="" className="size-5 shrink-0 rounded-[var(--radius-xs)] object-cover" />
        )}
        Image {n}
      </span>,
    );
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < text.length) parts.push(<span key={key++}>{text.slice(lastEnd)}</span>);
  return <>{parts}</>;
}

// ── Tag bookkeeping ───────────────────────────────────────────────────────────

/** Removes the tag for a deleted reference and renumbers higher `@prefixN` labels. */
export function removeTagAndRenumber(
  removedRefId: string,
  removedUrl: string | null,
  currentTaggedImages: TaggedImage[],
  currentPrompt: string,
): { newTaggedImages: TaggedImage[]; newPrompt: string } {
  const removedTag = currentTaggedImages.find(
    t => t.refId === removedRefId || (removedUrl != null && t.url === removedUrl),
  );
  if (!removedTag) return { newTaggedImages: currentTaggedImages, newPrompt: currentPrompt };

  const m = removedTag.label.match(/^([^\d]*)(\d+)$/);
  if (!m) {
    return {
      newTaggedImages: currentTaggedImages.filter(t => t !== removedTag),
      newPrompt: currentPrompt.replace(new RegExp(`@${removedTag.label}\\b`, "g"), ""),
    };
  }

  const prefix = m[1];
  const removedN = parseInt(m[2]);
  const newTaggedImages = currentTaggedImages
    .filter(t => t !== removedTag)
    .map(t => {
      const tm = t.label.match(/^([^\d]*)(\d+)$/);
      if (!tm || tm[1] !== prefix) return t;
      const n = parseInt(tm[2]);
      return n > removedN ? { ...t, label: `${prefix}${n - 1}` } : t;
    });

  // Remove the deleted tag, then renumber higher ones ascending
  // (ascending avoids collisions: @image2→@image1 before @image3→@image2).
  let newPrompt = currentPrompt.replace(new RegExp(`@${prefix}${removedN}\\b`, "g"), "");
  const higherNs = currentTaggedImages
    .filter(t => t !== removedTag)
    .flatMap(t => { const tm = t.label.match(/^([^\d]*)(\d+)$/); return tm && tm[1] === prefix && parseInt(tm[2]) > removedN ? [parseInt(tm[2])] : []; })
    .sort((a, b) => a - b);
  for (const n of higherNs) {
    newPrompt = newPrompt.replace(new RegExp(`@${prefix}${n}\\b`, "g"), `@${prefix}${n - 1}`);
  }
  return { newTaggedImages, newPrompt };
}

/** Preview order while a reference is being dragged over another. */
export function getDisplayOrder(arr: RefImage[], draggingId: string | null, overId: string | null): RefImage[] {
  if (!draggingId || !overId || draggingId === overId) return arr;
  const dragIdx = arr.findIndex(r => r.id === draggingId);
  const overIdx = arr.findIndex(r => r.id === overId);
  if (dragIdx === -1 || overIdx === -1) return arr;
  const next = [...arr];
  const [moved] = next.splice(dragIdx, 1);
  next.splice(overIdx, 0, moved);
  return next;
}

/**
 * `@imageN` is positional: after a reorder the label stays and the URL behind
 * it changes, so resolved `<<<image N>>>` markers follow the new order.
 */
export function reorderTags(newArr: RefImage[], prefix: string, currentTaggedImages: TaggedImage[]): TaggedImage[] {
  const labelToRef = new Map<string, RefImage>();
  newArr.forEach((r, i) => labelToRef.set(`${prefix}${i + 1}`, r));
  let changed = false;
  const next = currentTaggedImages.map(t => {
    const ref = labelToRef.get(t.label);
    if (!ref || ref.id === t.refId) return t;
    changed = true;
    return { ...t, refId: ref.id, url: ref.cdnUrl ?? ref.objectUrl };
  });
  return changed ? next : currentTaggedImages;
}

/** Re-attaches `<<<image N>>>`/`@imageN` markers from a stored prompt as tags. */
export function unresolvePrompt(text: string, refUrls: string[] | undefined): { text: string; tagged: TaggedImage[] } {
  const tagged: TaggedImage[] = [];
  if (!refUrls?.length) return { text, tagged };
  const out = text.replace(/<<<image (\d+)>>>|@image(\d+)/gi, (match, g1, g2) => {
    const n = parseInt(g1 || g2);
    const url = refUrls[n - 1];
    if (!url) return match;
    const label = `image${n}`;
    if (!tagged.some(t => t.label === label)) tagged.push({ label, refId: url, url });
    return `@${label}`;
  });
  return { text: out, tagged };
}
