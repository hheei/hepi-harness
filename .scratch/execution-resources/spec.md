# Execution-Side Resources Specification

**Status:** implemented; tickets 01–08 complete. Validation limits are recorded in
[execution-resources-validation](../../docs/execution-resources-validation.md), which is a **dated record at merge tip
`d8f3633`** — its counts and its "ticket 08 in progress" note are frozen there and since superseded. For current
entrypoints and the current whole-web baseline, read [docs/verification.md](../../docs/verification.md).

## Problem Statement

An operator selects a local or SSH workspace, but current resource loading mixes execution-host files with harness-local skills, prompts, and context. Global resources can resolve against the wrong home, ordinary file tools cannot necessarily reach advertised resource paths, and a custom resource URI obscures where content lives. Resource changes and restart recovery also lack a clear conversation-owned loading result. A broken resource should produce an actionable notification, not disable every conversation or the service.

## Solution

Separate the cloud Skill Repository from execution-host discovery. A Workspace Resource Loader discovers installed skills, prompts, and context through the selected Execution Environment and actual execution account. Conversations remain permanently bound to their workspace in the first version. They adopt a durable resource loading result, refresh it explicitly and atomically, and retain the previous result if refresh fails. Skill bundles can be managed in the cloud and explicitly installed or updated on an execution host; repository content is never a runtime fallback. Preserve upstream loading semantics through adapters rather than building another sandbox or agent runtime.

## User Stories

1. As an operator, I want resources to come from the selected execution host, so that the model sees the files used by its tools.
2. As an operator, I want global discovery to use the actual execution account and home, so that gateway and harness process homes cannot silently change available resources.
3. As an operator, I want workspace and ancestor resources discovered according to verified upstream rules, so that existing Pi projects retain familiar behaviour.
4. As an operator, I want skills, prompts, and context supported by one execution-side resource abstraction, so that they share host selection without losing their distinct uses.
5. As an operator, I want manually written, git-managed, and Pi-installed skills usable without repository registration, so that existing host installations keep working.
6. As an operator, I want unknown provenance and version displayed honestly, so that unmanaged skills are not incorrectly called missing or locally modified.
7. As an operator, I want skill metadata to advertise real execution-host file paths, so that ordinary read tools can access selected skill files and references.
8. As an operator, I want skill scripts to run through the selected host tools, so that cloud bundle storage cannot become an execution source.
9. As an operator, I want skill commands and prompt argument substitution retained, so that migration does not break familiar commands.
10. As an operator, I want context and system-prompt precedence retained from verified upstream behaviour, so that resource placement remains predictable.
11. As an operator, I want initial resource loading for a new conversation, so that its first run has the appropriate context.
12. As an operator, I want a conversation to remain bound to its workspace even when idle, so that its history and resource state cannot silently move to another host.
13. As an operator, I want to create a new conversation when selecting another workspace, so that changing projects has an explicit lifecycle.
14. As an operator, I want an explicit Reload action, so that I choose when host changes enter the conversation.
15. As an operator, I want successful Reload to apply on the next run, so that an active run never changes its adopted prefix mid-flight.
16. As an operator, I want Reload to commit one complete loading result, so that failed discovery or parsing cannot mix old and new context.
17. As an operator, I want Reload failure to retain the previous prefix and catalog and notify me, so that existing conversation state remains usable.
18. As an operator, I want first-load failure to block only the affected attempted run and permit retry, so that other conversations and the UI remain available.
19. As an operator, I want restored conversations to retain their adopted prefix and catalog after runtime restart, so that restart is not a hidden Reload.
20. As an operator, I want ordinary file reads to reflect current host contents, so that persisted resource state does not imply a frozen directory or script snapshot.
21. As an operator, I want explicit failure when an execution environment is unreachable, so that harness-local content never masks a host outage.
22. As an operator, I want cloud bundle versions stored independently of conversation history, so that resource management does not redefine durable session ownership.
23. As an operator, I want to publish, list, inspect, and retrieve versioned Skill Bundles through repository management, so that I can distribute them to selected hosts.
24. As an operator, I want installation to choose global or workspace scope explicitly, so that placement and sharing are visible.
25. As an operator, I want global installations shared across workspaces on the same host and account, so that installation does not create per-workspace copies.
26. As an operator, I want installed resources usable without repository connectivity, so that cloud storage availability does not control execution-host loading.
27. As an operator, I want safe atomic installation with no traversal or escaping symlink destinations, so that bundle placement cannot corrupt unrelated files.
28. As an operator, I want explicit Update and an install-time content-hash baseline, so that repository releases and local modifications are distinguishable.
29. As an operator, I want ordinary Update to stop on local modifications, so that my changes are not silently lost.
30. As an operator, I want separate confirmation and a backup before overwriting modified content, so that an intentional replacement preserves my previous work.
31. As an operator, I want successful Install or Update to request Reload for its initiating conversation, so that it can adopt the new installation without hot-updating every other conversation.
32. As an operator, I want installation success distinguished from a subsequent Reload failure, so that notifications report what happened without falsely claiming rollback of published files.
33. As a maintainer, I want upstream versions, licenses, loading rules, and regression evidence preserved, so that adapters remain traceable and legacy code is removed only after replacement works.
34. As a maintainer, I want extensible resource interfaces without implementing undefined repository features or a custom sandbox, so that this migration stays within the agreed scope.

## Implementation Decisions

### 极简务实设计原则 (Anti-Overengineering & Copy-First)

坚持只做核心需求，坚决不搞复杂全家桶：
- **不搞复杂插件体系**：不引入 OMP 的包管理器、动态编译、LSP/DAP、`bun install` 或复杂的 lockfile 链。
- **不搞自制 npm 包分发**：不引入 Pi 上游的 npm 注册中心或 tarball 发布流水线。
- **不搞模型自写工具**：不内置 OMP 的 `manage_skill` 模型自编辑工具，技能保持人为主导管理。
- **不搞复杂网络防火墙**：不引入 PI-Desktop 的 fake-ip/TUN 路由分类器，后端普通 HTTPS 抓取即可。

#### 聚焦借用的实用切片 (Lean Reference Map)

1. **执行端资源呈现 (Borrow from PI-Desktop & Pi upstream)**:
   - `PI-Desktop` `apps/desktop/electron/main/skill-document.ts`: 简单的 `formatSkillToolContent`，把真实路径和相对引用注入提示词。
   - `pi-coding-agent` `core/skills.ts`: 现成 `loadSkillsFromDir`、`parseFrontmatter`，免手写解析。
2. **轻量技能市场与预览 (Borrow from PI-Desktop UI)**:
   - 前端 UI: `PI-Desktop` `SkillMarketPanel.tsx` 的极简布局（搜索框、5个分类 Tab、Markdown 预览弹窗）。
   - 数据源：配置几个公认优质 GitHub 源（如 `anthropics/skills`, `mattpocock/skills`）+ 本地 SQLite 存储的自定义技能。
3. **安全安装与防覆盖备份 (Borrow from cc-switch)**:
   - 安装落盘：直接把 `SKILL.md` 写入宿主 `~/.agents/skills/<name>/` 或项目 `.agents/skills/<name>/`。
   - 防覆盖保护：目录已存在且有修改时弹窗提示，覆盖前简单重命名为 `.bak` 备份。
4. **原子热重载 (Borrow from OMP & server existing WorkspaceDoc)**:
   - 触发时一次性读取解析，全部成功才替换当前对话的 Catalog；正在运行的轮次不受影响，失败直接弹 Toast 保留旧状态。

#### 2. 本地执行与持久化 (借鉴 pi-web, pi-coding-agent, cc-switch)

To avoid writing from scratch, borrow and adapt directly from proven open-source implementations:
- **pi-web (`apps/web/vendor/pi-web/`)**:
  - `components/SkillsConfig.tsx`: Existing rich React settings UI for global/project skill scopes, toggle invocation, search, and descriptions.
  - `lib/skill-lock.ts`: Proven schema for `.skill-lock.json`, install-time content hashes, and scope annotation.
  - `lib/skill-frontmatter.ts`: Surgical line-editing for `disable-model-invocation` in `SKILL.md` preserving original YAML formatting.
  - `lib/skill-updates.ts`: Hash comparison and update detection patterns.
- **PI-Desktop (`github.com/vastsa/PI-Desktop` & `github.com/DLYZZT/pi-desktop`)**:
  - `apps/desktop/electron/main/skill-document.ts`: Real host path advertising (`formatSkillToolContent` with location and relative reference guidelines).
  - `apps/desktop/electron/main/importers/agent-skill-scan.ts`: Multi-source scanner for global/project skills (`claude-*`, `pi-*`), directory vs single-file shapes, and lightweight frontmatter parser.
  - `apps/desktop/electron/main/skill-market-catalog.ts` & `skill-market-scan.ts`: Skill market catalog aggregation, categories, and remote document fetching.
  - `src/agent-host/skills-service.ts` (`DLYZZT/pi-desktop`): CLI & API install/search wrappers for skills.
- **cc-switch (`farion1231/cc-switch`)**:
  - `src/components/skills/SkillsPage.tsx`: Proven UX for discovery, installed list, repository selector, installation targets, directory conflicts, and installation status.
  - `src/lib/api/skills.ts`: Proven data contracts for `InstalledSkill`, `DiscoverableSkill`, `SkillBackupEntry`, `contentHash`, and backup/restore workflows.
  - `src-tauri/src/services/skill.rs`: Backup creation on overwrite/uninstall, unmanaged skill scanning, and install-time hash calculations.
- **pi-gui (`packages/gateway/vendor/pi-gui/` & `pi-gui` upstream)**:
  - `apps/desktop/src/features/extensions/skills-view.tsx`: Workbench list/detail split, group ordering (Workspace, User), slash command rendering.
- **@earendil-works/pi-coding-agent upstream**:
  - `packages/coding-agent/src/core/skills.ts`: Parsing, ignore handling (`.gitignore`, `.ignore`, `.fdignore`), and formatters.
  - `packages/coding-agent/src/core/prompt-templates.ts`: Prompt argument substitution and parsing.

- ADR 0001 retains a single authoritative backend runtime and SQLite writer; gateways execute tools and the Web UI presents state. Do not introduce a coding-agent session runtime or replace durable persistence with JSONL.
- ADR 0002 governs resource ownership and lifecycle. It supersedes older planning language allowing workspace changes and relying on harness-local user resources; the original durable-harness spec and tickets remain historical inputs, not permissions to reverse these decisions.
- Keep Skill Repository and Workspace Resource Loader separate deep modules. The repository manages bundle files and SQLite metadata; the loader consumes ExecutionEnv capabilities and supplies a conversation resource loading result. Their storage and failure modes must not be coupled.
- Use the installed upstream Pi version as the reference for discovery locations, ancestor traversal, ordering, duplicate diagnostics, command expansion, and system/context precedence. Verify rules before adaptation and record exact provenance; do not claim comprehensive upstream parity without evidence.
- Reuse public upstream parsers and formatters where available. Adapt filesystem-dependent loaders through ExecutionEnv or preserve narrow copied implementations with version/license records rather than passing remote paths to a harness-local filesystem loader.
- Resolve execution identity, home, and actual workspace paths through local and SSH adapters. Browser-supplied paths and guessed home directories are not authoritative. Preserve configured gateway/workspace authentication and target selection.
- Resolve the current workspace-only file-RPC gap as part of general execution-adapter resource access, not through resource URIs, dedicated skill-read tools, or a new per-skill permission system. The exact file-access adaptation must be documented during implementation; this spec does not mandate blanket removal of existing checks or design a future sandbox.
- A new workspace-bound conversation loads resources initially. Existing restored conversations with committed resource state use that state without rediscovery. Existing conversations lacking resource state require one explicit initialisation path before a resource-dependent run; errors remain conversation-scoped and history is preserved. Workspace-less conversations must not obtain resources from harness home.
- Persist the adopted rendered system prefix and resource catalog as versioned conversation-owned durable state. Use existing durable document/configuration seams; no independent session database. Exact schemas and endpoint names remain implementation choices.
- Refresh computes a complete candidate loading result and commits it atomically. If a run is active, resource changes affect the next run, not that run or in-run steering. Serialise adoption with run-start semantics so tests can demonstrate the distinction without timing sleeps.
- Loading-result persistence does not promise frozen files. Skill bodies, scripts, references, and ordinary file reads use execution-host contents when read. Command expansion must not trigger implicit full rediscovery on each submission.
- Add coherent authenticated resource state and Reload operations through the existing backend protocol and UI adapter. Snapshots/events expose committed loading state and failures sufficiently for reconnect and user notification; avoid a second event architecture.
- On Reload failure preserve the previous prefix/catalog, show a notification, and allow retry. On first-load failure block only the affected attempted run. A malformed resource or unreachable workspace must not crash startup, stop unrelated runs, or make conversation lists unusable.
- Repository management supports publishing, listing, inspecting, and retrieving explicit skill versions through a minimal UI and management API. Bundle format, metadata schema, and concrete storage paths are implementation choices. Repository metadata is separate from conversation history even if it uses the same SQLite owner.
- Global installation targets the execution account on the selected host; workspace installation targets its project directory. Store installed version/provenance and install-time content hashes needed to distinguish unmanaged, unchanged, and locally modified content. Missing baseline is unknown, not proof of local modification.
- Installation stages content and publishes atomically on the target host. Validate destination containment, bundle traversal, and escaping symlinks as installation safety. Never execute cloud bundle content during publication or installation. Preserve existing side-effect outcome handling; do not invent automatic replay after uncertain remote outcomes.
- Normal Update refuses modified installations. Separately confirmed overwrite preserves the replaced directory as a backup; do not add automatic merges or garbage-collection policy.
- Successful installation/update requests Reload only for the initiating conversation. Installation publication and resource adoption are separate outcomes: failed adoption retains the old loading result and produces a notification rather than undoing an otherwise successful installation or updating other conversations.
- Remove the custom URI namespace and dedicated read tool after ordinary execution-host paths work and replacement regression coverage passes. No runtime compatibility fallback keeps either alive; temporary implementation sequencing is not an accepted permanent dual path.

## Testing Decisions

The user approved these public seams before specification publication:

- Backend HTTP/SSE plus actual Gateway/ExecutionEnv is the primary integration seam. Use a deterministic model provider and inspect observable prompts, commands, tool results, state, events, and restart behaviour, not private loader structures.
- Repository management API through to execution-host files verifies bundle storage, installation, updates, local modification conflicts, explicit overwrite, and backup. Use isolated temporary filesystems and controlled test homes; never mutate the developer's actual HOME.
- A small set of UI behaviour tests verifies explicit Reload, management actions, error notifications, retained state, and unaffected conversations. Do not duplicate every parser test at UI level.
- Local integration uses real temporary files and actual RPC adapters. SSH tests use controlled transport fixtures with distinct account/home/workspace values, plus a separately documented real-host smoke test when an authorised host is available. An unavailable host is a reported verification limitation, not a reason to fabricate evidence.
- Prior art includes existing server HTTP/SSE/restart tests, gateway ExecutionEnv/filesystem/SSH tests, resource command-expansion tests, and durable Web adapter tests. Reuse their setup and deterministic provider patterns.
- Verify host identity isolation, global/ancestor paths through ordinary read, command semantics, distinct context precedence, unmanaged provenance, no harness fallback, and fixed workspace binding.
- Verify restart retains adopted results after host files change, explicit Reload adopts changes for the next run, active runs retain their prefix, and subsequent ordinary reads still see current files.
- Verify partial refresh failure commits nothing, first-load and reload failures notify without taking down the service, two conversations remain independent, and healthy conversation listings remain available.
- Verify global installation sharing, workspace placement, offline repository independence, install-time baselines, conflict refusal, backup preservation, failed installation publication, and install-success/reload-failure reporting.
- Installation safety tests target traversal and destination/symlink escape. Do not expand this into an adversarial resource-read sandbox review.
- Preserve baseline tests for authentication, configured targets, model/provider configuration, streaming, reconnect, request correlation, tool outcomes, and durable recovery. Before deleting legacy code, show replacement regression evidence and preserve source/license snapshots.

## Out of Scope

- The planning phase originally excluded implementation. The user subsequently authorized implementation through subagents on `integration/execution-resources`; the feature exclusions below remain in force.
- Custom sandboxing, a new skill permission system, blanket cancellation of existing checks, or final isolation policy.
- Prompts/context upload, repository management, or distribution products; only interfaces remain extensible.
- Automatic host synchronisation, silent overwrites, automatic merges, or cross-conversation hot updates.
- Switching or moving an existing conversation to another workspace.
- Full directory snapshots, freezing script/reference content, or turning ordinary read into a historical file service.
- A second agent runtime, replacement persistence engine, unrelated provider bug fixes, MCP/extensions/packages parity, multi-user management, or marketplace features beyond the specified lean curated-source search and preview.

## Further Notes

- Authoritative decisions: [ADR 0001](../../docs/adr/0001-single-authoritative-durable-runtime.md), [ADR 0002](../../docs/adr/0002-skills-follow-execution-environment.md), and [domain glossary](../../GLOSSARY.md).
- Prior research and copy-first constraints: [pi-web persistence](../../docs/research/pi-web-persistence.md), [upstream sources](../../docs/upstream-sources.md), and [copy-first integration](../../docs/agents/copy-first.md). Persistence research is not proof of model-tool sandbox behaviour.
- [Ticket breakdown](ticket-breakdown.md) was approved and published as eight `issues/` files with explicit blocking edges; the user then authorised implementation through subagents on `integration/execution-resources`. Each issue file carries its own acceptance evidence and remaining limitations; the earlier planning-phase gate in this spec is historical, not a standing restriction.
