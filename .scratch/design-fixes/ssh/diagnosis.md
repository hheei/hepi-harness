# design-fixes / ssh — 分类与诊断（先分类，后实现）

Owner: worker（ssh 线）。范围：`packages/gateway/src/worktrees.ts`、`packages/gateway/test/worktrees.test.ts`。
来源：`.scratch/development-audit/design-gateway-review.md` §1（P2/fix）。父会话假设排名：sshExistingPaths 用了被删除的 profile cwd > Git fallback 指错仓库 > SSH transport 失败。
revision: `1758c1fb4479e9d4637a957857246c5998619d73`，工作区 dirty（含已授权 CLI worktree 修复）。未 commit/stash/reset/deploy/remote build/付费推理。

源码指纹（本文件结论对应）：
`a8f0451ca579e536bb77e39e16023f4536d6d81d912e910766e5142c3cbbb937  packages/gateway/src/worktrees.ts`
`cd7764cd10f61949218289f4f78224505f75f4782324a12d21759f191fd7eff5  packages/gateway/test/worktrees.test.ts`

## 1. Red 循环（真实 localhost sshd + 真实 git + 公开 POST /v1/worktrees）

回归测试（先写，未修前实测红）：
`packages/gateway/test/worktrees.test.ts` → `an SSH host whose configured root is a removed worktree still lists the project it belongs to`

场景（最小，全部元素 load-bearing）：profile 的 remoteRoot = 主 checkout 的 linked worktree `<repo>-worktrees/seed`；同一 registry 另注册仍在的主 checkout `main`。经 `main` 删除 seed，再 list `main` 与 list `remote-prod`（被删 seed 自身）。

未修前实测（命令 §4，log `.dev/verify/design-fixes/ssh/red.log`，exit=1）：

```text
✖ an SSH host whose configured root is a removed worktree still lists the project it belongs to (1742ms)
  AssertionError: {"ok":false,"code":"execution_failed"}
  500 !== 200
  at test/worktrees.test.ts:354
```

症状与审查一致：两个 list 都答 HTTP 500 `execution_failed`（不是命名 WorktreeResult）；直接 `SshWorktreeServer.execute` 抛 `outcome_unknown: the SSH host did not answer which checkouts exist`。主机在线、main 仍在；失败来自 runner 在已删除目录 `cd`（`packages/gateway/src/runner.ts` 的 confinement 脚本），不是 transport 失联。

### 探针（每条一变量；观测与推断分开标注）

| 探针 | 预测 | 证据性质 | 结果 |
| --- | --- | --- | --- |
| P1 `sshExistingPaths` 改用 caller 已解析目录作 cwd/root，其它不动 | 500 消失，两次 list 均 200 且内容正确 | **实测**：实现后 §5 绿测 + 原审查复现脚本重跑 | 命中 |
| P2 仅把 cwd 改成 `owner.root`（被删 seed） | 仍 500，因 root 本身不存在 | **源码/审查推断**，未单独跑：`runner.ts` 先 `realpath -- $root` 失败即 exit 126，必失败 | 推断成立，故修复不可用 owner.root |
| P3 Git fallback 指错仓库 | 应返回错误 repo 的 listing，而非 500 | **实测排除**：red log 显示失败发生在存在性检查（500/outcome_unknown），fallback 未产出错误 listing | 否 |
| P4 SSH transport 失败 | 应出现 `unreachable` 或连接错误 | **实测排除**：同一连接上 git 已成功作答；直调错误来自本地断言，非 ssh 255 | 否 |

## 2. 分类（先分类，后实现）

**判定：logic（既有 Worktree 模块内的局部实现遗漏），不是 architecture 重写。**

注意：分类依据不是“改动只落在内部 seam”，也不是 LOC。内部 seam 变更本身也可能是 design；这里判定为 logic 是因为**义务与所有权已经存在且正确，只是 SSH Adapter 选了错目录**：

1. **公开 Interface 义务已存在**：`WorktreeServer.execute` 必须以 ok 或**命名** failure 作答；实现把适配器异常漏出 `listEntries`，被 RPC 最外层降为通用 `execution_failed` → 实现违反既有契约。
2. **ownership/policy 已正确，无需移动**：`worktrees.ts` 已拥有“哪个目录属于本次操作”的策略——`listWorktrees` 先 `resolveRepository(host, host.root)`，失败时用 `inferMainRepository` 回退到主仓库，并在**该目录**里跑 `git worktree list`。策略无需新 owner，也无需调用方参与。
3. **SSH Adapter 违反同一策略**：`sshExistingPaths` 固定 `cwd/root = profile.remoteRoot`，即把“profile 初始目录永久存在”变成调用方义务。它拿到的是同一 host 记录里的另一个字段，而不是本次已解析目录。修法是让内部 seam 把**已解析目录**这一既有事实传给 Adapter——`sshGitRunner` 早已接受该目录，两个 Adapter 由此一致。这是补实现遗漏，不是新增策略。
4. **外部调用方义务零变化**：`worktreeRequest`、`WorktreeHost` 的 root 语义、registry/`workspaceOwner`、公开请求/响应、失败码集合全部不变。调用方不需要理解任何目录选择、错误归属或恢复顺序规则。
5. **若内部 Interface 无法表达所需事实，才是 localized seam design**：本次检查过——`WorktreeHost.existingPaths` 原来只有 `(paths)`，确实无法表达“在哪个目录问”，因此 seam 需增加一个参数。但该事实（本次运行目录）**已由同一模块的既有 `cwd` 变量持有**，且 git 侧 seam 已是同一形状（`git(cwd, args)`）。所以这是对既有内部 seam 的参数补全，闭合实现遗漏；不构成需要新 port/registry/owner 的 architecture 变更，也无需调用方义务变更。若当时发现该事实无处可得（例如目录只在调用方才知道），我会在此记录“局部 seam design 元素”，但实测不成立。
6. **删除测试**：删掉 `sshExistingPaths`，“远端路径是否还在”的规则会散到各调用方 → 有 Leverage，应修正而非删除，也不加装饰层。
7. **依赖类别**：git 与目录存在性 = local-substitutable（真实临时 repo）；SSH 命令 = remote but owned，已由既有 `SshRunner` 适配，Local/SSH 两个真实 Adapter 已存在 → 无需新 resolver port。

## 3. 最小连贯改动（既有 owner 内）

1. 内部 seam `ExistingPaths` 增一个既有事实参数：`(directory, paths)`；本地 Adapter 忽略它。
2. `listEntries` 把自己正在使用的 `cwd` 传给 `host.existingPaths`，并把适配器抛出的 tagged 失败交给同一 `hostFailure` 转换（与 `gitAnswer` 共用一处，避免第二套错误映射）。
3. `sshExistingPaths` 用传入目录作 `cwd`/`root`，与 `sshGitRunner` 同一约定。
4. 未动：create/remove/main 保护、dirty/force、公开协议与失败码、registry、调用方义务。无新 port/registry/helper 文件。

## 4. 证据命令与实测结果（exact exit）

| 命令（cwd=packages/gateway） | revision | exit | log |
| --- | --- | --- | --- |
| `node --test --test-name-pattern='configured root is a removed worktree' test/worktrees.test.ts`（未修） | 1758c1f + dirty(测试) | 1（红） | `.dev/verify/design-fixes/ssh/red.log` |
| 同上（修后） | 1758c1f + dirty | 0 | `.dev/verify/design-fixes/ssh/green.log` |
| `node --test test/worktrees.test.ts` | 同上 | 0，9 tests / 9 pass / 0 fail | `.dev/verify/design-fixes/ssh/suite.log` |
| `npx tsc --noEmit -p tsconfig.json` | 同上 | 0 | `.dev/verify/design-fixes/ssh/typecheck.log` |
| `node --test test/*.test.ts`（整个 gateway 包） | 同上 | 0，168 tests / 168 pass / 0 fail | `.dev/verify/design-fixes/ssh/gateway-suite.log` |
| `node .dev/verify/design-fixes/ssh/review-probe.mjs`（复用审查 §1 原复现脚本） | 同上 | 0 | `.dev/verify/design-fixes/ssh/original-repro.log` |

原复现脚本修后原始 stdout（同一路径/tmp 变量，非复述）：

```text
{"removeSeed":{"status":200,"body":{"ok":true,"value":{"removed":"/tmp/hepi-sshd-JBA56N/remote-root/repo-worktrees/seed"}}}}
{"afterMain":{"status":200,... "currentWorktreePath":"/tmp/hepi-sshd-JBA56N/remote-root/repo","worktrees":[{"path":".../repo","branch":"master","isMain":true}]},
 "afterSeed":{"status":200,... "currentWorktreePath":null,"worktrees":[{"path":".../repo","branch":"master","isMain":true}]}}
{"directAfter":{"ok":true,...}}   // 不再抛 outcome_unknown
```

未跑：完整 Web 套件（16 个既有失败保持不动，父会话负责）。未做 deploy / remote build / paid inference。
