# 01: 统一 Gateway 合同并迁移在线消费者

**Parent:** [Architecture consolidation spec](../spec.md)

**What to build:** 后端、Web 与 Gateway 对宿主请求和响应使用同一份数据声明；worktree、workspace、MCP 和 workbench 的现有调用继续工作。

**Blocked by:** None (can start immediately)

**Status:** resolved

## Acceptance criteria

- [x] 四组跨进程重复声明及 workbench 重复数据形状已由协议包 gateway 子路径统一；在线 producer 与 reader 均消费共同声明，旧重复声明退出。
- [x] 当前 producer 字段形状、状态码和响应语义保持；WorktreeListing 当前必填字段保持，旧宿主的兼容默认仍在 reader 边界。
- [x] 面板 DTO、unknown JSON 边界和未关联 operation 的 union 保留各自职责；不为去掉断言新建通用 RPC 或 schema 框架。
- [x] Gateway 依赖与 lockfile 同步，安装后 CLI 能解析和打包共同合同；发行 manifest 不引入 workspace 依赖。
- [x] 对应架构、workbench/MCP 指南和来源说明反映共同所有者。

## Verification seam

复用 workspace typecheck、Gateway/workbench/worktree/MCP 行为检查与安装后 CLI pack smoke；以实际调用结果和发行物为准。

## Comments

Claimed and resolved on worktree/branch `work/architecture-consolidation-01` (integration `integration/architecture-consolidation`, start `b49e44e`).

**What changed.** New `packages/protocol/src/gateway.ts` (subpath `@hepi/protocol/gateway`) declares the request/answer shapes of `/v1/workspaces`, `/v1/worktrees`, `/v1/workbench` and `/v1/mcp` once, copied field-for-field from the producers. The four producers now re-export from it under their existing names; the readers import it: `apps/server/src/server.ts` (its `HostRequest`/`WorktreeHostRequest` gone), `apps/web/adapters/mcp-surface.ts` (its seven `Host*` types gone), `apps/web/adapters/mcp-host.ts` (`HostAnswer` re-export), `apps/web/adapters/workbench.ts` (`FilePreview` is `WorkbenchFile`). `packages/gateway/src/workbench/contracts.ts` is deleted and its two consumers read the shared declaration directly, which also removes the `as WorkbenchChanges` assertion in `workbench/index.ts`. `McpScope`, `McpServerInfo`, `McpConfigRead`, `McpConfigFileInfo`, `ProjectTrust` are newly reachable from `@hepi/gateway`'s export surface, because they are a real consumer's contract that was never exported.

**Invariants held.** `WorktreeListing` stays five required fields; the `?? true`/`?? false`/`?? null` tolerance for an older deployment stays in `apps/server/src/server.ts:1405` (as `Partial<WorktreeListing>`) and `apps/web/adapters/durable-api.ts:429`. `McpHostResult.value` stays `unknown`; `McpConfigFileProblem.reason` stays `string`; `WorkspaceResult.value` keeps its four-member union with the inline fourth member. No route, status code, error code or JSON field changed; `@hepi/protocol`'s root export surface is untouched. The Web panel DTOs (`apps/web/lib/api-types.ts`) and the backend `/api/*` shapes stay where they are.

**Verification.** Raw logs in the primary checkout, `/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-01/`.

Ticket revision, committed unchanged as `a7aadb1` (checks ran on the same content before the commit, working tree clean after):

| Check | Result | Log |
| --- | --- | --- |
| `pnpm -r typecheck` | exit 0 | `typecheck.log` |
| `pnpm --filter @hepi/gateway test` | 184/184, exit 0 | `gateway-test.log` |
| `pnpm --filter @hepi/server test` | 285/285, exit 0 | `server-test.log` |
| `pnpm --filter @hepi/protocol test` | 45/45, exit 0 | `protocol-test.log` |
| `pnpm --filter @hepi/session test` | exit 0 | `session-test.log` |
| `pnpm --filter @hepi/client test` | exit 0 | `client-test.log` |
| `pnpm test:web:unit` | 111/111, exit 0 | `web-unit.log` |
| `pnpm --filter @hepi/web build` | exit 0 | `web-build.log` |
| `node apps/web/e2e/ux-mcp-surface.mjs` | passed | `web-e2e-mcp.log` |

Merge result, committed unchanged as `6a2168e` (integration tip merged in, `exports` conflict resolved; the checks ran on that same working tree before the commit): `pnpm -r typecheck` 0; gateway 184/184; server 285/285; protocol 47/47 (ticket 02's `mcp-secrets` suite included); session 0; client 0; web unit 109/109; web build 0; `pnpm --filter @hepi/client build && pnpm --filter @hepi/client smoke:pack` 6/6 (the installed tarball serves `/v1/mcp`, `/v1/worktrees`, `/v1/files`); `node --test scripts/release-plan.test.mjs` 3/3; `ux-mcp-surface.mjs` passed. Logs carry the `-postmerge` suffix; the pack smoke and the release-plan test were run on this revision only. Web unit drops 111 → 109 because ticket 02 moved `mcp-secrets.test.mjs` into `@hepi/protocol`, where the count is 45 → 47.

**Failures on the merged tip, measured against a pinned baseline.** `caf6a31` — the last commit before this effort — checked out detached and clean (`git worktree add --detach .dev/baselines/caf6a31 caf6a31`; `git status --porcelain` empty) with its own `pnpm install --offline --frozen-lockfile` (exit 0) and its own `pnpm --filter @hepi/web build` (exit 0). Not a stashed or dirty tree.

- `ux-worktree-picker.mjs` stops at scene 5 with a driver `TimeoutError`. The pinned baseline reaches the same 20 checks — byte-identical check list once the temp directory path is normalised — and stops at the same point. Ticket tip, tip rerun and pinned baseline: 20 ok + driver timeout each (`web-e2e-worktree.log`, `web-e2e-worktree-rerun.log`, `baseline-caf6a31-worktree-picker.log`). Not caused by this ticket.
- One full-suite run on the merged tip reported `tests 184 / pass 182 / fail 2` and printed one failing test, `packages/gateway/test/sshd-fixture.test.ts:105` "a stopped fixture leaves no daemon of its own listening and no process of its sandbox". **That run's raw log is lost** — the rerun wrote the same path — so the name above is what the run printed, not a file you can still read; it is not part of the evidence below. What is evidenced: the same test is 4/4 in three isolated runs on the tip (`tip-sshd-isolated-run{1..3}.log`) and 4/4 in three isolated runs on the pinned baseline (`baseline-caf6a31-sshd-run{1..3}.log`); the full suite is 184/184 on the merged tip (`gateway-test-postmerge.log`, `gateway-test-postmerge-run2.log`) and 184/184 on the pinned baseline (`baseline-caf6a31-gateway-suite-run{1,2}.log`). So it did not reproduce on the baseline *or* the tip under any preserved run; the surviving evidence supports "not a ticket finding", not a pinned pre-existing failure. This suite's teardown tests have a recorded history of exactly this failure (`/home/developer/Documents/dev/hepi-harness/.dev/verify/sshd-fixture-teardown/`), and a sibling ticket's preserved run shows a different member of the same suite flaking the same way (`consolidation-02/gateway-test.log`: 183/184, `terminal.test.ts` "a resize reaches the shell..."). Recorded, non-blocking; nothing in this ticket's diff touches either file.

**Correction.** An earlier note here reported the worktree-picker and sshd results "on the unchanged baseline", where that baseline was produced by `git stash push -u` on this shared checkout and `git stash pop` after the run. That is not a baseline and the claim is withdrawn. `git stash` is shared across every worktree of the repository, so the entry it used was not this run's to own and another worktree could have clobbered it; the run happened in the primary checkout, which is not a pinned revision checkout; and the checkout's `apps/web/.next` still held the build made from this ticket's source, so the browser driver served a ticket build over `b49e44e` sources — the run measured a mixed tree, not a revision. Its log is kept under the name that says so, `web-e2e-worktree-stashed-tree-unpinned.log`, and it is evidence for nothing. The pinned `caf6a31` worktree above reaches the same conclusion independently: its own install, its own build, 20 identical checks, the same driver timeout.

The `e2e-baseline` entry that command created is gone, and the five entries `git stash list` holds now (`003071e` ×2, `parent-wip-preserve`, `parent-wip-preserve-2`, `885186a`) carry subjects that belong to other work and were not touched by it; only the entry the command created was popped. The ticket's own checkout is clean and the correction sits on top of the merge `6a2168e`.

**Not done, deliberately.** No new tests: the change is type-only, so the existing seams (`packages/gateway/test/{workspaces,worktrees,mcp,startup,workbench}.test.ts`, `apps/server/test/worktree-picker.test.ts`, the pack smoke) already cover the behaviour, and §7.2 of the research says so. `EXPOSURES` stays written twice (research §4.6: record, not share).

**Manifest overlap with ticket 02.** Both tickets edit `packages/protocol/package.json`'s `exports`: this one adds `"./gateway": "./src/gateway.ts"`. Ticket 02 adds `"./mcp-secrets"`. The coordinator merges the two keys; neither ticket touches the other's.

## Integration notes

协议根 API 保持。此票是跨包机械搬迁的完整切片，包含共同声明和全部当前在线消费者，不单独交付一个无人使用的类型文件。
