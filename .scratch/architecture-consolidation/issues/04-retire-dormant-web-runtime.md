# 04: 退役已被现有所有者接管的 Web runtime

**Parent:** [Architecture consolidation spec](../spec.md)

**What to build:** Web 保持聊天、MCP 与工作台现有功能，同时移除静态休眠的本地 runtime/宿主实现及失去使用者的依赖。

**Blocked by:** None (can start immediately)

**Status:** resolved

## Acceptance criteria

- [x] 逐项复核研究中的 76 个候选文件，记录删除或保留理由；确认无在线、类型、配置、测试承接需求的实现退出可执行树。逐项处置见 `.dev/verify/consolidation-04/dispositions.md`；可达性、import 边、测试/脚本引用证据见同目录 `reachability.txt`、`keep-edges.mjs`、`edges-precise.mjs`、`scan-testrefs.mjs`。
- [x] 活跃 MCP UI 助手、16 个类型可达模块、service worker、构建 loader 与真实配置入口保留；vendor 来源和许可保留。`public/sw.js`、`lib/next-compiled.d.ts`、`lib/gfm-autolink-email-loader.cjs`、16 个 type-only 模块与全部 runtime 可达 `lib/**` 保留；`apps/web/vendor/pi-web/**`（含 LICENSE）未改动。
- [x] 三项本地适配的修改承接关系写入变更说明，删除不丢失需要维护的行为。`project-trust.ts` → `packages/gateway/src/mcp/config.ts:222/238`；`mcp-config-read.ts` → 同文件 `readMcpConfig`/`validateServerConfig`；`tool-result-images.ts` → `@hepi/protocol` 的 `MAX_TOOL_RESULT_IMAGE_BYTES`/`TOOL_RESULT_IMAGE_MIMES`。写入 `docs/upstream-sources.md`、`docs/migration-status.md`、`apps/web/README.md`。
- [x] 仅在真实使用者消失后移除依赖及对应配置项并同步 lockfile；不扩大 tsconfig 或借机补旧产品能力。移除 `proper-lockfile`/`web-push`/`semver`/`@earendil-works/pi-tui`/`node-pty` 及 4 个 `@types`（`pnpm install` 报 `Packages: -9`），同步 `pnpm-lock.yaml`、`next.config.ts` `serverExternalPackages`、`pnpm-workspace.yaml` `allowBuilds` 与 `deploy/docker/web.Dockerfile` 注释；tsconfig 未放宽。
- [x] 当前源码的构建和关键 MCP/聊天流程证明删除安全；旧 .next grep 不作当前修订的构建证明。本工作区 `pnpm --filter @hepi/web build` exit 0；`test:web:unit` 64 文件/111 测试全通过（与基线一致）；浏览器 `ux-capability-trust`(18)、`ux-mcp-surface`(25)、`ux-truthfulness`(29) 全部通过。证据与命令见 `.dev/verify/consolidation-04/report.md`。

## Verification seam

复用 Web 递归单测、typecheck、生产构建、MCP/限制说明/信任状态浏览器检查；保留脚本入口检查。

## Integration notes

初始候选清单见研究 A；12,832 行不是必须达到的删除配额。仅测试引用的八项留待 09 核实退役，B/C 迁移中的状态/连接实现由其所有 ticket 删除。优先在 01/02 合入后执行以减少编辑冲突，但无真实语义 blocker。

## Comments

### 2026-10-15 — resolved (work/architecture-consolidation-04)

实际删除 76 文件 / 12,756 行（`wc -l`，研究里 12,832 是它自己的计数口径）。72 个与 `apps/web/vendor/pi-web/lib/` 逐字节相同，3 个是本仓改写（承接关系见上），1 个无 vendor 副本（`hooks/__fixtures__/react-hook-shim.mjs`，全仓 0 引用）。逐项处置表：`.dev/verify/consolidation-04/dispositions.md`。

验证（命令、退出码、日志全部在 `.dev/verify/consolidation-04/`）：

| 检查 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| Web typecheck | `pnpm --filter @hepi/web typecheck` | 0 | 无错误 |
| Web 递归单测 | `node scripts/test-web-unit.mjs` | 0 | 64 文件 / 111 测试 / 111 通过 / 0 失败（与基线相同） |
| 生产构建（本工作区 .next） | `pnpm --filter @hepi/web build` | 0 | `Compiled successfully` |
| docs 链接 | `node scripts/check-docs.mjs` | 1 | 271 文件 / 12 broken，与 `447a7f8` 基线逐条相同（`comm` 差集为空） |
| 入口检查 | `node scripts/check-entrypoints.mjs` | 0 | 60 present / 2 recorded known-missing |
| MCP+信任浏览器 | `node apps/web/e2e/ux-capability-trust.mjs` | 0 | 18 checks pass |
| MCP 真实宿主浏览器 | `node apps/web/e2e/ux-mcp-surface.mjs` | 0 | 25 checks pass |
| 真实能力/聊天浏览器 | `node apps/web/e2e/ux-truthfulness.mjs` | 0 | 29 checks pass |

依赖：`pnpm install --frozen-lockfile` 报 `Packages: -9`；离线 frozen 在结算后的 lockfile 上再次 exit 0。移除 `proper-lockfile`/`web-push`/`semver`/`@earendil-works/pi-tui`/`node-pty` 与 4 个 `@types`；`undici` 因 `e2e/ux-image-submit.mjs` 保留。

记录（不阻塞、非本票范围）：`apps/web` 的 `"lint": "eslint ."` 没有对应 `eslint.config.*`，无法运行；`tsconfig.json` 的 `include` 放宽是独立步骤，本票未做。

### 2026-10-15 — 合入 integration tip 后复核（merge `a84e6fe`，tip `6bc5049`）

集成分支此时已含 01/02/05/06，故在报告前先 merge。两处 modify/delete 冲突（`lib/mcp-config-read.ts`、`lib/mcp-test.ts`）按本票删除解决：02 的脱敏搬迁已落在 `@hepi/protocol/mcp-secrets`，而 live 模块（`mcp-import*`、`mcp-add-helpers`、`McpAddServer`）import 的正是它，被删的休眠副本不含 02 需要的东西。`docs/upstream-sources.md` 保留双方段落。

| 检查（merge 后） | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 全 workspace typecheck | `pnpm -r typecheck` | 0 | 六个项目（protocol/client/session/gateway/web/server） |
| 全 workspace 测试 | `pnpm -r test` | 0 | protocol 47、session 31、client 10、gateway 184、server 285，0 fail |
| Web 递归单测 | `node scripts/test-web-unit.mjs` | 0 | **61 文件 / 106 测试 / 106 通过 / 0 失败** |
| 生产构建 | `pnpm --filter @hepi/web build` | 0 | `Compiled successfully` |
| docs 链接 | `node scripts/check-docs.mjs` | 1 | 同样 12 个既有 broken，0 new |
| 入口检查 | `node scripts/check-entrypoints.mjs` | 0 | 60 present / 2 recorded known-missing |
| MCP+信任浏览器 | `node apps/web/e2e/ux-capability-trust.mjs` | 0 | 15 checks pass |
| MCP 宿主浏览器 | `node apps/web/e2e/ux-mcp-surface.mjs` | 0 | 26 checks pass |
| 能力/聊天浏览器 | `node apps/web/e2e/ux-truthfulness.mjs` | 0 | 29 checks pass |

61/106 是集成 tip 自身的 Web 套件规模（非本票删测结果）：tip 的测试文件清单与 merge 后逐条比对完全一致，未丢失任何测试。merge 前基线 `447a7f8` 上是 64 文件 / 111 测试，差额来自 01/02/05/06，不是本票。

证据：`.dev/verify/consolidation-04/report.md`（含 `postmerge-typecheck.log`、`workspace-tests-postmerge.log`、`web-unit-postmerge/web-unit.json`、`build-postmerge.log`、`postmerge-ux-*.log`），逐项处置表 `dispositions.md`。
