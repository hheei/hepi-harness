# Token icon design and visibility research brief

Status: research complete, and the choice below was **implemented** under ticket 05 (merged `0bcd1e0`, released at
`51492c4`). This brief and [icon-source-research.md](icon-source-research.md) are kept as the accepted design record; the
shipped assets are `apps/web/components/TokenUsageIcons.tsx` with its pinned `lucide-icons.LICENSE`, recorded in
[docs/upstream-sources.md](../../docs/upstream-sources.md). Requirement and sequencing were authoritative in
[plan.md](plan.md), item 4 / F3. Wording below that calls the design "pending" is the state at authoring time, kept as
written.

## Existing frontend visual language

| Source | Observed style |
| --- | --- |
| ../../apps/web/components/SidebarIcons.tsx, wrapper near lines 18-34 | 24×24 viewBox, fill none, currentColor stroke, widths 1.8/2, rounded caps/joins. |
| ../../apps/web/components/SettingsPanel.tsx, SettingsSectionIcon | Same outlined 24×24 grammar, 16px default displayed size, 1.8 default stroke. |
| ../../apps/web/components/AppShell.tsx, token status bar near lines 1843-1910 | Small custom inline arrow/cache SVGs using currentColor; 10/12 unit grids with roughly 1.2 stroke. |
| ../../apps/web/components/MessageView.tsx, footer near lines 928-932 and formatUsage near 1955 | Per-response usage is currently a text string at 11px in var(--text-dim). |
| ../../apps/web/package.json | No dedicated external icon package is declared. |

These observations support matching the existing outlined, rounded, theme-colored style. They do not select
a final icon family or decide which arrow direction communicates input/output best.

## Research task before implementation

Compare reuse of the existing inline paths, selected Lucide/Feather paths and selected Tabler paths against
primary SVG assets and license text. Primary sources to inspect: lucide.dev / github.com/lucide-icons/lucide,
feathericons.com / github.com/feathericons/feather, and tabler.io/icons / github.com/tabler/tabler-icons. These
links are research targets; no external comparison or license approval is claimed by this local audit.

Evaluate input, output, cache read and cache write as one semantic family at the actual footer size. A generic
refresh arrow can be mistaken for Reload; database/cache with directional cues is another candidate. Arrow
direction should be consistent between per-response usage and aggregate status. Retain numeric values and
localized tooltip/accessibility text. Compare light/dark themes and mobile/desktop at normal display scale.

Deliverable: cited research note plus a small visual comparison for user review. Choose paths, dimensions, stroke
and spacing as a set. Inlining compatible paths is a candidate; adding an icon runtime dependency is not decided.
Record source/license if external paths are copied, using the repository's copy-first provenance process.
A runnable prototype is a later option only if static comparison cannot settle the choice.

## Settings visibility behavior

Confirmed: a setting must let the user turn token statistics off. Preserve underlying usage accounting; this is
a presentation preference, not a model/runtime setting.

Confirmed after grill round 1: the switch governs response-footer token statistics only. Aggregate token
statistics remain visible under their existing rules. Persist per browser using the current appearance-preference
mechanism; backend accounting is unchanged. Machine-level persistence may be considered later and is not built
in this effort. Preserve current visibility by default; final SVG design remains for visual review.

Completion checks for later work: hiding counts affects response footers only; enabling restores them; preference
survives reload in that browser; aggregate displays and usage accounting retain existing behavior. Icons remain
readable with localized tooltips in both themes and narrow layouts.
