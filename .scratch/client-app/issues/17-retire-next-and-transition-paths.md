# 17 — 完整删除旧 Next/BFF 与残留路径

Type: implementation
Status: **complete — integrated on `main`.** Both lanes are integrated (A `782ccb6`, B `89c9ec5`) and the last
residue went at `cc772ec` (`git merge-base --is-ancestor cc772ec main` exits 0): the Next app, BFF adapters, vendor
snapshot, Next build config, Web image/Compose service, smoke Web checks and deploy-plan Web image are gone, nothing
imports `next`, and the two declarations that outlived their importer are gone too — `next` 16.3.6 and its lockfile
entry, and the `next` TypeScript plugin and `.next/types` include. The residue section below is kept as the dated record
of what that commit removed, not as open work.
Blocked by: [16](./16-integration-and-direct-cutover.md) — closed by 16's 2026-10-19 closeout
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

维护者只有新入口实现与有效运维指南，不再负担旧链路。

## Scope

以完成的能力/调用者矩阵关闭退役：删除旧 Next route handlers、BFF adapters、旧入口和专属依赖/config、Next 私有 parser、旧启动/容器/service/CI 配置与失效测试；移除桥接 re-export/fallback/双写/迁移开关及无调用旧 feature。公开 URL 按新方案更新调用者，不保留旧链接兼容。

## Lanes

本票按 owner 拆两条并行车道，各自独立 worktree，都从 `main` `701add2` 出发：

| Lane | Owned paths | 状态 |
| --- | --- | --- |
| A | `apps/web/app`, `apps/web/adapters`, `apps/web/lib`, `apps/web/vendor`, `apps/web/tsconfig*.json`, 对应测试与 e2e driver | 已提交：`782ccb6` |
| B | `apps/web/package.json`, `apps/web/next.config.ts`, `deploy/docker/web.Dockerfile`, `deploy/compose*.yaml`, `deploy/docker/smoke.sh`, `deploy/.env.example`, `scripts/check-entrypoints.mjs`, `scripts/check-entrypoints.test` 相关（`scripts/checks.test.mjs`）, `scripts/lib/presets.mjs`, `scripts/lib/deploy.mjs`, `scripts/deploy-plan.mjs`, `docs/client-runtime-release.md`, 本票状态文档 | 已提交：`89c9ec5` |

## Acceptance

- [x] 每一旧 owner/caller 都有替代或明确退役 disposition、删除 diff 和新 seam 验证；无未分配矩阵行。（lane A 持有：`apps/web/app`、`adapters`、`vendor` 的 caller 矩阵与删除）
- [x] 全新 checkout 可不依赖旧 Next/BFF 服务构建/运行；停止/移除旧运行服务后两端及运维命令仍工作。（lane B 已完成：Compose、Dockerfile、smoke 与 deploy plan 中已无 Web 容器；lane A 删除 `apps/web/app`/`adapters` 后，`cc772ec` 又清掉 `next` 依赖、lockfile 条目与 tsconfig 的 Next plugin/`.next/types` include，清单随之干净）
- [x] 静态 import、依赖/lockfile、脚本、部署、测试和文档引用定向扫描无生产残留；历史研究引用标为历史，不强删证据。（部署/脚本/检查侧已完成；`cc772ec` 之后 `git grep` 找不到任何 `next` import，`apps/web/package.json` 与 `pnpm-lock.yaml` 无 `next` 条目，`apps/web/tsconfig.json` 无 Next plugin 与 `.next` include，依赖 `.next/BUILD_ID` 的 `test:system-acceptance` 脚本同批删除。历史研究里对已删 Next 文件的引用仍按证据保留）
- [x] 无旧客户端适配、数据导入、升级/回滚或兼容启动路径；新入口只依赖当前代码与配置。（lane B 已完成：部署与指南不再保留 Next fallback 措辞）
- [x] 删后版本重跑相关检查与跨端关键场景，当前架构/部署/能力限制指南更新；所有相关日志绑定最终 source。（lane B 已完成，见下表；跨端浏览器/原生场景随 lane A 的删除 revision 复跑）
- [x] 保留纯投影、协议与流恢复的独立合同测试；删除已被新 seam 行为验证替代的旧 helper/Next 专属测试，不叠加同义测试层。（lane A 持有）

## Lane B record (2026-10-19, from `main` `701add2`)

删除：

- `deploy/docker/web.Dockerfile` — 唯一构建 `.next` 并 `next start` 的镜像定义。
- `apps/web/next.config.ts` — Next 专属 config：Turbopack/webpack gfm loader、`serverExternalPackages`、`allowedDevOrigins`、`headers()`、`NEXT_PUBLIC_*` 注入、`next/image` 优化器开关、workspace `outputFileTracingRoot`。其两项产品理由（`_next/image` 关闭、Safari lookbehind loader）由 Vite 构建承担：`apps/web/vite.config.ts` 早于本票就是唯一构建入口，`pnpm --filter @hepi/web build` 即 Vite。
- `deploy/compose.yaml` 的 `web` service，`deploy/compose.split.yaml` 的 `web` override，`deploy/.env.example` 的 `HEPI_WEB_IMAGE`/`HEPI_WEB_PORT`/`HEPI_SERVER_URL`/`HEPI_SPLIT_SERVER_URL`。
- `deploy/docker/smoke.sh` 的 Web 镜像构建与五项 Web 检查（serve/login/cookie/proxy）。
- `scripts/lib/deploy.mjs` 的 `webImage`/`platforms.web`/`affected[web]`；`scripts/deploy-plan.mjs` 的 `web-image` 行。
- `scripts/check-entrypoints.mjs` 的 `KNOWN_MISSING` 两条记录（其 entry 已从 manifest 删除，记录随之清空），并抽出 `exitCodeFor` 让 record/strict 判定可直接验证。
- `apps/web/package.json` 的 `files` 中 `.next*` 与 `next.config.ts`（改为 `dist`）、失效脚本 `test:e2e`（`e2e/run.mjs`）与 `test:terminal`（`e2e/terminal.mjs`）、`eslint-config-next`（无 `eslint.config.*`，`lint` 脚本在本 revision 本就不可运行）。

保留（有活跃调用者，归 lane A 或后续票）：

- `apps/web/package.json` 的 `"next": "16.3.6"`：`apps/web/app/**` 与 `apps/web/adapters/**` 仍 import `next/server`、`next/headers`。单独移除即 `pnpm --filter @hepi/web typecheck` 失败（实测 9 处 TS2307），故必须与 lane A 的删除同批提交。
- `packages/ui/src/lib/gfm-autolink-email-loader.cjs` 与 `apps/web/vendor/**`：上游来源/版本/许可记录，按 Pilo 研究保留。
- Web unit 与 Web E2E driver：`scripts/lib/presets.mjs` 的 `webUnitStep`/`webUnitFiles` 与 `changed-checks` 的 `apps/web` 分支未改；`test:web:unit` 仍枚举 19 个文件。

Verification（lane B；source 为含本 lane 改动的 `701add2` 工作树，日志在 `.dev/verify/`）：

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm --filter @hepi/web build`（Vite） | 0 | `dist/` 产出 `index.html` 与 hashed assets，third-party notice 生成 |
| `pnpm --filter @hepi/web typecheck` | 0 | `tsc --noEmit` + `tsc --noEmit -p tsconfig.vite.json` |
| `node scripts/test-web-unit.mjs --quiet` | 0 | 19 files；TAP tests 57 / pass 57 / fail 0 |
| `node --test $(find scripts -name '*.test.mjs' …)` | 0 | 89 tests / 89 pass |
| `node scripts/check-entrypoints.mjs` | 0 | 91 entry files present；0 known-missing；0 newly missing |
| `docker compose -f deploy/compose.yaml config` | 0 | 仅 `backend` service，无 `web` |
| `HEPI_AUTH_TOKEN=x docker compose -f deploy/compose.yaml -f deploy/compose.split.yaml config` | 0 | split 覆盖合并成功，仅 backend 发布 8787 |
| `bash -n deploy/docker/smoke.sh` | 0 | 语法通过 |
| `node scripts/check-docs.mjs` | 1 | 12 → 13 broken：新增一条是 `docs/research/hepi-client-architecture-adaptation.md:255` 指向已删的 `apps/web/next.config.ts`。该文件是历史研究证据，保留；lane A 删除 `apps/web/app` 时同批改指 |

未运行（超出本 lane 能力）：`deploy/docker/smoke.sh` 实跑（构建镜像并起容器，属部署动作）、浏览器 E2E（需要真实 ingress + Backend 栈）、`pnpm verify:changed` 全量（包含 lane A 仍持有的 `next` 依赖与 e2e driver）。

## Verification

删除后 pnpm verify:changed、独立 production build、关键浏览器/原生验收和运行服务检查；静态清单扫描与实际请求共同证明退役。

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；新增问题依照[review policy](../../../docs/agents/review-policy.md)判断实际影响。

## Residue after both lanes (2026-10-20) — closed by `cc772ec`

This section is the dated record of what was still open after the two lanes merged. Both items below were then removed by
`cc772ec` ("packaging(clients): retire the Next declarations and drive the packaged save journey"), so nothing here is
open work; the reasoning is kept because it is why the disposal arrived as its own commit rather than inside a lane.

The retirement is done at every seam that ran: no `apps/web/{app,adapters,lib,vendor}` file, Next build config, Web
container/Compose service, smoke Web check or deploy-plan Web image remains, and `git ls-files` holds no source that
imports `next`. Two declarations outlive their only importer and are recorded here as an open residue, not as retired
work:

- `apps/web/package.json` still lists `"next": "16.3.6"`, and `pnpm-lock.yaml` still carries `next@16.3.6`. Nothing
  imports it; removing it is a dependency-graph change this ticket's lanes did not make.
- `apps/web/tsconfig.json` still names the `next` TypeScript plugin and includes `.next/types/**/*.ts`, beside the
  `next-env.d.ts` include the ticket's own comment explains. No `.next` directory exists, so the include matches nothing.

Neither affected a build, a typecheck or a run, so the disposal was a small follow-up under this ticket's owner rather
than a reopened acceptance row. `cc772ec` made it: `next` and its lockfile entry are gone (502 lockfile lines removed
with the package), the Next TypeScript plugin and the `.next/types`, `app`, `adapters`, `lib` and `components` includes
left `apps/web/tsconfig.json`, and the `test:system-acceptance` script whose driver required a `.next/BUILD_ID` left the
manifest beside them. That commit's own verification — `pnpm --filter @hepi/web typecheck` exit 0,
`node scripts/check-entrypoints.mjs` exit 0 (157 entries, 0 newly missing), `pnpm install --frozen-lockfile --offline`
exit 0, `node scripts/check-docs.mjs` exit 0 (437 files) — is in its message; the current tree is the evidence for the
absence: `git grep` finds no `next` import, no `next` entry in `apps/web/package.json` or `pnpm-lock.yaml`, and no Next
plugin or `.next` include in `apps/web/tsconfig.json`.

One thing did **not** go with it, and it is not this ticket's residue: an unselected set of `apps/web/e2e` drivers still
assert `.next/BUILD_ID` (no build produces it now) or spawn a `next` binary, so they fail on invocation. That set is the
pending e2e cleanup [docs/ci.md](../../../docs/ci.md) already records, with the count it states, and it is not Next runtime
residue — no production path imports the framework.

## Review notes

涉及 G3/G4/G5/G7/G8，见[架构审查](../review-notes.md)。其中 record 项不形成额外依赖。完成本票即更新能力矩阵与本票状态；全部 Blocked by 关闭后才开始。


## Pilo 精简研究追加（2026-10-19）

依据 [Pilo 对照研究](../../../docs/research/pilo-simplicity-review.md)，退役矩阵显式覆盖 apps/web/app、apps/web/adapters、apps/web/vendor 的每个存续调用者、脚本与测试；现存目录约445个追踪文件、81,132文字行，其中77,520行为vendor。数字仅为研究基线库存，不作为必须删除的行数目标。保留需要的协议/纯投影测试与上游来源、版本、许可记录，再删除无消费者实现。

追加精简工作由 [23](./23-remove-unused-settings-reader.md)、[24](./24-require-connection-backed-requests.md)、[25](./25-share-conversation-api-per-connection.md) 在本票后承接；不反向阻塞本票或新增第二套运行时。完整历史窗口继续由 [history-navigation](../../history-navigation-research/spec.md) 拥有。

## 后续计划（2026-10-19）

本票完成后解锁新增 [18](./18-web-logout-contract.md)、[19](./19-app-connection-recovery.md)、[20](./20-native-file-save.md)、[21](./21-read-and-navigation-recovery.md)，新功能以 22 另行验收。本票仍只依赖 16，不反向依赖 UX 新票。旧 e2e 的替换/删除与 SSH08 按 caller owner 协调，保留已验证的纯协议 seam，避免两次重建相同 driver。
