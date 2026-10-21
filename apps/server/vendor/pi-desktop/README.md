# PI-Desktop vendor snapshots

Verbatim source snapshots, not imported modules. Nothing in this directory is on a runtime import path or inside the
TypeScript include list; they are kept so the adapted behavior can be compared against the original.

- Source: `https://github.com/vastsa/PI-Desktop`
- Revision: `ed54ce9774c41cefb5d0cdcdf922de7e6df22621`
- License: GNU Lesser General Public License v3.0 (`LICENSE`, fetched from the same revision)

| File | md5 | Adapted as |
| --- | --- | --- |
| `skill-document.ts` | `df5f712b934f0360ab64567dc2cc0861` | `apps/server/src/workspace-resources.ts` `/skill:<name>` expansion: real host path, and "references are relative to" the skill directory |
| `agent-skill-scan.ts` | `972ee1068cba6d586c05b2442520189b` | Reference for `~/.agents/skills` and project `.agents/skills` shapes and for reading `name`/`description` from frontmatter |
| `skill-market-scan.ts` | `7b5f72f35daa23be2d77180e19627968` | Reference for `apps/server/src/skill-repository.ts` category guessing and five-minute catalog/document caching |
| `SkillMarketPanel.tsx` | `cf0a15ce61b24af605641b1beddb7f39` | Provenance only: the layout the built-in Skills panel (`packages/ui/src/components/SkillsConfig.tsx`) replaced in ticket 14. Moved here from `apps/web/vendor/pi-desktop/` when ticket 17 retired the Next app, byte-identically |

`apps/server/src/skill-repository.ts` stores a bundle as a whole directory — its `SKILL.md` plus every other file,
text as UTF-8 and binary as base64 — and never executes that content; the upstream scanner has no such storage and
nothing of its document transport is reused.

The adapters take only the behaviors they need. The skill loader does not copy the scanner's Electron/desktop
plumbing, its `claude-*` sources, its size caps, or its slugging, and it does not use this file's frontmatter reader:
the loader uses the upstream `@earendil-works/pi-coding-agent` `parseFrontmatter` instead, and applies the upstream
`loadSkillsFromDir` discovery rules.

`skill-market-scan.ts` is a provenance snapshot, not an imported module: it depends on the `@pi-desktop/shared`
package, Electron IPC and the app's own network policy guard, none of which exist here. `apps/server/src/skill-repository.ts`
adapts two narrow behaviors from it under MIT-incompatible-license awareness: the keyword-based category guessing table,
and the idea of a five-minute catalog/document cache. No PI-Desktop code is executed in this repository.

Deliberately not borrowed: the network policy classifier (fake-IP/TUN address refusal), the jsDelivr document transport,
Electron IPC, the built-in catalog format and pagination.
