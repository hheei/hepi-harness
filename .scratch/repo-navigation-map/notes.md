# 目录导航评审记录(F2/F3)

- 来源:仓库文件架构审计 `518bc7c6` 的 F2(UI 目录平铺)与 F3(Web e2e 与宿主倒挂),见 `file-architecture` 审计结论。
  本文件只记录**未做**的部分与重开条件,不用作承诺。
- 本轮已交付:只改文档。[Developer guide](../../docs/developer-guide.md#directory-map) 增加了 `packages/ui/src` 与
  `apps/web/e2e` 两个子目录的布局说明与计数。没有移动文件、没有改 import、没有改脚本。

## 为什么本轮不搬文件

两项都属于 [review policy](../../docs/agents/review-policy.md) 的 `record`:导航摩擦已在文档层面消除,而搬迁的收益是阅读体验,
代价是跨工作区导入改写、脚本与 CI 选择面、以及 `docs/verification.md` 里 117 处绑定 revision 的历史证据。没有正常使用中的
材料性失败作为依据,不构成阻塞交付的改动。

## F2:`packages/ui/src/lib` 特性簇(延后)

可行,但一次只做一个簇。候选簇与代价(计数为当前源码,非测试文件):

| 簇 | 文件数 | 包外消费者 | 备注 |
| --- | --- | --- | --- |
| `mcp-` | 10 | `@hepi/ui/lib/mcp-panel`、`lib/mcp-import` 是显式 `exports` 子路径,包外按子路径导入 | 改 `exports` 会动 gateway 的运行时依赖(fs F1),先做 F1 |
| `file-` | 8 | 仅包内相对导入 | 最干净的一簇 |
| `session-` | 7 | 仅包内相对导入 | 与词汇映射(F4)重叠,改名容易与 `@hepi/session` 混淆 |
| `chat-` | 5 | 仅包内相对导入 | 5 个,收益最小 |
| `provider-` | 4 | 仅包内相对导入 | 小,但 `docs/architecture.md`、`docs/migration-status.md` 有路径引用 |
| `terminal-`、`lifecycle-`、`connection-` | 3 / 3 / 3 | 仅包内相对导入 | 各 3 个,不必分组 |

机械可行性已确认:`exports` 的 `"./lib/*": "./src/lib/*"` 通配对多一层仍解析,`tsconfig` 的 `@hepi/ui/*` 路径映射不用改,
`pnpm --filter @hepi/ui test` 用 `find src -name '*.test.mjs'` 递归枚举(不用修改),同目录测试随文件一起移动即可。
**重开条件**:真要动时,先做 `file-` 一簇并单独一个提交,验证 `pnpm --filter @hepi/ui test`、
`pnpm --filter @hepi/web typecheck`、`pnpm test:web:unit` 与 `pnpm check:entrypoints` 全部通过再考虑下一簇。

不要做:`lib` 的 65 个测试搬到 `test/`;全量前缀重命名;`session-` → `conversation-` 改名(F4 明确不建议)。

## F3:`apps/web/e2e` 主题分组(延后,风险更高)

已确认的事实(当前源码):

- `apps/web/e2e` 113 个文件 = 73 `*.mjs` + 25 `*.fixture.tsx` + 15 `*.fixture.css`;`ux-` 前缀 104 个。
- `apps/web/package.json` 68 条脚本,62 条 `test:*`,指向 57 个不同 e2e 文件,全部存在。
- CI 只选中 4 个 driver:`ux-chat-scroll.mjs`、`ux-references-acceptance.mjs`、`ux-mcp-acceptance.mjs`、
  `ux-provider-connection-acceptance.mjs`(`.github/workflows/ci.yml`);其余见 [CI 边界](../../docs/ci.md#what-this-workflow-does-not-verify)。
- 32 个 `*.mjs` 仍 spawn 工作区已不存在的 `next` 二进制:这批先失效,**不是**搬迁对象。
- `docs/` 有 163 处 `apps/web/e2e` 路径引用,其中 `docs/verification.md` 117 处绑定历史 revision。

为什么不动:改目录要同时改 68 条脚本里的路径、4 个 CI driver 步骤、163 处文档路径,而 `pnpm check:entrypoints` 只验证
脚本里点名的文件仍在。选择面太大,一次做不完,分批做会让中间态既有旧路径又有新路径。

**建议的分阶段方案**(每阶段独立可交付):

1. 先量化:把 CI 之外的 e2e 分成"仍能跑"与"依赖 `next` 已失效"两组,失效组按 [review policy](../../docs/agents/review-policy.md)
   给出功能处置(退役或修复),而不是搬家。这一步产出清单,不改目录。
2. 只对 CI 4 个 driver 收拢入口:在 `apps/web/package.json` 增加 `test:browser` 聚合脚本,内部仍指向现有路径。
   同时评估给 `apps/web` 补 `test` 脚本是否会与 `scripts/test-web-unit.mjs` 重复调度——先确认再补。
3. 若第 1、2 步稳定,再按 chat/history/files/terminal/settings 分组,一次一个主题,每组同步改脚本、CI 与文档路径,
   并重跑 `pnpm check:entrypoints`、`pnpm check:docs` 与受影响的 `test:*`。

不要做:批量重命名 104 个 `ux-` 文件;把整批系统 e2e 搬进 `packages/ui`;为改名而改 68 条脚本。
