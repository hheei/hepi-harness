# Execution-Side Resource Tickets

**Status:** implemented (tickets 01–08 complete; validation limits recorded). This document is the published plan as
approved, kept as record; each ticket's own file carries its final status.

Source: [spec](spec.md). Eight independent issue files are published under `issues/`, numbered blockers-first. The user authorized implementation through subagents after context recovery. Work proceeds on `integration/execution-resources` from baseline `9379754`.

Implementation is integrated through code tip `d8f3633`. See [validation](../../docs/execution-resources-validation.md)
for feature regression, the 21 unrelated baseline Web failures, controlled-SSH coverage, and the trusted-agent policy.

**Merged validation (7985dbb).** `pnpm -r typecheck` pass; `pnpm -r test` protocol 10, session 3, gateway 59, server 70, 0 fail; `pnpm -r build` compiles. Targeted web subsets 172/172 (resources/market/reload 24/24, file browsing 172/172 incl. chat 87/87). Whole web is not green: 21 pre-existing baseline failures on every compared tip. SSH verified through the controlled transport fixture only — no live host authorized. Exact commands, per-file failures and the in-process local publish-lock limit: [docs/execution-resources-validation.md](../../docs/execution-resources-validation.md). Ticket 08 has since been completed; it read `in progress` when this line was written. Its own file carries the final
status: [08](issues/08-retire-legacy-resources-regression.md).

**Real-model and UI smoke (6a81863).** User-authorized step-1 run of the unified loader against a real
`magpie/deepseek-v4.1-flash` endpoint and the real local Next UI: **100/100 checks, 0 failures** (10 model turns,
temporary execution host, headless Chromium), settled per turn on the durable SSE stream with each turn's own new
entries asserted (final assistant stopped normally; the relied-on tool result present and successful). Covers discovery
and `/skill:` expansion, an exact-bytes ordinary read, the fixture's own script through the gateway bash tool, prompt
and skill edits where the committed template still expands to its adopted text before the Reload and to the edited
text after, a backend restart that retained the adopted catalog and replayed the committed template while a skill body
read the disk live, and UI publish / workspace install / confirmed backup-preserving update with exact on-disk bytes.
Output is sanitized (all operator env values redacted, no stack traces) and a broken env file confirmed no secret or
endpoint leaks. Evidence and limits: [real-model smoke](../../docs/execution-resources-real-model-smoke.md). Merged-tip
counts there: protocol 10, session 3, gateway 59, server 70, 0 fail.

## 01 — Local skills follow a fixed conversation workspace

**Borrow / Copy from:**
- `vastsa/PI-Desktop`:
  - `apps/desktop/electron/main/skill-document.ts` (`formatSkillToolContent`: real host path & relative reference prompt formatting).
  - `apps/desktop/electron/main/importers/agent-skill-scan.ts` (global/project skill discovery, single-file & directory shapes).
- Backend: `packages/coding-agent/src/core/skills.ts` (`loadSkillsFromDir`, ignore logic, frontmatter parsing).
- Gateway: Adapt ExecutionEnv filesystem reads for target user home and workspace paths.

**Blocked by:** None.

**Delivers:** Create a local workspace conversation, resolve its actual execution account/home and workspace paths, discover existing global/project/ancestor skills, advertise real paths, invoke a skill, and read its references through ordinary host tools. UI command/state surfaces reflect the selected host, not harness home. Persist the initially adopted skill prefix/catalog so restart does not force rediscovery; reject workspace switching even while idle.

**Verification:** Backend HTTP/SSE through real local gateway and deterministic model; temporary home distinct from harness home; ordinary read outside workspace where global/ancestor skills reside; unmanaged provenance is unknown; restored history retained; first-load failure affects only the attempted conversation run and not service startup/listing. Verify and cite upstream discovery rules while adapting, not in a speculative preparatory rewrite. Existing prompts/context can remain on the legacy path only until ticket 02; this is temporary migration, not a fallback on the new skill path.

## 02 — Prompts and context use the same execution-side loader

**Borrow / Copy from:**
- `packages/coding-agent/src/core/prompt-templates.ts` (argument substitution, `substituteArgs`, `parseCommandArgs`).
- `packages/coding-agent/src/core/system-prompt.ts` (precedence & context formatting).

**Blocked by:** 01.

**Delivers:** Load skills, prompt templates, system/append prompts, and context through the bound ExecutionEnv and present their commands/state in the existing UI. Preserve verified upstream precedence, argument substitution, and collision diagnostics; persist the complete adopted loading result. No execution-side resource falls back to harness files.

**Verification:** Different host/harness fixtures prove source isolation; model transcript proves context precedence; UI adapter commands invoke templates and skills; restart retains the adopted prefix/catalog while ordinary file reads remain current. Resource errors notify and remain conversation-scoped. This establishes the complete candidate loading result for atomic Reload.

## 03 — Atomic Reload, durable recovery, and isolated notifications

**Borrow / Copy from:**
- `apps/server/src/server.ts` existing durable doc pattern (`WorkspaceDoc`).
- `apps/web/vendor/pi-web/lib/agent-event-wire.ts` & error notification patterns.

**Blocked by:** 02.

**Delivers:** Explicit UI Reload runs complete discovery/read/parse and atomically replaces adopted resource state. During a run, successful changes apply to the next run without changing the current prefix or in-run steering. Failed Reload retains old state and notifies; retry works. Durable restart restores committed state rather than hot-loading host changes.

**Verification:** Controlled provider barriers, not sleeps, demonstrate old/current/next-run semantics; fail after partial candidate preparation and assert no mixed adoption. Two conversations and their UI lists remain usable when one fails; first-load retry and reconnect notifications work. Persisted state, catalog, and model-observed prefix stay coherent across restart.

## 04 — SSH resources resolve target identity and real host paths

**Blocked by:** 02.

**Delivers:** The same resource features work for an SSH workspace using the remote execution account/home, not gateway home. UI uses the existing adapter; ordinary remote read accesses advertised skills and references, and host tools run their scripts.

**Verification:** Controlled SSH transport fixtures exercise identity, global/project/ancestor discovery, command/context parity, ordinary reads, and connection failures across backend/gateway. Reuse existing SSH implementation seams; do not create a remote agent runtime or require Pi installation on the SSH host. Record a real-host smoke result if authorised infrastructure exists, otherwise state the limitation. No new Reload UI or protocol architecture.

## 05 — 极简技能市场与云端仓库 (Lean Skill Market & Repository)

**Borrow / Copy from:**
- 前端 UI: `vastsa/PI-Desktop` `apps/desktop/src/components/settings/SkillMarketPanel.tsx` (极简分类 Tab、搜索、Markdown 预览弹窗)。
- 数据聚合: 抓取精选开源 GitHub 库 (`anthropics/skills`, `mattpocock/skills`) + 后端 SQLite 存自定义 Skill，附带 5 分钟内存缓存。
- 拒绝过度设计: 坚决不搞复杂包管理器或依赖解析，仅管理纯文本 `SKILL.md` 与同级 Markdown 资源。

**Blocked by:** None.

**Delivers:** Web 端可检索精选开源技能与自建技能，点击可直接预览完整 Markdown 内容；提供简单管理接口发布、检索和获取技能。与活跃对话生命周期完全解耦。

**Verification:** API and focused UI tests show version persistence and content retrieval; publishing/listing never executes bundle content or implicitly installs/loads it into a conversation. Preserve existing authentication. No marketplace, sync, or speculative general-purpose package manager.

## 06 — Explicit global/workspace installation with conversation Reload

**Borrow / Copy from:**
- `apps/web/vendor/pi-web/lib/skill-lock.ts` (lockfile structure, content hashes, global/project installation scopes).
- `cc-switch/src-tauri/src/services/skill.rs` (safe atomic staging, directory conflict detection, unmanaged skill identification).
- UI: Adapt `apps/web/components/SkillsConfig.tsx` / `cc-switch` `InstallToPopover` for target scope selection.

**Blocked by:** 03, 04, 05.

**Delivers:** UI selects a Skill Bundle version and explicit target/scope, installs on local or SSH execution host, records provenance and baseline hashes, shows installation state, and requests Reload for the initiating conversation. Global installation is shared across workspaces of the same host/account. Installed skills load without repository connectivity.

**Verification:** Management API through actual target files verifies staging/atomic publication, traversal/escaping-symlink rejection, interrupted installation outcomes, selected scope, baseline/provenance, and offline loading. Successful publication followed by failed Reload is reported as two outcomes, preserving prior adopted state; other conversations do not hot-update. Existing side-effect replay safeguards remain intact.

## 07 — Update conflicts, confirmed overwrite, and retained backups

**Borrow / Copy from:**
- `cc-switch/src/lib/api/skills.ts` (`SkillBackupEntry`, `SkillUninstallResult`, `restore_skill_backup`).
- `apps/web/vendor/pi-web/lib/skill-updates.ts` (local modification vs install-time hash comparison).

**Blocked by:** 06.

**Delivers:** Ordinary Update detects local modifications against install-time hashes and stops. UI offers a separate explicit overwrite confirmation that preserves the replaced directory as a backup. Successful Update refreshes provenance/baseline and requests Reload for its initiating conversation.

**Verification:** Repository API-to-files and focused UI tests cover clean update, locally changed files, unknown baseline, newer repository version without local edits, conflict refusal, cancellation, backup preservation, failed publication, and install/update-success versus Reload-failure notifications. No merge, silent overwrite, or automatic retry of uncertain side effects.

## 08 — Retire legacy resource namespace and prove integrated regression

**Blocked by:** 03, 04, 07.

**Delivers:** Only ordinary ExecutionEnv resource paths remain active. Remove custom resource URIs, the dedicated resource-read tool, and obsolete harness-local resource loading after replacement coverage passes. Preserve upstream provenance/license snapshots and update operator docs with ownership, Reload/recovery, installation/update, and limits.

**Verification:** Entire feature regression across local and controlled SSH execution, repository management, install/update, UI notifications, restart, authentication, configured targets, model configuration, and existing chat/tool behaviour. Assert no production resource URI/tool fallback remains. This is the narrow integration/contract cleanup after demoable slices, not permission to rewrite unrelated runtime or provider code.

## Dependency graph

- Initial frontier: 01 and 05.
- 01 → 02 → 03.
- 02 → 04 (parallel with 03).
- 03 + 04 + 05 → 06 → 07.
- 03 + 04 + 07 → 08.

Ticket 08 lists both loader branches explicitly because their regression evidence gates legacy removal; 07 transitively includes installation/repository prerequisites. No standalone schema, API, or UI horizontal tickets.

## Implementation entry

Start tickets 01 and 05 in isolated worktrees, then advance the ready frontier according to the dependency graph. Mark tickets complete only after their acceptance criteria are verified.
