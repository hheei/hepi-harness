# Skills reuse plan: builtin Skills panel, harness-managed bundle sources, and the SkillMarket backlog

Planning notes only. No app, config, or deploy change was made with this file, and no ticket or spec here was
ready to hand to an agent **as written** — these were notes plus open questions.
**Since settled:** the questions below became tickets and shipped — dual-source catalog search and pinned installs
(ticket 10, merged `2036d6a`), update/toggle plus project-default targeting through the gateway (ticket 11), and the
legacy Market panel's retirement (ticket 14, merged `0057f73`). Read the mapping tables below as the plan of record; for
what actually runs, see those tickets and [docs/execution-side-skills.md](../../docs/execution-side-skills.md).

Evidence base: main repo `/home/<client-user>/Documents/dev/hepi-harness`, branch `integration/execution-resources`,
tip `23c5eaa` (`docs/upstream-sources.md` pins pi-web `76bdc570`, cc-switch and PI-Desktop snapshots).

## 1. Requirements taken as input

The authoritative requirements, accepted scope changes and bug-first order are in [plan.md](plan.md), items 9/10
and F6. This document records source evidence and reuse candidates; its implementation suggestions are not
additional approved requirements. Round 2 supersedes the third-destination proposal: install destinations are global/project; harness-managed bundles are directly selectable sources. Standalone Market is retired later.

## 2. Audit: upstream pi-web Skills panel vs the repo's SkillMarket

| Concern | Upstream pi-web (builtin panel) | Repo today (SkillMarket) | Status |
| --- | --- | --- | --- |
| Resource read | `DefaultResourceLoader` in the Web process, `getAgentDir()` on the Web host — `apps/web/lib/skills-service.ts:7-16` | Execution-host discovery only; harness filesystem is never a resource source — `docs/execution-side-skills.md:5-6`, ADR 0002 | Upstream path contradicts ADR 0002; must be re-targeted, not ported |
| Scopes | `global \| project` — `apps/web/lib/api-types.ts:58`; roots `~/.pi/agent/skills/` and `<cwd>/.pi/skills/` — `SkillsConfig.tsx:339-343` | `global \| workspace` — `packages/gateway/src/install.ts:27`; roots `<home>/.agents/skills`, `<workspace>/.agents/skills` — `docs/execution-side-installation.md:27-31` | Different root model; unify on the execution-side roots |
| Lock | `~/.agents/.skill-lock.json` or `$XDG_STATE_HOME/skills/.skill-lock.json` — `apps/web/lib/skill-lock.ts:26-33`; project `<cwd>/skills-lock.json` — `skill-lock.ts:122-141` | `<scope parent>/.skill-lock.json` — `install.ts:125-126` | Unify on the execution-side lock |
| Status / local modification | **No concept.** Upstream only compares a *remote* version hash to a local hash — `apps/web/lib/skill-updates.ts:172-241` | `unchanged \| locally-modified \| unmanaged` against the install-time baseline — `apps/server/src/skill-install.ts:142-146` | Two different questions; the unified panel needs both, labelled separately |
| Update action | Re-runs the `skills add … --agent pi [-g]` CLI — `skill-updates.ts:51-70` | Publishes bundle files through `/v1/installs` with digest pinning and `.bak` retention — `install.ts:222-248`, `skill-install.ts:255-263` | Carry the repo path; the CLI is a Web-host binary dependency |
| Search | `POST /api/skills/search` → skills.sh `{package, installs, url}` — `SkillsConfig.tsx:283-308`, `api-types.ts:52-56` | None | Upstream route is **not** in this repo (see §3) |
| Install | `POST /api/skills/install {package, scope, cwd}` — `SkillsConfig.tsx:311-337` | `POST /api/skill-market/install` — `apps/server/src/server.ts:284-289` | Same idea; repo side is the pinned, host-scoped one |
| Toggle | `PATCH /api/skills` writes `disable-model-invocation` into the skill's own `SKILL.md` — `SkillsConfig.tsx:689-700`; `docs/research/pi-web-persistence.md:112` | File RPC refuses mutations naming resource paths — `docs/execution-side-installation.md:19-23` | Upstream edits resources on the Web host; must move to the execution host |
| Trust | Project roots gated by trust — `skills-service.ts:12-15`; notice `SkillsConfig.tsx:672`, `trust.skillsNotLoaded` `apps/web/lib/i18n/messages/en.ts:689` | `requiresTrust` on project roots in discovery | Keep the trust gate; align the roots |
| Provenance display | Source link, version hash, check/update states — `SkillsConfig.tsx:104-250` | Market panel shows no version, revision, or digest — `SkillMarketPanel.tsx:153-175` | Upstream display is the better base |
| Install feedback | Per-row `✓ Installed` only — `SkillsConfig.tsx:449-470`; no durable outcome | Install notice dropped when `UpdateControls` mounts — `SkillMarketPanel.tsx:282-284` | Neither is a shared outcome flow (see §6) |

## 3. Search is unimplemented (TODO)

The panel calls the following operations that do not exist in this repo, so they fall through to the durable adapter's
`501` (`apps/web/adapters/durable-api.ts:115`):

- `POST /api/skills/search` — `SkillsConfig.tsx:289`
- `POST /api/skills/install` — `SkillsConfig.tsx:316`
- `GET /api/skills?cwd=` — `SkillsConfig.tsx:559`
- `POST /api/skills/check` — `SkillsConfig.tsx:614`
- `POST /api/skills/update` — `SkillsConfig.tsx:653`
- `PATCH /api/skills` — `SkillsConfig.tsx:694`
- `PATCH /api/skills` (bulk toggle) — `SkillsConfig.tsx:739`

The upstream route implementations were **not** preserved: the vendor snapshot copied `lib/` only
(`apps/web/vendor/pi-web/README.md:3-6`), and `apps/web/app` holds just `page.tsx`, `layout.tsx` and
`api/[...path]/route.ts`. Only research notes survive (`docs/research/pi-web-persistence.md:111-113`). A search
implementation therefore has to be re-derived from the pinned clone or replaced by a repo-backed search; either way
it is a TODO, not an existing capability.

## 4. Inventory: what to extract or reuse

### 4a. Repo-side, keep as-is (these already match ADR 0002)

| Item | Path:line | Method / role | Status |
| --- | --- | --- | --- |
| `safeBundlePath` | `apps/server/src/skill-repository.ts:139` | bundle-relative path safety, refuses `SKILL.md` collisions | keep |
| `binaryPath` | `skill-repository.ts:148` | text vs base64 classification | keep |
| `describeSkill` | `skill-repository.ts:120` | frontmatter name/description | keep |
| `createSkillMarket` | `skill-repository.ts:164` | harness-owned bundle store (SQLite) | extract storage/distribution candidate; reuse existing managed-bundle storage; no new store is implied |
| `installContentHashes` | `apps/server/src/skill-install.ts:80` | per-file + folder digest baseline | keep |
| `installDirectoryName` | `skill-install.ts:89` | slug → directory name | keep |
| `bundleFiles` | `skill-install.ts:94` | SKILL.md + files as one publish request | keep |
| `installLockEntry` | `skill-install.ts:115` | provenance record | keep |
| `updateState` | `skill-install.ts:142` | `unchanged` / `locally-modified` / `unmanaged` | keep; this is the *baseline* question |
| `installRequest` / `expectedDigests` / `updateRequest` | `skill-install.ts:293` / `:303` / `:315` | route body validation and digest pinning | keep |
| `InstallScope`, `InstallLockEntry` | `packages/gateway/src/install.ts:27`, `:43` | scope and lock shapes | keep |
| `sameDigests`, `safeInstallPath` | `install.ts:88`, `:111` | digest equality, path safety | keep |
| `installLockPath`, `installScopeRoot` | `install.ts:125`, `:130` | per-scope lock and root | keep |
| `validLockEntry`, `validLockDocument` | `install.ts:135`, `:150` | lock validation | keep |
| `folderContentHash`, `confinedScopeRoot` | `install.ts:173`, `:185` | folder hash, scope confinement | keep |
| `backupPath`, `moveToBackup`, `inspectLocalDirectory` | `install.ts:222`, `:231`, `:249` | retained backups and inspection | keep |
| Install routes | `apps/server/src/server.ts:284-302` | authenticated install/status/update | keep |
| Repository path | `apps/server/src/main.ts:29` (`HEPI_SKILL_REPOSITORY`) | backend-owned storage location | keep; existing managed-bundle source storage |
| Outcome helpers | `apps/web/lib/skill-market.ts:87` `installNotice`, `:115` `updateNotice`, `:101` `updateNeedsConfirmation`, `:110` `updateRequestBody` | publication and adoption reported separately | reuse shape; scope set changes |

### 4b. Upstream pi-web, extract or adapt

| Item | Path:line | Verdict |
| --- | --- | --- |
| `orderSkillsByDormancy` | `SkillsConfig.tsx:65` | reuse |
| `skillsToSwitch` / `applySkillToggleResults` | `SkillsConfig.tsx:78` / `:85` | reuse semantics; write target becomes the execution host |
| `SkillDetail` layout | `SkillsConfig.tsx:104-250` | adapt: add installed version, revision, digest, and baseline state |
| `AddSkillPanel` | `SkillsConfig.tsx:255-480` | adapt: keep global/project destinations; add harness-managed bundle choices and source-aware search states |
| `checkForUpdates` / `updateInstalledSkill` | `SkillsConfig.tsx:601` / `:647` | adapt to the repo's update state and exact-revision pin |
| `updateKey` / `shortVersion` | `SkillsConfig.tsx:123` / `:127` | reuse |
| `SkillSearchResult`, `SkillInstallInfo`, `SkillUpdateState` | `apps/web/lib/api-types.ts:52`, `:60`, `:72` | adapt types; installation destination stays global/project; source metadata identifies harness bundles |
| `annotateSkillsWithInstallInfo` / `getInstallInfo` | `apps/web/lib/skill-lock.ts:122` / `:96` | adapt to read the execution-side lock, not a Web-host lock |
| `buildSkillsShUrl` / `normalizeSource` | `skill-lock.ts:83` / `:57` | optional display only |
| `checkSkillUpdates` cached fetcher | `apps/web/lib/skill-updates.ts:242` | pattern only (request dedupe); the remote check itself is a separate, optional feature |

### 4c. Do not carry over

- Publish/browse/version UI: `PublishDraft` `apps/web/lib/skill-market.ts:32`, `emptyPublishDraft` `:44`,
  `draftError` `:143`, `publishBody` `:159`, `filterMarketSkills` `:49`, `marketRevisionLabel` `:61`,
  `marketSourceLabel` `:66`, `MARKET_CATEGORIES` `:7`.
- A new publishing workflow is not requested. Existing repository management/immutable versions remain reuse candidates for supplying bundles. Retire market-specific `guessCategory` `apps/server/src/skill-repository.ts:111`,
  `CURATED_SOURCES` `:73`, the five-minute catalog cache, and the `MAX_CURATED_FILES` truncation.
- The `skills add` CLI invocation running directly on the Web host (`skill-updates.ts:51-70`): adapt ownership before reuse. Retaining skills.sh as a search/download source remains a candidate.
- `apps/web/components/SkillMarketPanel.tsx` as a whole — deletion later, after review, not now.
- `market.update`-style unconditional button labels and the installed-state-blind action switch.

## 5. Unified Skills plan (target shape)

One builtin Skills panel with two installation destinations:

- **global** — the selected execution host and account.
- **project** — the bound/default project folder on that execution host.

In either destination, offer **harness-managed skill bundles** as directly selectable sources alongside skills.sh
search results. Harness is not an installation destination. The user corrected the earlier three-scope proposal;
search-to-harness import, browser ZIP export and another repository/publishing UI are not requested.

The existing Skill Repository supplies managed bundles; the existing installer writes their complete contents
on the chosen execution host, records provenance, handles conflicts/backups and asks the conversation to Reload.
Saving content in the library never injects it into any agent. ADR 0002 still applies. Internal gateway scope
`workspace` maps to UI `project`; a new scope enum or independent installer is not implied.

## 6. Settled behavior and remaining design

- Settled: global/project destinations; directly clickable harness-managed bundles; skills.sh plus harness-library
  search, with source distinguished; no automatic activation, synchronisation or runtime library loading.
- Design still needs exact source/revision mapping and update comparison. Existing bundle versions and pinned
  GitHub revisions are available; preserve installed provenance and baseline-modification state separately.
- Upstream skill toggles edit SKILL.md. Execution-host ownership and the existing explicit Reload behavior must be
  preserved when adapting that operation; adding a browser/web-host resource source would duplicate ownership.
- Bundle management can reuse current repository interfaces. No additional authoring, publishing or export UI is
  approved merely because the old Market had one.

## 7. Lost feedback and the semantics to fix (independent of deleting the market)

- **Lost feedback.** `SkillMarketPanel.tsx:282-284` swaps `InstallControls` for `UpdateControls` as soon as the
  installed state becomes non-null, and `install.notice` renders only inside `InstallControls`
  (`SkillMarketPanel.tsx:207`). The success (or warning) notice therefore disappears at the status switch. Move the
  outcome into a shared install-outcome flow that is rendered outside that switch and survives section changes.
- **Version equality ≠ baseline unchanged.** Upstream `up-to-date` means "the remote hash equals the hash in the
  lock" (`skill-updates.ts:200-215`); it says nothing about local edits. The panel must show both: the remote
  revision comparison *and* the baseline state (`updateState`, `skill-install.ts:142`).
- **Pin the exact target revision.** A curated preview resolves a commit SHA and reports it as the revision
  (`skill-repository.ts:220`; `MarketSkillSource`, `apps/web/lib/skill-market.ts:11-13`). An install must record and
  compare that SHA, never a branch name (`skill-install.ts:104-113`).
- **Search states.** `SkillsConfig.tsx:283-308` folds "no results" into the error string
  (`:302-306`, `i18n.noSkills` `apps/web/lib/i18n/messages/en.ts:673`). The unified panel needs explicit loading,
  no-results, and failure states, each naming the source and the scopes available for the current Web host / project
  runtime.
- **Outcome after the switch.** A published install with a failed Reload must still say both things after the panel
  re-renders (the shape already exists: `installNotice`, `skill-market.ts:87-92`).

## 8. Concerns that must stay distinct

| Concern | Where it lives | Not to be confused with |
| --- | --- | --- |
| Pin | exact revision/commit — `skill-repository.ts:220`, `install.ts:43-57` | branch names, "latest" |
| Source provenance | `.skill-lock.json` entry — `install.ts:43-57` | market card metadata |
| Script / binary | utf8 vs base64, never executed — `skill-repository.ts:148`, `skill-install.ts:94` | text preview |
| Storage | repository SQLite, harness-owned — `skill-repository.ts:164`, `main.ts:29` | execution-host directories |
| Lock | per-scope `.skill-lock.json`, atomic rewrite — `install.ts:125`, `docs/execution-side-installation.md:49-73` | conversation storage |
| Conflict backups | retained `<name>.bak` — `install.ts:222-248` | a rollback of the publication |
| UI catalog publish | browse / version / publish screens | all of the above |

## 9. TODO (notes, not specs)

1. Preserve the confirmed managed-source role in §6; do not add a harness destination or automatic project activation.
2. Restore/adapt skills.sh search and query existing harness-managed bundles; document source-specific failure modes.
3. Keep global/project installation roots, source identity and managed-bundle revision explicit.
4. Move the toggle to an execution-host path (no Web-host resource writes).
5. Build the shared install-outcome flow and render it outside the installed/status switch.
6. Show installed version, pinned revision, and baseline state in the skill detail.
7. Review the SkillMarket panel and its publish/browse/version code for deletion; keep only what §4a reuses.
8. Re-check `SkillsConfig.tsx` trust handling against execution-side `requiresTrust` roots.

## 10. Evidence index

- ADR: `docs/adr/0002-skills-follow-execution-environment.md`
- Execution-side design: `docs/execution-side-skills.md`, `docs/execution-side-installation.md`
- Upstream provenance: `docs/upstream-sources.md`, `apps/web/vendor/pi-web/README.md`,
  `docs/research/pi-web-persistence.md`
- Upstream panel: `apps/web/components/SkillsConfig.tsx`, `apps/web/lib/skills-service.ts`,
  `apps/web/lib/skill-lock.ts`, `apps/web/lib/skill-updates.ts`, `apps/web/lib/api-types.ts`
- Repo backend: `apps/server/src/skill-repository.ts`, `apps/server/src/skill-install.ts`,
  `apps/server/src/server.ts`, `apps/server/src/main.ts`, `packages/gateway/src/install.ts`
- Repo UI: `apps/web/components/SkillMarketPanel.tsx`, `apps/web/lib/skill-market.ts`,
  `apps/web/adapters/skill-market.ts`, `apps/web/adapters/durable-api.ts`
