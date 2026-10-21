# 05: 极简技能市场与云端仓库 (Lean Skill Market & Repository)

**What to build:**
提供极简的技能发现与云端存储，避免复杂包管理器或重型构建链：
1. **精选源与本地技能**: 抓取精选公开源（如 `anthropics/skills`, `mattpocock/skills`）与后端 SQLite 管理的自定义技能。
2. **5 分钟内存缓存**: 缓存目录与文档，避免频繁打 GitHub API。
3. **Markdown 预览**: 点击卡片可在前端弹窗完整预览 `SKILL.md` 正文，用户确认后才决定安装。
4. **轻量前端 UI**: 参考 PI-Desktop 的 `SkillMarketPanel`，仅保留核心要素：搜索框、简单分类 Tab、Markdown 预览弹窗、安装目标选择（全局/项目）。
5. **解耦设计**: 市场浏览与活跃对话完全解耦，不影响正在运行的会话。

**Copy / Borrow from:**
- UI 参考: `vastsa/PI-Desktop` `SkillMarketPanel.tsx` (搜索框、分类 Tab、文档预览弹窗)。
- 抓取与缓存: 简单的 HTTP fetch + 5 分钟内存 Map 缓存。
- 拒绝过度设计: 不搞复杂 npm 包机制、不搞多级 lockfile、不搞复杂的网络/沙箱路由。

**Blocked by:** None (前沿票，可独立进行)

**Status:** complete

- [x] 后端支持获取精选源技能列表与自建技能列表，带 5 分钟内存缓存。
- [x] 后端支持按需获取单个技能的完整 Markdown 内容以供预览。
- [x] 前端提供极简市场面板：搜索框、常用分类过滤、卡片列表。
- [x] 点击技能可打开模态框查看完整的 Markdown 内容与描述。
- [x] 独立的技能元数据存储（SQLite），不污染会话状态。
- [x] 技能包按完整目录存储（脚本、二进制、引用文件），发布/列出/查看/按版本取回均有最简管理界面。

## Comments

Implementation: `apps/server/src/skill-repository.ts` (repository + market routes), `apps/web/components/SkillMarketPanel.tsx`,
`apps/web/lib/skill-market.ts`, `apps/web/adapters/skill-market.ts`.

- Curated sources are read over plain HTTPS and cached in memory for five minutes. A source's revision is the commit SHA its
  branch resolved to at fetch time, not the branch name; the card shows that SHA so the displayed version is honest.
- Repository bundles are versioned and immutable per version: publishing an existing version is a 409, never an overwrite.
  Names are lowercase slugs, versions are semver, resource paths are relative markdown, so nothing can traverse out.
- Metadata lives in its own SQLite file (`HEPI_SKILL_REPOSITORY`, default `skill-repository.sqlite` beside the conversation
  database) and holds no conversation state; the restart test proves conversations are untouched.
- Fetched content is never executed and never reaches agent context in this ticket. Installation is ticket 06; the preview
  dialog shows the global/workspace target choice disabled and says installation arrives with that ticket.
- Vendored provenance only: `apps/server/vendor/pi-desktop/` and `apps/web/vendor/pi-desktop/` (PI-Desktop
  ed54ce9774c41cefb5d0cdcdf922de7e6df22621, LGPL-3.0). Only the keyword category table and the five-minute cache idea were
  adapted into the backend; no PI-Desktop code is imported or executed. The panel's layout follows its SkillMarketPanel,
  reimplemented here.

Verification: `pnpm -r typecheck`; `pnpm -r test` (protocol 10, session 3, gateway 31, server 49 — server includes 7 market cases);
`cd apps/web && node --test components/SkillMarketPanel.test.mjs lib/settings-navigation.test.mjs lib/i18n/registry.test.mjs components/SettingsUi.test.mjs`
(36 pass; apps/web has no `test` script, as before this change, so component tests are not part of `pnpm -r test`); `pnpm --filter @hepi/web build`.

## Follow-up (review): whole bundles and version management

The first pass stored only markdown resources, which was too narrow for a Skill Bundle. Corrected in the same ticket:

- A bundle is a whole directory. `skill_bundle_files` replaces `skill_bundle_resources`; every file is stored verbatim,
  text as UTF-8 and binary as base64 (`MarketFile.encoding`). Nothing is decoded, rewritten, or executed — not on
  publish, not on read.
- `safeBundlePath` is extension-agnostic: relative, no backslashes, no traversal, no directory path, and no file named
  `SKILL.md` in any case, because a host filesystem may not distinguish the names. Duplicate paths (case-insensitively)
  are refused, as is malformed base64. The path is validated again by the install ticket at the destination.
- A curated preview reads the skill's whole subtree at the pinned SHA — markdown, scripts, images — while dropping
  symlinks, submodules and nested skill directories (each of which has its own market entry).
- `GET /api/skill-market/bundles` without a name now lists the repository's names, so the management view can open on
  what the repository holds. The existing per-name, per-version and publish routes are unchanged.
- UI: the panel switches between Market and Repository. Repository lists names, offers each version as an explicit
  radio choice, inspects the selected version's `SKILL.md` and file list, and publishes a new version through a form
  with extra-file rows and a binary (base64) toggle. `lib/skill-market.ts` holds the draft rules shared with the tests.

Critical coverage added: a round-trip test publishes a shell script and a PNG, retrieves both byte-for-byte, and
confirms the bundle previews through the same path as a curated skill; a refusal test covers traversal, absolute paths,
`SKILL.md` collision, duplicate paths, bad base64 and bad encodings, and asserts nothing was stored.

Known limits: curated listings carry no description until a document is previewed (the listing is metadata-only to keep
the GitHub request count low), and a curated preview reads at most 50 files; no source-management UI; binary preview
shows the file name and encoding rather than rendering bytes; `components/SettingsPanel.test.mjs` already failed before
this change because it reads `app/login/page.tsx`, which does not exist in this repository.
