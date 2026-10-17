# Buonarroti — Paper & Ink

Buonarroti is named for Michelangelo. The interface is a quiet studio: warm paper, ink type, one precious pigment. The user's work supplies the colour. The chrome does not.

Tokens live in `app/globals.css`. Primitives live in `components/ui/`. A live specimen of both is served at `/specimen`. If something here conflicts with code, the code is wrong.

## Principles

1. **Paper, not glass.** Surfaces are opaque sheets with hairline edges and warm, low shadows. Avoid glassmorphism, neon glows and gradient borders.
2. **Ink carries hierarchy.** Use four ink strengths (`ink`, `ink-2`, `ink-3`, `ink-4`) before reaching for size or colour.
3. **One pigment.** Lapis (`--lapis`, ultramarine) marks the single primary action and the active or selected state. Everything else is ink.
4. **Serif speaks, sans works.** Newsreader (serif) sets page titles, section titles, figures, empty-state headlines and dialog titles. The system sans sets every control, label and body line.
5. **Artwork is framed.** Generated media sits on `--mat` and is framed by crop marks (`.crop-marks`), the registration corners of a print studio.
6. **Calm motion.** Use 120–200ms with `--ease-out`. Don't use springs that bounce. `prefers-reduced-motion` is honoured globally.
7. **Never lose work.** Drafts, in-flight generations and unsent prompts persist across navigation and reloads. "Premium" includes the guarantee.

## Colour tokens

| Token | Paper (light) | Ink (dark) | Use |
|---|---|---|---|
| `--paper` | `#f5f2eb` | `#161513` | App ground, content area |
| `--paper-sunk` | `#ece8de` | `#11100e` | Sidebar, recessed wells, window chrome |
| `--surface` | `#fbfaf6` | `#1d1b18` | Cards, panels, nodes |
| `--surface-raised` | `#fffefb` | `#24221e` | Popovers, menus, dialogs, inputs |
| `--ink` | `#1e1c19` | `#ede8dd` | Primary text, ink buttons |
| `--ink-2` | `#57524a` | `#b4ad9f` | Secondary text |
| `--ink-3` | `#8a8478` | `#807a6f` | Meta, labels, icons at rest |
| `--ink-4` | `#b5ae9f` | `#57524b` | Placeholder, disabled |
| `--rule` / `--rule-strong` | ink 10% / 17% | ink 9% / 16% | Hairlines, input borders |
| `--wash` / `--wash-strong` | ink 4.5% / 8% | ink 5% / 9% | Hover / selected fills |
| `--lapis` | `#2d4db0` | `#8ea6f0` | Primary action, focus, selection |
| `--sanguine` | `#b0442a` | `#e07a5f` | Danger, errors (red chalk) |
| `--verdigris` | `#3b7a5a` | `#6fb38f` | Success, "done" |
| `--ochre` | `#a8741f` | `#d9a650` | Warning, queued / pending |
| `--gilt` | `#a08442` | `#c9ad6e` | Rare flourish: credits |
| `--mat` | `#e6e1d5` | `#0e0d0c` | Behind media, empty media slots |
| `--scrim` | warm 32% | black 55% | Modal backdrop |

Every pigment has an `--x-rgb` channel twin (`--ink-rgb`, `--lapis-rgb`, `--sanguine-rgb`, `--verdigris-rgb`, `--ochre-rgb`, `--paper-rgb`, `--surface-rgb`) for alpha: `rgb(var(--lapis-rgb) / 0.12)`.

**Tailwind:** every token is a utility. Examples are `bg-paper`, `bg-surface`, `text-ink-2`, `border-rule`, `bg-wash`, `text-lapis`, `bg-lapis-soft`, `text-sanguine` and `bg-mat`. Opacity modifiers work too, as in `bg-ink/10`. The `dark:` variant targets the Ink theme.

### Converting the inherited dark UI

The fork's UI was dark-only, with inline hex and rgba values. Convert as follows. Never re-introduce raw colours.

| Old | New |
|---|---|
| `#0B0E14`, `#0C0F16`, `#000`, `bg-black` (grounds) | `var(--paper)` |
| `#131720`, `#141820`, `#16181f`, `#0F1214` (cards, panels) | `var(--surface)` |
| `#0D1119` (input fills), glass `rgba(14,16,18,.9x)` panels | `var(--surface-raised)` plus `var(--shadow-lg)` |
| `#1A2030`, `#1C2436`, `#1E2840`, `#2A2A2A` (borders) | `var(--rule)` or `var(--rule-strong)` |
| `#fff`, `#FFFFFF`, `white`, `text-white` (text) | `var(--ink)` / `text-ink` |
| `#A0A0A0`, `text-white/60..80` | `var(--ink-2)` |
| `#6A7080`, `text-white/30..50` | `var(--ink-3)` |
| `#3A4055`, `text-white/10..25` | `var(--ink-4)` |
| `rgba(255,255,255,≤.06)` fills | `var(--wash)` |
| `rgba(255,255,255,.07–.14)` fills | `var(--wash-strong)` |
| `rgba(255,255,255,.06–.15)` borders | `var(--rule)` / `var(--rule-strong)` |
| Any other `rgba(255,255,255,a)` | `rgb(var(--ink-rgb) / a)` |
| `rgba(0,0,0,a)` backdrops | `var(--scrim)` |
| `rgba(0,0,0,a)` shadows | `var(--shadow-sm|md|lg)` |
| Teal `#2DD4BF`, `#5EEAD4`, `#0D9488`, `rgba(45,212,191,a)` | `var(--lapis)`, `rgb(var(--lapis-rgb) / a)` |
| Reds (`#ef4444`, `red-*`, `rgba(239,68,68,a)`) | `--sanguine` |
| Greens (`#34d399`, `#4ade80`, `emerald-*`) | `--verdigris` |
| Ambers (`#f59e0b`, `amber-*`, `yellow-*`) | `--ochre` |
| Text on a teal button | `var(--lapis-ink)` |
| `onMouseEnter` / `onMouseLeave` style mutation | Tailwind `hover:` classes |

**One exception.** Controls drawn on top of media (lightbox chrome, video scrubbers, badges over thumbnails) may use literal `rgb(0 0 0 / a)` and white, because they sit on the artwork, not on paper. Use the `.on-media` pattern: `bg-black/45 text-white backdrop-blur-md`.

**Categorical colours.** These are user data, not chrome: folder colours, group colours, node-type accents. Remap them to a muted pigment set that reads on both paper and ink: lapis `#2d4db0`, sanguine `#b0442a`, verdigris `#3b7a5a`, ochre `#a8741f`, umber `#7a5a3a`, slate `#5b6b7a`, rose madder `#a4506a`, violet `#6a5a9a`.

## Typography

| Class | Face | Size / line | Use |
|---|---|---|---|
| `.type-display` | Newsreader 400, opsz 60 | clamp(30–44px) / 1.08 | Page greeting: "What shall we make, Bo?" |
| `.type-title` | Newsreader 400, opsz 36 | 26 / 1.15 | Page titles, dialog titles (22px) |
| `.type-heading` | Newsreader 450, opsz 20 | 19 / 1.25 | Section titles: "Activity", "Recent" |
| `.type-figure` | Newsreader, tabular lining | any | Stats, percentages, counts shown large |
| body | System sans | 13–14 / 1.45 | UI text |
| `.type-label` | System sans | 11.5, ink-3 | Field labels, meta |
| `.type-eyebrow` | System sans 600, caps 0.09em | 10.5 | Rare. Use at most once per view. |
| `font-mono` | SF Mono | 12 | JSON/YAML, ids, technical values |

Rules:
- Use sentence case everywhere. Don't uppercase-track labels; the old `.node-label` uppercase style is gone.
- Serif never goes on buttons, inputs, menus or tables.
- Numbers in tables and meta are `tabular-nums`.
- Geist, Geist Mono and Doto are removed. `--font-geist-*` and `--font-doto` no longer exist.

## Space, radius, elevation

- **Spacing:** 4px base. Common steps are 4, 6, 8, 12, 16, 20, 24, 32, 48. Page gutters are 32–48px. Sections are separated by 40–56px in-app (this is an app, not a landing page).
- **Radius:** `--radius-xs` 4 (kbd), `--radius-sm` 6 (icon buttons), `--radius` 9 (buttons, inputs), `--radius-lg` 13 (cards, content inset), `--radius-xl` 18 (dialogs, composer).
- **Elevation:** shadows include the hairline ring, so do **not** add `border` to an element that uses a shadow token.
  - `--shadow-sm`: cards, outline buttons, raised segmented tab.
  - `--shadow-md`: floating toolbars, the composer, hovered cards.
  - `--shadow-lg`: menus, popovers, dialogs, toasts.

## Layout shell

- The window ground is `--paper-sunk`. The sidebar sits directly on it with no border.
- The content area is a `--paper` sheet inset 8px from the top, right and bottom, with radius `--radius-lg` and `--shadow-sm`. This is set in `app/layout.tsx`.
- On desktop (Tauri, macOS) the title bar is an overlay. The sidebar header leaves 28px (`--titlebar-h`) for the traffic lights. Top strips that should drag the window get the `.titlebar-drag` class.

### Sidebar

- Primary nav rows are 30px tall, 13.5px ink-2, with a 16px lucide icon (`strokeWidth 1.75`). The active row is `bg-wash-strong text-ink`. Counts are right-aligned in ink-3 `tabular-nums`.
- Section labels ("Folders", "Recent") are 11.5px ink-3, sentence case.
- The footer holds secondary nav (Settings) and a status line: a 6px dot (verdigris when connected, ochre when there is no key) plus 12px ink-3 text such as "kie.ai · connected · 1,240 credits".

### Page anatomy

- **Header:** a serif `.type-display` or `.type-title` on the left. Actions sit top-right: an outline button, then at most one primary button, each with a `<Kbd>` hint.
- **Section header:** `.type-heading` on the left, meta in 12.5px ink-3 plus an optional "See all" ghost link on the right, 12px above the content.
- **Cards:** `bg-surface rounded-[var(--radius-lg)] shadow-[var(--shadow-sm)]`. Lists inside cards are separated by `border-rule` hairlines. Rows are 52–64px.

## Components (`components/ui/`)

| Primitive | Notes |
|---|---|
| `Button` | Variants: `primary` (lapis, one per view), `ink`, `outline` (default), `ghost`, `danger`, `link`. Sizes: `sm`, `default`, `lg`, `icon`, `icon-sm`, `icon-lg`. A `<Kbd>` child sits at the right edge and inverts itself on filled buttons. |
| `GenerateButton` (`generate-button.tsx`) | The one generative action, never `Button variant="primary"`. Ground ultramarine (`--generate-top` → `--generate-bottom`) with paper type in both themes, the *tre cerchi* as its glyph. Says what it makes (`outcome`: "4 images", "video"); disabled is a neutral wash with `blockedReason` as a tooltip; `busy` reads "Generating". Sizes: `default` (h-9, composer) and `sm` (h-7, nodes). |
| `Kbd`, `KbdGroup` | Shortcut hints. Use them generously on primary actions. |
| `Input`, `Textarea`, `fieldClass` | Raised paper, `rule-strong` border, lapis focus ring. |
| `Dialog*` | Base UI dialog: warm scrim, raised sheet, serif title, footer on `paper/60`. |
| `Segmented` | Pill switcher ("Images · Video", "All · 30 days"). |
| `Switch` | Ink track. |
| `DropdownMenu*` | The single menu primitive (actions, radio choices, `menuItemClass` rows). Popups sit at z 9300, above dialogs. |
| `Popover`, `popupSurfaceClass` | Raised-paper anchored panel for pickers that aren't lists. |
| `FloatingToolbar` (`floating-toolbar.tsx`) | Canvas and selection toolbars: one icon-button style with an ink tooltip and key hint. |
| `Notice` (`notice.tsx`) | The quiet banner card: pigment dot, one sentence, one action. |
| `Tooltip`, `Sheet`, `Sidebar` | shadcn primitives. Their semantic classes are bridged to tokens. |
| `Mark`, `Wordmark` (`components/brand/`) | The *tre cerchi* emblem and the serif name. |

Prefer these over hand-built divs. If you need a new primitive (Select, Tabs), build it in `components/ui/` on `@base-ui/react` with the same token vocabulary. Don't build it inline in a page.

## Patterns

- **Crop marks:** wrap media frames in `.crop-marks`. Tune them with `--crop` (corner length), `--crop-gap` and `--crop-color`. Use them for the hero artwork, the selected or focused generation, and drop targets (use `--crop-color: var(--lapis)` while dragging over).
- **Generating:** use the `.ink-shimmer` slot with the real aspect ratio. Underneath, show elapsed time in `tabular-nums` and the model name in ink-3. Never use a bare spinner on a media slot.
- **Status chips:** `rounded-full px-2 h-5 text-[11.5px]`.
  - Done: verdigris text with a ✓.
  - Queued: ochre.
  - Failed: sanguine, with a "Retry" link.
  - Running: ink-2 with an animated dot.
- **Chips and tags:** `rounded-full` hairline (`shadow-[inset_0_0_0_1px_var(--rule-strong)]`), 12.5px ink-2. A suggested chip uses a dashed border. A selected chip uses `bg-lapis-soft text-lapis`.
- **Empty states:** a serif headline plus one ink-2 sentence plus one primary action, optionally over `.fresco` and `.paper-grain`. The signature artwork is `/art/the-touch.webp` (the hands from Michelangelo's *Creation of Adam*, public domain), framed with crop marks.
- **Composer (prompt box):** `bg-surface-raised rounded-[var(--radius-xl)] shadow-[var(--shadow-md)]`. The textarea is 15px with no inner border. The control row below is ghost buttons and segmented pills. The `GenerateButton` sits at the right with its outcome ("Generate 4 images") and a `⌘↵` Kbd hint.
- **Generate motion:** the rings part on hover (200ms), turn a third of a circle when a generation is sent, and orbit while one is in flight. Besides the shared 0.98 press, nothing else on the button moves.
- **Toasts:** raised paper with `--shadow-lg`, a 3px left bar in the status pigment, the mark as the app icon, and a serif-free 13px body.
- **Banners:** don't use full-width red or amber bars. Prefer an inline card in the page header area with a pigment dot and an action.
- **Highlights:** use `--highlight` (`rgb(var(--ochre-rgb) / 0.22)`) as a marker-pen background behind changed or matched text.

## Voice

- Speak calmly and in the second person. Use sentence case. Avoid exclamation marks and avoid hype words ("magic", "AI-powered", "unleash").
- Empty states invite rather than instruct: "What shall we make?", "Nothing here yet. Your first piece will appear here."
- Errors say what happened and what to do next: "kie.ai is out of credits. Top up, then retry. Your prompt is saved."

## Theme

- `data-theme` on `<html>` is either `paper` or `ink`. The user's preference (`paper | ink | system`) is stored in `localStorage["buonarroti-theme"]`. A boot script applies it before first paint.
- Read or change it with `useTheme()` and `setThemePreference()` from `lib/theme.ts`.
- Components must look right in both themes. Tokens handle that automatically, and raw colours break it.
