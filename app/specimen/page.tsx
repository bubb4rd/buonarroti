"use client";

import { useState } from "react";
import { Check, Download, ImageIcon, Plus, Sparkles, Video, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Input, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { Mark, Wordmark } from "@/components/brand/Mark";
import { setThemePreference, useTheme, type ThemePreference } from "@/lib/theme";

const SWATCHES = [
  ["paper", "--paper"],
  ["paper-sunk", "--paper-sunk"],
  ["surface", "--surface"],
  ["surface-raised", "--surface-raised"],
  ["mat", "--mat"],
  ["ink", "--ink"],
  ["ink-2", "--ink-2"],
  ["ink-3", "--ink-3"],
  ["ink-4", "--ink-4"],
  ["lapis", "--lapis"],
  ["sanguine", "--sanguine"],
  ["verdigris", "--verdigris"],
  ["ochre", "--ochre"],
  ["gilt", "--gilt"],
] as const;

function SectionHeader({ title, meta }: { title: string; meta?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="type-heading text-ink">{title}</h2>
      {meta && <div className="text-[12.5px] text-ink-3">{meta}</div>}
    </div>
  );
}

export default function SpecimenPage() {
  const { preference } = useTheme();
  const [range, setRange] = useState<"all" | "30" | "7">("all");
  const [kind, setKind] = useState<"image" | "video">("image");
  const [on, setOn] = useState(true);

  return (
    <div className="h-full overflow-y-auto">
      <div className="fresco paper-grain">
        <div className="mx-auto flex max-w-[1080px] items-end justify-between gap-8 px-12 pt-16 pb-10">
          <div>
            <div className="mb-5 flex items-center gap-2.5 text-ink">
              <Mark className="size-7" />
              <Wordmark className="text-[22px]" />
            </div>
            <h1 className="type-display text-ink">What shall we make, Bo?</h1>
            <p className="mt-3 max-w-[46ch] text-[14.5px] leading-relaxed text-ink-2">
              The Paper &amp; Ink specimen. Every token and primitive used across Buonarroti, live in the current theme.
            </p>
          </div>
          <Segmented<ThemePreference>
            aria-label="Theme"
            value={preference}
            onChange={setThemePreference}
            options={[
              { value: "paper", label: "Paper" },
              { value: "ink", label: "Ink" },
              { value: "system", label: "System" },
            ]}
          />
        </div>
      </div>

      <div className="mx-auto grid max-w-[1080px] gap-12 px-12 pt-6 pb-24">
        {/* Colour */}
        <section>
          <SectionHeader title="Pigments" meta="14 tokens · Paper & Ink" />
          <div className="grid grid-cols-7 gap-3">
            {SWATCHES.map(([name, v]) => (
              <div key={name} className="overflow-hidden rounded-[var(--radius)] bg-surface shadow-[var(--shadow-sm)]">
                <div className="h-14" style={{ background: `var(${v})` }} />
                <div className="px-2.5 py-2 text-[11.5px] text-ink-2">{name}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Type */}
        <section>
          <SectionHeader title="Type" meta="Newsreader · System sans · SF Mono" />
          <div className="grid gap-4 rounded-[var(--radius-lg)] bg-surface p-7 shadow-[var(--shadow-sm)]">
            <div className="type-display">The marble already holds the figure.</div>
            <div className="type-title">Software for making beautiful things</div>
            <div className="type-heading">Recent generations</div>
            <p className="max-w-[62ch] text-[14px] leading-relaxed text-ink-2">
              Body copy is set in the system sans at 13–14px. It does the work: labels, controls, descriptions and
              everything you read while making.
            </p>
            <div className="flex items-baseline gap-6">
              <span className="type-figure text-[44px] leading-none">87<span className="text-[22px] text-ink-3">%</span></span>
              <span className="type-label">Figures are serif, tabular and lining.</span>
              <span className="type-eyebrow">Eyebrow · use once</span>
              <code className="font-mono text-[12px] text-ink-2">{"{ aspect: \"3:4\" }"}</code>
            </div>
          </div>
        </section>

        {/* Controls */}
        <section>
          <SectionHeader title="Controls" meta="Buttons carry their shortcut" />
          <div className="flex flex-wrap items-center gap-2.5">
            <Button variant="primary">
              <Sparkles /> Generate <Kbd>⌘↵</Kbd>
            </Button>
            <Button variant="ink">
              <Download /> Export <Kbd>E</Kbd>
            </Button>
            <Button>
              <Plus /> New workflow <Kbd>N</Kbd>
            </Button>
            <Button variant="ghost">
              <Wand2 /> Improve prompt
            </Button>
            <Button variant="danger">Delete</Button>
            <Button variant="link">See all</Button>
            <Button size="icon" variant="ghost" aria-label="Image">
              <ImageIcon />
            </Button>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <Segmented
              aria-label="Range"
              value={range}
              onChange={setRange}
              options={[
                { value: "all", label: "All" },
                { value: "30", label: "30 days" },
                { value: "7", label: "7 days" },
              ]}
            />
            <Segmented
              aria-label="Kind"
              value={kind}
              onChange={setKind}
              options={[
                { value: "image", label: "Images", icon: <ImageIcon /> },
                { value: "video", label: "Video", icon: <Video /> },
              ]}
            />
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              <Switch checked={on} onCheckedChange={setOn} /> JSON prompt
            </label>
            <Input placeholder="Name this piece" className="w-56" />
          </div>
        </section>

        {/* Composer */}
        <section>
          <SectionHeader title="Composer" />
          <div className="rounded-[var(--radius-xl)] bg-surface-raised shadow-[var(--shadow-md)]">
            <Textarea
              placeholder="Describe the scene you imagine…"
              className="min-h-24 border-0 bg-transparent px-5 pt-4 text-[15px] shadow-none hover:border-0 focus-visible:shadow-none"
            />
            <div className="flex items-center gap-1.5 px-3 pb-3">
              <Button variant="ghost" size="sm">Nano Banana Pro</Button>
              <Button variant="ghost" size="sm">3:4</Button>
              <Button variant="ghost" size="sm">2K</Button>
              <div className="ml-auto flex items-center gap-3">
                <span className="text-[12px] text-ink-3 tabular-nums">0 / 5,000</span>
                <Button variant="primary">
                  Generate <Kbd>⌘↵</Kbd>
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* Cards */}
        <section className="grid grid-cols-[1.4fr_1fr] gap-8">
          <div>
            <SectionHeader title="Activity" meta="This month" />
            <div className="rounded-[var(--radius-lg)] bg-surface p-6 shadow-[var(--shadow-sm)]">
              <div className="grid grid-cols-3 gap-x-6 gap-y-5">
                {[
                  ["Images", "128"],
                  ["Videos", "14"],
                  ["Workflows", "6"],
                  ["Credits spent", "2,410"],
                  ["Avg. time", "38s"],
                  ["Kept", "71%"],
                ].map(([l, v]) => (
                  <div key={l} className="border-b border-rule pb-3">
                    <div className="type-label">{l}</div>
                    <div className="type-figure mt-1 text-[24px] text-ink">{v}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div>
            <SectionHeader title="In the studio" meta="2 running" />
            <div className="divide-y divide-rule overflow-hidden rounded-[var(--radius-lg)] bg-surface shadow-[var(--shadow-sm)]">
              {[
                { t: "Marble atrium at dawn", m: "Nano Banana Pro · 3:4", s: "done" },
                { t: "Sibyl reading, slow push-in", m: "Veo 3.1 · 8s", s: "running" },
                { t: "Bronze study of hands", m: "Seedream 5 · 1:1", s: "failed" },
              ].map((r) => (
                <div key={r.t} className="flex items-center gap-3 px-4 py-3">
                  <div className="size-9 shrink-0 rounded-[var(--radius-sm)] bg-mat" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] text-ink">{r.t}</div>
                    <div className="truncate text-[12px] text-ink-3">{r.m}</div>
                  </div>
                  {r.s === "done" && (
                    <span className="inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11.5px] text-verdigris bg-verdigris/10">
                      <Check className="size-3" /> Done
                    </span>
                  )}
                  {r.s === "running" && (
                    <span className="inline-flex h-5 items-center gap-1.5 rounded-full bg-wash px-2 text-[11.5px] text-ink-2">
                      <span className="size-1.5 animate-pulse rounded-full bg-ink-2" /> 0:42
                    </span>
                  )}
                  {r.s === "failed" && (
                    <span className="inline-flex h-5 items-center gap-1 rounded-full bg-sanguine/10 px-2 text-[11.5px] text-sanguine">
                      Failed · Retry
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Artwork */}
        <section>
          <SectionHeader title="Framing" meta="Crop marks · ink shimmer" />
          <div className="grid grid-cols-[1.6fr_1fr] items-start gap-12 px-2">
            <figure className="crop-marks">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/art/the-touch.webp"
                alt="The hands from Michelangelo's Creation of Adam"
                className="block aspect-[16/9] w-full object-cover"
              />
              <figcaption className="mt-4 flex justify-between text-[12px] text-ink-3">
                <span className="font-serif text-[14px] italic text-ink-2">The Creation of Adam, c. 1512</span>
                <span>Sistine Chapel · public domain</span>
              </figcaption>
            </figure>
            <div className="grid gap-3">
              <div className="ink-shimmer aspect-[4/5] rounded-[var(--radius-sm)]" />
              <div className="flex justify-between text-[12px] text-ink-3 tabular-nums">
                <span>Nano Banana Pro</span>
                <span>0:12</span>
              </div>
            </div>
          </div>
        </section>

        {/* Chips + dialog */}
        <section>
          <SectionHeader title="Chips & dialogs" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-7 items-center gap-1 rounded-full px-3 text-[12.5px] text-ink-2 shadow-[inset_0_0_0_1px_var(--rule-strong)]">
              <Check className="size-3.5 text-verdigris" /> chiaroscuro
            </span>
            <span className="inline-flex h-7 items-center rounded-full bg-lapis-soft px-3 text-[12.5px] text-lapis">fresco</span>
            <span className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-ink/25 px-3 text-[12.5px] text-ink-2">
              <Plus className="size-3.5" /> golden hour
            </span>
            <span className="text-[13px] text-ink-2">
              A <span className="highlight">marble</span> figure, lit from the <span className="highlight">left</span>.
            </span>
            <Dialog>
              <DialogTrigger render={<Button className="ml-auto" />}>Open dialog</DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete this workflow?</DialogTitle>
                  <DialogDescription>
                    “Sibyl studies” and its 24 generations will be removed from this Mac. This can’t be undone.
                  </DialogDescription>
                </DialogHeader>
                <div className="h-4" />
                <DialogFooter>
                  <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                  <Button variant="ink" className="bg-sanguine hover:bg-sanguine/90">
                    Delete <Kbd>⌫</Kbd>
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </section>
      </div>
    </div>
  );
}
