# 09 — 缺文件与截断预览的真实反馈

Type: implementation
Status: integrated on `main` at `3c7fbeb` (parent `70d9a6d`, 2026-10-20) — the missing-file vocabulary, the honest
preview bound and the viewer's classified recovery are implemented, tested at their own seams and documented. Integration
is verified by ancestry, not by the branch name: `git merge-base --is-ancestor 3c7fbeb main` exits 0 in this checkout,
and the commit is the one this ticket's Evidence section measured.
Blocked by: [04](./04-system-acceptance.md) (resolved, integrated `0994ffe`), [client-app 17](../../client-app/issues/17-retire-next-and-transition-paths.md)
(complete 2026-10-19). Unblocked as of 2026-10-20; no missing-file vocabulary, no preview-truncation feedback and no
retry/refresh control existed on the line this ticket started from (`0a3d065`).
Parent spec: [SSH Remote Workbench](../spec.md)

## Outcome

local／SSH 中已删除或移动的文件显示缺失结果；文本预览被限制时说明只显示部分内容，不显示误导性的总量完成。

## Scope

沿用 01/02 的 Gateway filesystem/workbench 与 files-surface seam，为普通 ENOENT 选择最小命名缺文件合同并贯穿协议、HTTP 与 FileViewer。离线、权限拒绝、一般操作失败保持不同含义。200 KiB workbench 预览预算与 10 MiB DOCX 原始字节上限保持各自语义，不为显示进度加载全文件。

## Acceptance

- [x] 文件列出后被普通删除/移动，local/SSH 打开时得到明确 not-found/unavailable，而非泛用 500 或空成功；不暴露宿主路径。
- [x] 文件读错误的 owner 分类并传递原因；UI 提供重新读取/刷新目录/返回，不向上层散布特判。
- [x] 截断文本分别表示实际已显示字节与总大小；总量未知则显示未知，不伪造分母或 100%。previewOnly 状态不提供无效 Load more。
- [x] DOCX 继续走有界原始字节抽取且显示真实限制；既有成功预览、非 repo Git 与 offline 行为回归通过。
- [x] 用普通临时文件生命周期验证，不新增有关绕过路径/权限控制的探测；沿用已记录的边界证据。
- [x] workbench/SSH owning guide 与 migration-status 在实现同改；exact command、SHA、exit、log。

## Evidence (2026-10-20, worktree `closeout-ssh-09`, base `0a3d065`, rebased onto `70d9a6d`)

- 缺文件词汇：`WorkbenchFailureCode` 加 `not_found`（`packages/protocol/src/gateway.ts`），Gateway `WORKBENCH_CODES`
  同步；`GatewayWorkbench.execute` 以 `isWorkspacePathMissing`（本机 `ENOENT` 与远端 helper 的 `not_found` 是同一事实）
  分类，两宿主一致（`packages/gateway/src/workbench/index.ts`、`workspace-paths.ts`）。`files-surface.ts` 把它答成
  `404`，文案不含宿主路径。`workbench.test.ts` 新案走真实临时文件生命周期（写入→读取→删除→再读），
  `ingress-ssh-workbench.test.ts` 对 local 与 SSH 的 `gone.md` 都断 404/`not_found` 并排除 `/home/`、`/srv/`。
- 分类 owner：`packages/ui/src/lib/file-read-failure.ts`（missing / denied / offline / failed，status+code 决定，
  surface 原句只进 `detail`，永不渲染）；面板 `components/FileReadFailurePanel.tsx` 依原因只给可行的动作——
  Retry（offline/failed）、Reload folder（missing，接到 AppShell 自身的 `handleExplorerRefresh`）、Close（该 tab）。
  `FileViewer` 只在抛出的 seam 分类，特判不下传到 AppShell。
- 预览边界：`FilePreviewResponse` 以 `shownBytes` + 可空 `size` 取代 `nextOffset`，`FilePreviewLimitNotice.tsx` 只说这两
  个数（无分母伪造、无进度条、无 Load more）；`file-seam` 去掉 offset 参数，gateway 对 `offset>0` 保持命名 501，
  200 KiB 预算与 DOCX 10 MiB 语义未动。
- Exact commands（同一 revision，全部 exit 0）：`pnpm -r typecheck`；`packages/gateway` `pnpm test`，另
  `node --test test/workbench.test.ts test/ssh-workbench.test.ts test/startup.test.ts`（24/24）与
  `node --test test/ingress-ssh-workbench.test.ts`（6/6）；`packages/protocol` `node --test test/*.test.ts`（67/67）；
  `packages/ui` `node --test $(find src -name '*.test.mjs')`（364/364，含新增 `FileReadFailurePanel.test.mjs`）；
  browser `node apps/web/e2e/ux-file-failures.mjs`（Reload folder 点击计数=1、宿主路径不上屏、
  “Showing the first 200.0 KB of 3.0 MB”、无 Load more）、`ux-docx-preview.mjs`、`ux-file-surfaces.mjs` 全绿。
- 同改的 owning guide：`docs/workbench.md`（预览两数与无续读、五类拒绝原因、失败旅程段落）与
  `docs/migration-status.md`（`not_found` 404；ticket 03 记录的两项限制标记为已闭合）。
- Rebase 后复测（同 commit、同一源码，`git status` 干净）：`pnpm --filter @hepi/ui typecheck` exit 0；
  `node apps/web/e2e/ux-file-failures.mjs` 25 checks 全绿 exit 0。日志
  `.dev/verify/rebased-ssh09/ui-typecheck.log` 与 `.dev/verify/rebased-ssh09/ux-file-failures.log`（各含 sha/dirty/
  command/exit 头）。冲突面只有 `ux-file-failures.fixture.tsx`、`AppShell.tsx`、`docs/migration-status.md`，两侧意图
  各自保留：fixture 继续走 23–25 的 `workbenchConnection`/`connection.api` 装配，AppShell 的 `onReloadFolder`/
  `onClose` 与 23–25 的 connection 改动共存，migration-status 的行同时保留 references 03 的 `0acf499` 记录。

## Scheduling and evidence

[UX研究文件部分](../../ux-closeout-research/03-workbench-files-ssh-terminal.md)、[执行图](../../ux-closeout-research/spec.md)。这是既有范围验收后的新增 UX 票，不重开已交付 01–03/05，不把原来记录的缺文件 vocabulary 限制伪装成已解决。08 核对现有语义，09 才改变缺文件词汇/展示。
