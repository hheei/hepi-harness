# 10: Skills 双来源搜索与下载

**What to build:** 内置 Add skills 同时搜索 skills.sh 与 harness-managed bundles，标明来源并直接装入明确的 global/project 目标。

**Blocked by:** 04: 内置 Skills 安装、反馈与当前版本状态

**Status:** implemented, verified — merged as 2036d6a (after the parent's earlier a80522c); the two real bugs (first-time inventory 500, stale inventory answer) are fixed and the smoke driver now passes 16/16 controlled and 6/6 sshd runs on the merged tree

**Dispatch phase:** B — features after 01–04 are verified

**Stories:** 29, 30, 31, 33, 37

- [x] 两类来源分别呈现加载、空结果与实际失败；库搜索不需要运行中的对话。
- [x] 来源解析复用既有上游搜索/完整 bundle 下载机制；安装记录不可变 revision/commit 与 provenance，而不是浮动 branch。
- [x] 两种来源的完整内容均通过已接通的执行侧安装/反馈路径，不在 Web 或后端进程执行下载的脚本。
- [x] 既有 curated/GitHub 来源的安装 provenance 可继续识别，不因 UI 迁移将其判为未安装；旧库及手动目录保留。
- [x] 受控搜索/download 服务与真实 gateway fixture 覆盖查询、安装及重复刷新；harness 仍是来源而非第三目标或自动 agent 内容。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order). Before adapting Skills, read [reuse evidence](../skills-reuse.md).

## Contract extension reported before implementation

The harness had **no source API**: `MarketSkillSource` was `repository | github` with `list/preview/publish/names/versions/retrieve`,
and skills.sh existed only as a dead pi-web Next route that shells `npx skills find|add` **on the Web host** (excluded by this
ticket's third criterion) plus a cc-switch Rust reference. Reported to the parent before coding; the extension is additive and narrow:

- `SkillMarket` gains `search(query): MarketSearchResult` = `{ skills, unavailable }`. It queries `https://skills.sh/api/search`
  through the **existing injected `MarketFetch`**, so the controlled fixture covers it and nothing is downloaded here.
- A row (repository + skill id, never content) is resolved before it is offered: the repository's default branch → its
  current commit (`resolveDefaultRevision`) → the tree at that commit, reusing the existing `treeBlobs`/`safeBundlePath`.
  The offered id carries its own pin — `skills-sh:<owner>/<repo>@<commit>:<path>` — so `preview`, `install`/`resolveBundle`
  and a repeated refresh all read the revision that was shown, not a branch that may have moved. Nothing else in the
  installer changed: `sourceType: "github"` with `ref` = commit was already the provenance path.
- `GET /api/skill-market/search?q=` forwards to it; `GET /api/skill-market/preview` accepts a pinned id.

## Amendment 2: no fallback may manufacture a result

Review of `pinHit`/`candidateTrees` found four places where the code still guessed despite the stated contract. All
four are fixed, with a controlled-catalog regression test that fails at `8e50a10`:

- **`candidateTrees` fell back to `main`.** A metadata failure or a missing `default_branch` silently became a branch
  lookup, so a repository that never said which branch its content lives on was read anyway. Now the repository must
  name its default branch; a metadata 403 (or a response without one) is `unreadable`, and `main` is never read on its
  behalf. Verified: metadata 403 while `main` exists → `owner/denied:unreadable`, previously offered the `main` hit.
- **`pinHit` fell back to the repository root unconditionally.** A hit whose requested slug matched no directory
  received whatever root `SKILL.md` the repository happened to have — an unrelated skill offered under the requested
  name. The root is no longer privileged at all: when no directory is named for the hit, every skill document is read
  (root included, on equal footing) and exactly one declaring the requested name is the hit. Verified: `foo` against a
  root declaring `bar` → `no-document` (previously offered `.../SKILL.md`), while a root that *is* the requested skill
  is still offered.
- **Amendment 3 — the review's two remaining guesses.** (a) The root was returned on sight when it declared the
  requested name, so a nested document declaring the same name was never reached: `twice` → previously offered
  `SKILL.md`, now `ambiguous`. (b) The repository name was accepted as proof of a root hit, but it is a fact about
  the catalog row, not a document — and the skills.sh API exposes no path, so it cannot be evidence at all. `name-only`
  (repository named for the hit, root declaring `bar`, nested document declaring the hit) now offers the nested
  document and does not treat the root as an answer. Both are covered by the controlled `awkwardCatalog` search
  regression, red at `d991530`. The bound now counts the documents actually read in one pass (root included) instead of
  excluding the root and reading it twice.
- **The 25-document frontmatter slice could "prove" a name from a prefix.** A unique match among the first 25 documents
  says nothing about the documents not read; the test's second match sits at document 30. When the repository holds
  more documents than the bound and nothing matched authoritatively, the hit is now reported as a new reason
  **`unbounded`** instead of offered. Verified: `wanted` → `owner/wide:unbounded` (previously offered
  `skills/s05/SKILL.md`).
- **Document filtering used `endsWith("SKILL.md")`.** `MYSKILL.md` and `docs/NOTSKILL.md` were treated as documents.
  Now a document is `path === "SKILL.md"` or `path.endsWith("/SKILL.md")`, via one `isSkillDocument` predicate shared
  with the other call sites. Verified: `my` → `no-document` (previously produced a row whose `pinnedSkill` lookup was
  `undefined` — it serialized as a `null` entry in `skills`, i.e. a crash-class bug, not just a wrong reason).
- **Related hardening found while probing the same class:** `search` used `pinnedSkill(id)!` and pushed the result
  unconditionally, so any id this module will not read back (an over-long path, say) became a `null` row. It now
  reports that row as `no-document` and never offers it.
- **Comment corrected:** the branches answer carries a **commit** (`commit.sha`), not a tree, and `git/trees` accepts
  that commit. The previous comment claimed the branch "answers with a tree sha"; the behaviour (pin the commit the
  branch points at) was right, the explanation was not.

Reason vocabulary grew by `unbounded`; `MARKET_SEARCH_MISS_REASONS`, the web `SearchMiss` union/whitelist and all
three locale files carry it, and the whitelist still drops a reason it does not know. Failure isolation is asserted
throughout: every one of the six queries above offers the healthy `owner/fine` hit beside the failing repository.
No generic registry was added — misses are still computed per query.

## Amendment: the pin is in the selection, not in a cache

The parent's review found the first cut still let a selection depend on cache state. Amended:

- **`preview()` no longer lists before resolving a pinned id.** It previously ran `await list()` (which refreshes
  `catalogCache` per repository) and then looked the id up in that cache, so a TTL expiry, a branch movement or a
  restart could in principle re-decide the commit. A pinned id is now parsed and read from its own id alone — no listing,
  no cache lookup. Proven by a test that previews a pinned id against a **moved branch** and after a **backend restart**
  (new process, all caches gone) and still gets commit `cccc3333` and the original bytes, while a fresh query pins the
  new commit `dddd4444` (so the movement is real, not a fixture that never changed).
- **Legacy curated ids are kept honest, not overstated.** `<source>:<directory>` carries no commit; it still resolves
  through the curated listing, and the commit its preview reports is the one an installation records. A test states
  that limit explicitly rather than claiming the id is pinned, and a pinned id is asserted to work even when the branch
  resolution it does not need fails.
- **Actual skills.sh field mapping, not an assumed branch.** Fields come from the reference implementations' response
  typing (`source` → owner/repo, `skillId` → name, listing metadata unread; cc-switch `SkillsShApiResponse`), and the
  repository's **own default branch** is read instead of assuming `main` — `master` is covered by a test. Pinned ids now
  carry the commit the branch resolved at (a branch's commit), not a re-looked-up tree.
- **Path resolution is authoritative-first and never guesses.** A unique directory (last segment = skill id) holding
  its own SKILL.md wins; the frontmatter lookup runs only when no directory matched, is bounded to 25 documents, and two
  matches are ambiguous → nothing. Ambiguity and absence are separate reasons.
- **Misses are structured and isolated per hit/repository.** `unavailable: { source, reason }[]` with reasons
  `unreadable | no-document | ambiguous | not-github`; the UI localizes the reason word and drops unknown ones. One
  unreadable repository, one ambiguous directory and one non-installable row do not empty the answer — a browser check
  asserts a readable hit survives beside them, each named. No `npx`, no script execution, no new durable registry.
- **Install-side coverage.** A pinned hit installed through a real local gateway after a list refresh, after a branch
  movement and after a restart keeps the same commit, the same bytes and the same lock `ref`; a freshly created market
  (new process) pins the moved commit, proving the movement.

## Implementation

- **Backend.** `apps/server/src/skill-repository.ts`: `search()`, `pinHit()` (directory-last-segment match, else a unique
  frontmatter name, else the repository root; two matches are ambiguous → not offered), `resolveDefaultRevision()`,
  `pinnedSkill()` (id → skill, path-validated), a query cache and a revision cache. A catalog that cannot be read answers
  `unavailable: ["skills.sh"]` — a failed source, never an empty result. `apps/server/src/server.ts` serves the new route.
  No installer/repository storage change; no new registry, no publishing surface.
- **Web.** `apps/web/components/SkillsConfig.tsx` renders two labelled source blocks (harness library, skills.sh
  public catalog), each with its own loading / empty / ready / failed state from `sourceState()`
  (`apps/web/lib/skill-inventory.ts`); the catalog is queried from the search box (debounced, aborted on the next
  keystroke) and an un-queried box says so rather than claiming no match. Target selection, `conversationTarget()`
  omission, install/update bodies and the shared outcome region are unchanged. Locale keys
  `skills.source.skillsSh`, `market.sourceIdle|Loading|Empty|Failed` added to en/zh-CN/zh-TW (registry test enforces parity).

## Evidence

- Red-then-green: the two new server cases were written against the pre-extension route surface — `GET
  /api/skill-market/search` 404'd ("not found"), so the query could not be answered at all; the panel had no second
  source and folded "no results" into the error text.
- `pnpm -r typecheck`: 6/6 projects pass.
- `pnpm -r test`: protocol 10, client 9, session 3, gateway 59, server **90** (6 in `skill-market.test.ts` incl. moved
  branch / restart / legacy-id / reason-contract / no-guess, 2 in `skill-install.test.ts`), 0 fail.
- Red-then-green for amendment 2, against `8e50a10`'s source with the new fixture: all four guesses reproduce
  (`denied` offered the `main` hit, `foo` offered the unrelated root, `wanted` offered `skills/s05/SKILL.md`, `my`
  produced a `null` row), and the fixed source answers `owner/denied:unreadable`, `owner/rooty:no-document`,
  `owner/wide:unbounded`, `owner/suffix:no-document` with `owner/fine` offered in every case.
- Red-then-green for the amendment, run against `60e7f0f` (the pre-amendment commit) with the new test file copied in:
  the reason-contract assertions fail there (`unavailable` was `string[]`, reported as `undefined:undefined` against the
  structured misses). Honest scope note: the moved-branch and restart assertions **pass** at `60e7f0f` too — a pinned id
  already resolved from its own id there, so those two are regression guards on the pinning invariant, not the red.
  They were kept because they are what forbids the `await list()` dependency from being reintroduced.
- New server coverage: an ambiguous directory, an unmatched id and a non-GitHub row are each left out while the one
  pinnable hit is offered with its commit; the pinned id previews its whole subtree at that commit and refuses a path
  that would leave the repository; the query cache is proven by call count; an unreadable catalog yields
  `unavailable: ["skills.sh"]` with zero skills. The installation case goes through a **real local gateway**: the pinned
  hit's bytes land in the execution account, the lock records `source: "github:notes@aaaa1111bbbb2222"` and
  `ref: "aaaa1111bbbb2222"` with **no** bundle version, and two consecutive inventories are byte-identical with the
  baseline `unchanged`.
- Web targeted: `lib/skill-inventory.test.mjs` (11 cases, incl. the new `sourceState` matrix),
  `components/SkillsConfig.dormancy.test.mjs` (3, incl. both source keys and all four state words from locale files),
  `components/SettingsUi.test.mjs`, `components/SkillMarketPanel.test.mjs`, `lib/settings-navigation.test.mjs`,
  `lib/i18n/registry.test.mjs`, `adapters/durable-api.test.mjs` — 63/63.
- `pnpm --filter @hepi/web build` pass (production build used by the browser smoke).
- Browser acceptance, both transports on ports 43110 (Web) / 44110 (backend): `node
  apps/server/scripts/skills-ui-smoke.ts --mode builtin --transport controlled` and `--transport sshd` — **PASS**, with
  new checks: two labelled source blocks; the un-queried catalog saying so; an unreadable catalog named as that
  source's failure while the harness library still lists its bundle; an empty catalog answer as no match; a mixed query
  where a readable hit survives beside an unreadable repository and an unusable row, each named with its own localized
  reason; a catalog hit naming its pinned commit; that hit installed through the execution-side path with the commit in
  the lock. The
  pre-existing install/update/backup/refresh checks still pass and the real account's resource directories remain
  byte-identical (real localhost sshd transport).
- No external network and no model call in any check: the catalog is answered by a controlled `MarketFetch` in tests
  and by the smoke fixture.

## Amendment 4: the smoke flake was two real defects, not driver timing

`skills-ui-smoke --mode builtin --transport controlled` failed roughly one run in five ("Replace anyway" pressed, the
`Updated notes (global)` notice never observed). It reproduced on the pre-existing commit and on the merged tree, so it
was not a merge regression. Instrumenting the browser's own request/response order and the backend's thrown stack
(rather than loosening a wait) found **two product defects**, both fixed:

1. **A missing lock was read as a null one — 500 on every inventory of such a host.**
   `apps/server/src/skill-install.ts` guarded the lock with `lock.value !== undefined`. The local gateway drops the key
   for an absent lock, but the SSH helper answers `{"ok": true, "value": null}` through JSON, so `null` passed the guard
   and `lock.value.skills` threw `TypeError: Cannot read properties of null (reading 'skills')`. Every inventory of a
   host that had never recorded an installation therefore answered **500** — in the smoke, `remote-prod`, whose read
   races the local one. Guard is now `lock.value != null`. Deterministic regression:
   `apps/server/test/skill-install.test.ts` "lists a host whose lock was never written instead of failing the read"
   (red at the previous commit: `500 !== 200`, `{"error":"Cannot read properties of null (reading 'skills')"}`).
2. **A stale inventory answer could replace the current execution target's skills.**
   `loadSkills` in `apps/web/components/SkillsConfig.tsx` published whatever answer arrived, with no supersede guard,
   while switching host, Refresh and an operation's own refresh can all have a read in flight. A slower earlier host's
   answer — including a **failure** answer, which nulls the inventory — replaced the selected host's list and its
   selected detail, which is why the operation outcome the smoke waits for disappeared. The read now carries a
   generation (`inventoryRead` ref) and only the newest read may publish inventory, selection, error or loading.

Red/green, deterministic and browser-driven: `apps/web/e2e/ux-skills-inventory-race.mjs` mounts the production
`SkillsConfig`, replaces only its `window.fetch` boundary, holds the first host's inventory answer until the driver
releases it, selects the second host, then releases the first. At the previous commit the second host's skill is
replaced by `alpha-skill`; after the fix `beta-skill` stays, the sidebar still marks the second host current, and no
error is reported. Every wait is an observable DOM or delivery condition — no timeout was loosened, no assertion
weakened, no sleep or retry added. `pnpm --filter @hepi/web test:skills-inventory-race` (new script).

Measured, 28 consecutive controlled-transport runs and 8 real-sshd runs after the fix: **all pass** (42/43 checks,
0 failures), against ~1-in-5 failing before. The real account's resource directories remain byte-identical in every run,
and the failures were never silent: the byte-identical check is retained and asserted on each pass.

## Review notes

`record` — a filesystem alias between two install names (no guard added).

- **Trigger:** an execution account's skills root, or one installed skill directory, reached through a case- or path-aliasing name, so the catalog offers two distinct names (`notes` and `Notes`, or `notes` and a link to it) that the host resolves to the same directory.
- **Evidence:** ticket 10 keys an installation and an update by the host directory name, and `safeBundlePath` (`apps/server/src/skill-repository.ts`) compares a bundle path's names case-insensitively precisely because a host filesystem may not distinguish them. A host that folds such names could hold one directory for two catalog hits. No reproduction was produced. The gateway already resolves each scope root and confines it before writing, refusing a link that leaves it (`packages/gateway/src/install.ts`), so an alias would have to originate *inside* the trusted account itself.
- **Normal-use likelihood:** negligible. The supported trusted-agent workflow installs from the catalog into the account's own `.agents/skills`; nothing in it creates a case or path alias between two install names.
- **User impact:** none observed.
- **Disposition:** `record`. No guard, patch or test added, and no blocking edge: the gateway's existing containment check already owns the case where a path leaves the root.
- **Revisit if:** a real incident shows two install names resolving to one host directory, the gateway's alias confinement is found bypassable from inside the root, or the user prioritizes case/alias handling.

## Not in this ticket

- The per-skill/bulk model-invocation toggle and the Project **default** target: ticket 11.
- Deleting `SkillMarketPanel.tsx` / `lib/skill-market.ts` and the unused Web host-side skill helpers: ticket 14.
- No deployment, no live skills.sh query, no third installation target, no new publishing/registry UI.
