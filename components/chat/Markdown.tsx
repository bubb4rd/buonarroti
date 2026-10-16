import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A deliberately small Markdown subset for assistant replies: paragraphs,
 * headings (rendered as bold lines), bullet and numbered lists, fenced code
 * blocks, and inline **bold**, *italic*, `code`. Output is plain React
 * elements, so model text is never injected as HTML.
 */

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "ul" | "ol"; items: string[]; start: number }
  | { kind: "code"; text: string };

const FENCE = /^\s*```/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join("\n") });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE.test(line)) {
      flushPara();
      const code: string[] = [];
      i++;
      // An unclosed fence (mid-stream) runs to the end.
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }

    if (!line.trim()) {
      flushPara();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ kind: "h", text: heading[1] });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      flushPara();
      const kind = bullet ? "ul" : "ol";
      const prev = blocks[blocks.length - 1];
      const item = bullet ? bullet[1] : numbered![2];
      if (prev && prev.kind === kind) prev.items.push(item);
      else blocks.push({ kind, items: [item], start: numbered ? Number(numbered[1]) : 1 });
      continue;
    }

    // Indented continuation of a list item.
    const prev = blocks[blocks.length - 1];
    if (!para.length && prev && (prev.kind === "ul" || prev.kind === "ol") && /^\s{2,}/.test(line)) {
      prev.items[prev.items.length - 1] += `\n${line.trim()}`;
      continue;
    }

    para.push(line);
  }
  flushPara();
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(\*[^*\s][^*\n]*?\*|_[^_\s][^_\n]*?_)/g;

function renderInline(text: string, keyPrefix = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) out.push(...withBreaks(text.slice(last, start), `${keyPrefix}t${n}`));
    const [token, code, bold] = match;
    const key = `${keyPrefix}m${n++}`;
    if (code) {
      out.push(
        <code key={key} className="rounded-[var(--radius-xs)] bg-wash-strong px-1 py-px font-mono text-[0.86em] text-ink">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (bold) {
      out.push(<strong key={key} className="font-semibold text-ink">{renderInline(token.slice(2, -2), `${key}-`)}</strong>);
    } else {
      out.push(<em key={key}>{renderInline(token.slice(1, -1), `${key}-`)}</em>);
    }
    last = start + token.length;
  }
  if (last < text.length) out.push(...withBreaks(text.slice(last), `${keyPrefix}t${n}`));
  return out;
}

function withBreaks(text: string, key: string): ReactNode[] {
  return text.split("\n").map((part, i) => (
    <Fragment key={`${key}-${i}`}>
      {i > 0 && <br />}
      {part}
    </Fragment>
  ));
}

/** Plain text for use as a generation prompt: emphasis, code marks and fences removed. */
export function toPlainText(source: string): string {
  return source
    .replace(/^\s*```.*$/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|[\s(])[*_](\S[^*_\n]*?)[*_](?=[\s).,;:!?]|$)/gm, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `trailing` (e.g. a streaming caret) renders inline at the end of the last block. */
export function Markdown({ text, className, trailing }: { text: string; className?: string; trailing?: ReactNode }) {
  const blocks = parseBlocks(text);
  const lastIdx = blocks.length - 1;
  return (
    <div className={cn("flex flex-col gap-3 break-words", className)}>
      {blocks.map((b, i) => {
        const tail = i === lastIdx ? trailing : null;
        switch (b.kind) {
          case "p":
            return <p key={i}>{renderInline(b.text)}{tail}</p>;
          case "h":
            return <p key={i} className="font-semibold text-ink">{renderInline(b.text)}{tail}</p>;
          case "code":
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded-[var(--radius)] bg-paper-sunk px-3.5 py-3 font-mono text-[12.5px] leading-[1.55] text-ink shadow-[inset_0_0_0_1px_var(--rule)]"
              >
                <code>{b.text}</code>
                {tail}
              </pre>
            );
          case "ul":
            return (
              <ul key={i} className="flex list-disc flex-col gap-1 pl-5 marker:text-ink-3">
                {b.items.map((item, j) => <li key={j}>{renderInline(item)}{j === b.items.length - 1 && tail}</li>)}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} start={b.start} className="flex list-decimal flex-col gap-1 pl-5 marker:text-ink-3 marker:tabular-nums">
                {b.items.map((item, j) => <li key={j}>{renderInline(item)}{j === b.items.length - 1 && tail}</li>)}
              </ol>
            );
        }
      })}
    </div>
  );
}
