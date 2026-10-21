# Token footer icon source research

Status when written: planning research only; no app, config, dependency or deployment change was made here, and the
recommendation below was a **candidate pending visual review**. That review happened and ticket 05 shipped the choice
(merged `0bcd1e0`, released at `51492c4`): the four glyphs are inlined in `apps/web/components/TokenUsageIcons.tsx`
with the pinned Lucide `1.54.0` LICENSE beside them, recorded in
[docs/upstream-sources.md](../../docs/upstream-sources.md). The candidate set and the rejected alternatives below are
the record of how it was settled, not an open question. Companion brief:
[icon-style-notes.md](icon-style-notes.md), sequencing item 4 / F3 in [plan.md](plan.md).

Correction note: an earlier draft of this file conflated two surfaces and mixed icon grids.
Both are fixed below. No repository file other than this note was edited.

## Surfaces (do not conflate)

| Surface | File | Today | Scope here |
| --- | --- | --- | --- |
| Per-response usage footer | `apps/web/components/MessageView.tsx` (~928-932, `formatUsage` ~1955) | **Text only**: `"1,234 in · 5,678 out · 9,012 cache R · 0.0123 cache W"` at 11px in `var(--text-dim)` | Target of this research |
| Aggregate token toolbar | `apps/web/components/AppShell.tsx` (~1843-1910) | Custom 10-grid inline SVGs, `strokeWidth="1.2"`, 10px mobile / 12px desktop, `aria-hidden` | **Unchanged.** The user keeps this UI as it is; it is cited only as evidence of the existing visual grammar |

The footer has **no** SVGs today, so there is nothing to "reuse" there. The aggregate toolbar's
10-grid arrows stay where they are and are not a source for the footer.

## Method and capability limits

- This agent has no web-search or web-fetch tool. External facts were read with bounded
  `curl` calls against GitHub's REST API and `raw.githubusercontent.com`, writing into
  `/tmp/iconres/`. Nothing was downloaded into the repository and no package was installed.
- `lucide.dev` and `tabler.io/icons` render client-side; plain `curl` of those pages returned
  no readable content (14 bytes of extracted text). Their **repository markdown at the pinned
  tag** was used instead, which is the source those sites are built from.
- Local assets were read, not modified: `SidebarIcons.tsx`, `SettingsPanel.tsx`
  (`SettingsSectionIcon`), `AppShell.tsx`, `MessageView.tsx`. `apps/web/package.json`
  declares no icon package.

## Source pins (read 2026-10-09)

| Project | Tag / version | Commit | License | Raw asset URL pattern |
| --- | --- | --- | --- | --- |
| Lucide | `1.54.0` (release 2026-10-09) | `a04f228cd01185e09c188b7227b9600c08c565ec` | ISC, plus listed Feather-derived icons | `https://raw.githubusercontent.com/lucide-icons/lucide/1.54.0/icons/<name>.svg` |
| Feather | `v4.29.2` | annotated tag `24c23655d77f46af2d81bd48eabb3d81ada5f562` → commit `1b002399e8758fb2bccea4d07312dc9e0f43dcb8` | MIT (Cole Bemis) | `https://raw.githubusercontent.com/feathericons/feather/v4.29.2/icons/<name>.svg` |
| Tabler | `v3.49.0` (release 2026-10-05) | `bbed884d15354b5cebf2493371f20dc2d5e83eaf` | MIT (Paweł Kuna) | `https://raw.githubusercontent.com/tabler/tabler-icons/v3.49.0/icons/outline/<name>.svg` |

Revisions come from `api.github.com/repos/<repo>/git/ref/tags/<tag>`; licences from each
repository `LICENSE` at the pinned tag. These pins are evidence, not a compatibility promise
for later upstream releases.

## Family comparison

All three families ship the same outline grammar as this repository's existing icons:
`24` viewBox, `fill="none"`, `stroke="currentColor"`, `stroke-width="2"`, round caps and
joins. The differences are geometry and provenance.

| Asset | Family | Path data shape | Notes |
| --- | --- | --- | --- |
| `arrow-up-from-line` | Lucide | arrow + baseline, 3 paths | Up direction = input, per aggregate convention |
| `arrow-down-to-line` | Lucide | arrow + baseline, 3 paths | Down direction = output, per aggregate convention |
| `arrow-up` / `arrow-down` | Lucide | single shaft + head, 2 paths | Simplest silhouette; Feather-derived |
| `database` | Lucide | 3 stacked ellipses, 3 paths | Conventional cache mark; Feather-derived |
| `hard-drive` | Lucide | rounded rect + 2 dots | Simpler silhouette at small size |
| `database-zap` | Lucide | database + bolt | Candidate cache-write mark |
| `arrow-up` / `arrow-down` | Feather | shaft + polyline | MIT only |
| `database` | Feather | ellipse + 2 curved paths | MIT only |
| `database` / `server` | Tabler | 3 arcs / 2 stacked rects | MIT only; Tabler docs inline sample uses `stroke-width="1.25"`, files ship `2` |
| `refresh` / `refresh-cw` | Tabler / Lucide / Feather | two arcs + heads | Rejected as cache-read: reads as Reload/Sync |

Lucide's design spec (`docs/contribute/icons/specification.md` at `1.54.0`) requires a
24×24 canvas, 2px strokes, round joins/caps, ≥1px edge inset and ≥2px element separation.
Its accessibility guidance (`docs/how-to/accessibility.md`) states icons are hidden from
screen readers by default and must be labelled when they carry meaning.

## Licence obligations if paths are copied inline

Preserve the **complete upstream licence and notice text verbatim** for every pinned source
used, rather than picking icons to minimise legal text. Concretely:

- Copy the full Lucide `LICENSE` from tag `1.54.0` — including its entire Feather
  attribution list — not a trimmed summary. If any listed Feather-derived path is used
  (`arrow-up`, `arrow-down`, `database`, `download`, `upload`, …), also keep the full
  Feather MIT `LICENSE`.
- For Feather-only or Tabler-only paths, keep that project's full `LICENSE` at the pinned tag.
- Do not select an icon because it looks like it carries a smaller notice. The obligation is
  the same class for all three (attribution + notice text); the choice should be geometry,
  legibility and meaning.
- Repository convention for copied upstream source is a pinned revision plus the upstream
  licence file kept beside the copy, as in `apps/server/vendor/*` and recorded in
  `docs/upstream-sources.md`. Inline paths need a source comment (file URL, tag, commit) and
  one shared attribution note referencing those preserved licence files.

## Consistent stroke weight (do not mix grids)

Rendered stroke = design stroke × (display px ÷ viewBox units).

| Set | viewBox | Display | `strokeWidth` | Rendered |
| --- | --- | --- | --- | --- |
| Existing footer copy icon (`MessageView.tsx`) | 24 | 11px | 1.8 | ≈0.83px |
| Aggregate toolbar (unchanged) | 10 | 12px desktop / 10px mobile | 1.2 | ≈1.44px / ≈1.20px |
| Proposed per-response set | 24 | 11px | 1.8 | ≈0.83px |

The earlier draft mixed a 10-grid glyph at 1.2 with a 24-grid glyph at 1.8 in one row and
still warned against grid mixing. Correction: the per-response set is **one family on one
grid at one stroke width**. Proposal: all three footer icons on the Lucide 24 grid at 11px
with `strokeWidth={1.8}`, which matches the copy button already in the same footer row.
The footer will therefore look lighter than the unchanged aggregate toolbar; that is expected,
because they are separate surfaces with separate sizes.

## Small-size considerations (~11px)

- 24-grid at 11px scales by ≈0.458, so design stroke 2 renders ≈0.92px and design stroke 1.8
  renders ≈0.83px; Lucide's ≥2-unit element separation renders ≈0.92px. Sub-pixel, but this is
  already the footer's own precedent (the 11px copy icon uses 1.8 on the 24 grid).
- Three stacked ellipses (`database`) are the densest candidate: at 11px each band is ≈0.9px
  and can merge. `hard-drive` (one rounded rect plus two dots) is the safer cache silhouette;
  `arrow-*-to-line` adds a third element per icon — more meaning, more ink.
- Direction: the aggregate toolbar reads up = input, down = output. Keeping the same direction
  in the footer makes the same metric read the same way across surfaces. This direction choice
  is itself tentative and belongs in the visual review.

## Accessibility

Replacing the words `in` / `out` / `cache R` with an icon plus a bare number removes the only
cue that identifies the metric. An adjacent number does not name itself, so the accessible
name must carry the **localized metric name and the value**, e.g. announce
"Input tokens: 1,234" rather than "1,234".

- Preferred: keep the icon decorative (`aria-hidden`), keep the visible number, and give the
  pair one accessible name that includes the localized metric, for example a visually hidden
  localized label inside the value element, or `aria-label` on the wrapper that contains both
  icon and number. The localized tooltip string stays as it is.
- Do not ship an icon that is `aria-hidden` next to a bare number, and do not ship an icon
  whose only name lives in a hover `title`.
- If an icon is ever the only content of a control, follow the `SidebarIcons.tsx` contract:
  `role="img"` plus `aria-label` from a `label` prop.
- Retain the numeric values and localized tooltip strings from `formatUsage` regardless of
  icon choice.

## Recommended minimal inline approach (candidate)

1. Per-response footer only. Leave the aggregate toolbar untouched.
2. One inline 24-grid family at 11px with `strokeWidth={1.8}`: input
   `arrow-up-from-line`, output `arrow-down-to-line`, cache-read `database`
   (or `hard-drive` if `database` proves muddy at 11px), all copied verbatim from
   `lucide-icons/lucide@1.54.0`.
3. Replace the current circular-arrow idea for cache-read, which is easily read as Reload.
4. Do not add an icon package. Inline paths match `SidebarIcons.tsx` and keep the single
   `currentColor` stroke contract; three glyphs do not need a runtime dependency.
5. Add a source comment (file URL, tag, commit) and preserve the complete upstream
   `LICENSE` files for the sources actually used, per the licence section above.
6. Cache-write stays open: `database-zap` or a second `hard-drive` variant are candidates,
   but the footer may keep the plain `cache W` text.

Alternative for review: Feather `arrow-up` / `arrow-down` / `database` (MIT only) or the
Tabler equivalents; all are 24-grid and would use the same 11px / 1.8 stroke rule.

## Not done / open

- No human visual comparison at real display scale across light/dark, mobile/desktop, or
  localized tooltips. An earlier local machine render in `/tmp/iconres/compare_4x.png`
  compared aggregate-family glyphs and is not evidence for the per-response footer.
- Final family, whether cache-write gets an icon, the exact accessible-name markup, and
  whether the three paths move into one shared component remain for the visual review.
