# 07 — 迁移历史、context 与认证媒体资源

Type: implementation
Status: resolved — merged into `integration/client-app` at `644ac55` (`dc1cfef` code, tested at `dd51a06`, docs at
`fd6e810`), re-checked on the merged tree; the native and platform evidence this ticket never claimed stays 04/16's
Blocked by: [05](./05-shared-ui-routing-and-scope.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

Web/App 用户能查看完整历史和图片/长文本，不受相对 URL 或 bearer 限制。

## Scope

统一解析 Gateway 资源地址，接通历史分页、thinking/text/tool-result images 和 context inspection。图片等有界展示资源以认证 fetch→blob 呈现；回收策略与连接作用域一致。保留协议原有 URL/DTO 及投影事实，不在入口再拼历史模型。

## Acceptance

- [x] 历史分页、延迟长文本/thinking、工具图片与 context 读取都在 cookie/bearer 下通过。
- [x] 资源不会请求 Tauri 自身 origin；跨 profile/会话切换和卸载释放 blob，旧资源不能写入新 scope。
- [x] 401/403、过大、已删除资源有命名 UI 结果；无凭证 URL、宽权限转发或 base64 重新包装。
- [x] session/revision/window/oversize 既有合同和唯一事实投影保持。
- [x] 展示资源大小、保留历史与 cache 有明确上限/释放条件；同一已接纳 snapshot 复用不破坏分页/compaction/acquisition。流内 JSON 往返作为测量候选，优化时沿既有 source seam 同步更新消费者、移除字符串桥，不另建 parser。

## Verification

历史窗口与延迟资源端到端回归；cookie/bearer 和 profile 切换资源失效场景。

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；新增问题依照[review policy](../../../docs/agents/review-policy.md)判断实际影响。

## Review notes

涉及 G6/G7，见[架构审查](../review-notes.md)。其中 record 项不形成额外依赖。完成本票即更新能力矩阵与本票状态；全部 Blocked by 关闭后才开始。

## Answer

### 现在可用的行为

**Gateway 入口提供读块地址。** 历史帧里的重内容以读块呈现：长文本/thinking 是有界预览，图片是地址而不是字节。协议生成的地址是 `/api/sessions/:id/entries/:entryId/text|thinking|tool-result-image`（`packages/protocol` 的 `textUrl`/`thinkingUrl`/`toolResultImageUrl`），入口现在在 cookie/设备 bearer 下直接提供它们。这是入口**唯一**的路径改写（`sessions/:id/entries/:entryId/<block>` → Backend 自己的 `conversations/:id/entries/:entryId/<block>`），不解码、不重投影、不新增历史模型。

**有界读块（Backend 拥有）。** `apps/server/src/read-block.ts` 是唯一实现：

- 文本/thinking 默认最多 256 KiB UTF-8，回答 `offset`/`totalBytes`/`truncated`/`nextOffset`；调用者可要更少（`limit`），不能要更多。沿 `nextOffset` 继续拼接后与提交内容逐字节相同 —— 界限在回答上，不在可达性上。
- 图片支持 `Range`：`206` + `content-range`，越界 `416`，整读也声明 `accept-ranges: bytes`。区间只解码它触及的 base64 组，因此 10 MiB 截图的窗口只花一个窗口的成本，不必解码整图。`readBlockImage` 的字节数也改为算术而非解码。

**客户端资源读取（client 拥有）。** `packages/session/src/resources.ts` 每个连接作用域一个 reader：

- `resolve()` 把线缆地址解析到**连接自己的 Gateway origin**；其他 origin（含 `blob:`）在发请求前就拒绝 —— 这正是原生壳需要的，否则相对路径会去问 App bundle 要会话历史。
- 凭证从不进入 URL：cookie 分支用 `credentials: "same-origin"` 由浏览器自行附带，bearer 分支显式设置 `authorization`。
- `text()` 跟随分页拼出整段文本；`image()` 返回**租约**：同一地址的多位读者共享一个 blob，最后一个释放时才 revoke；作用域最多保留 24 个 blob / 32 MiB、32 段文本 / 16 MiB，按最近最少使用回收；`dispose()` 撤销全部并拒绝后续读取，`dispose` 之后到达的响应被丢弃而不是留在下一个作用域里。
- 命名拒绝：`unauthorized`、`forbidden`、`not_found`、`oversize`(413/415)、`unavailable`(5xx/传输失败)、`disposed`。

**消费者沿同一 seam 同步更新。** 因为读块现在默认有界，既有消费者在同一 seam 上改为跟随续页：`apps/web/lib/deferred-text.ts`（`loadDeferredText`）与 `apps/web/components/MessageView.tsx`（`loadThinkingContent`）。没有新增 parser，也没有第二套历史投影。

### 受测 seam

`packages/gateway/test/ingress-resources.test.ts`（10 个用例）是真实 HTTP 打在真实 Backend + 真实 client ingress 上：

1. 延迟文本在入口按有界页提供，续页拼接后逐字节等于提交内容，`totalBytes` 陈述整段大小。
2. client reader 把线缆地址解析到连接 origin、拼出整段文本、每页都来自该 Gateway、URL 里没有凭证；外部 origin 与 `blob:` 在发请求前被拒（并断言未发出请求）。
3. 工具图片成为 blob 租约：blob 提供完全相同的字节，同址共享，最后一个租约释放时 revoke，之后 URL 不再可解析。
4. 图片读块支持 `Range`（`206`/`content-range`/`accept-ranges`/`416`/整读 `content-length`）。
5. 设备 bearer 读到相同的块；帧里被策略拒绝的 blockIndex 在读块处同样 `oversize`。
6. thinking 读块在入口可达，恢复的是预览替换掉的整段文本。
7. 每个拒绝都有名字（无凭证、未声明 origin、不存在的 entry、Backend 已关闭）。
8. 已 dispose 的作用域撤销其 blob、丢弃迟到响应、不把任何东西写进下一个作用域。
9. 保留图片预算有界并按 LRU 回收，且「重复读取同一 blob」算一次使用（三次读取、两个 blob 的预算下被回收的是中间那个）。
10. 分页与窗口仍是 Backend 自己的：入口转发 Backend 的页（与直连 Backend 的回答逐字段相同，cookie 与设备 bearer 逐字段一致），读取资源不改变窗口/revision/history 事实。

### 证据

| 检查 | 命令 | revision | exit | 日志 |
| --- | --- | --- | --- | --- |
| 本票新测试，10 个用例 | `node --test packages/gateway/test/ingress-resources.test.ts` | `3965b22` + 本票工作树 | 0 | `.dev/verify/2026-10-17T18-13-15-558Z-client-app-07/ingress-resources-test.log` |
| 入口凭证回归，12 个用例 | `node --test packages/gateway/test/ingress.test.ts` | 同上 | 0 | `.dev/verify/2026-10-17T18-13-15-558Z-client-app-07/ingress-regression.log` |
| gateway 全套，299 个用例 | `node --test packages/gateway/test/*.test.ts` | 同上 | 0 | `.dev/verify/2026-10-17T18-19-32-949Z-client-app-07-gateway/gateway-suite.log` |
| server 全套，448 个用例 | `node --test apps/server/test/*.test.ts` | 同上 | 0 | `.dev/verify/2026-10-17T18-19-32-949Z-client-app-07-gateway/server-suite.log` |
| 历史/图片/读块回归，27 个用例 | `node --test apps/server/test/history-text.test.ts apps/server/test/history-window.test.ts apps/server/test/submission-images.test.ts apps/server/test/conversation-read.test.ts` | 同上 | 0 | `.dev/verify/2026-10-17T18-13-15-558Z-client-app-07/server-history-regression.log` |
| session 套件 | `node --test packages/session/test/*.test.ts` | 同上 | 0 | `.dev/verify/2026-10-17T18-13-15-558Z-client-app-07/session-suite.log` |
| Web 延迟文本加载器，2 个用例 | `node --test apps/web/lib/deferred-text.test.mjs` | 同上 | 0 | `.dev/verify/2026-10-17T18-13-15-558Z-client-app-07/web-deferred-text.log` |
| typecheck | `pnpm --filter @hepi/server --filter @hepi/gateway -r typecheck` | 同上 | 0 | `.dev/verify/2026-10-17T18-13-15-558Z-client-app-07/typecheck.log` |
| 三个入口套件合并后，30 个用例 | `node --test packages/gateway/test/ingress-resources.test.ts packages/gateway/test/ingress.test.ts packages/gateway/test/ingress-conversation.test.ts` | merge 后 `integration/client-app` 的 tip 已并入 | 0 | `.dev/verify/2026-10-17T18-29-00-586Z-client-app-07-merged/ingress-all.log` |

最终 revision（`integration/client-app` 的 tip `0e8c34a` 已并入后重跑；本轮修正了「重复读取同一 blob 不算使用」这一处不变量）：

| 检查 | 命令 | revision | exit | 日志 |
| --- | --- | --- | --- | --- |
| 本票新测试，10 个用例 | `node --test packages/gateway/test/ingress-resources.test.ts` | `70537e9` + 本轮改动 | 0 | `.dev/verify/2026-10-18T-ticket07-final/ingress-resources.log` |
| 入口凭证回归，12 个用例 | `node --test packages/gateway/test/ingress.test.ts` | 同上 | 0 | `.dev/verify/2026-10-18T-ticket07-final/ingress.log` |
| 会话切片，8 个用例 | `node --test packages/gateway/test/ingress-conversation.test.ts` | 同上 | 0 | `.dev/verify/2026-10-18T-ticket07-final/ingress-conversation.log` |
| session 套件，34 个用例 | `node --test packages/session/test/*.test.ts` | 同上 | 0 | `.dev/verify/2026-10-18T-ticket07-final/session.log` |
| 历史/图片/读块回归，39 个用例 | `node --test apps/server/test/history-text.test.ts apps/server/test/history-window.test.ts apps/server/test/submission-images.test.ts apps/server/test/conversation-read.test.ts` | 同上 | 0 | `.dev/verify/2026-10-18T-ticket07-final/server-history.log` |
| Web 延迟文本加载器，2 个用例 | `node --test apps/web/lib/deferred-text.test.mjs` | 同上 | 0 | `.dev/verify/2026-10-18T-ticket07-final/web-deferred.log` |
| typecheck，三个包 | `pnpm --filter @hepi/server --filter @hepi/gateway --filter @hepi/session -r typecheck` | 同上 | 0 | `.dev/verify/2026-10-18T-ticket07-final/typecheck.log` |
| 选定检查 | `pnpm verify:changed --base=integration/client-app` | `70537e9`（dirty：`docs/chat.md`、`packages/gateway/test/ingress-resources.test.ts`、`packages/session/src/resources.ts`） | typecheck、`changed-test`、`web-unit` 均 0；`check:docs` 1（既有的 12 个 `.dev`/`.pi` 断链） | `.dev/verify/2026-10-17T18-57-13-113-verify-changed/` |

**文档。** 客户端读取合同写在 [chat.md 的读块一节](../../../docs/chat.md#bounded-history-older-pages-and-the-read-blocks)，入口路由表与有界/命名拒绝在 [Client ingress](../../../docs/client-ingress.md#history-context-and-media-resources)。

### 未声明的

- 未在真实 Tauri/WebKitGTK 或移动目标上验证（桌面壳的构建与打包由票据 04/15 单独验证；Android 仍无 SDK）。这里证明的是协议与公开 seam 的合同，不是平台证据。
- 未测量流内 JSON 往返（P2）。本票只记录它是候选；本票没有移除字符串桥，也没有新增 parser。
- 未做 UI 呈现：共享 React 工作台属票据 05，本票交付的是它要用的资源合同与命名拒绝。

### 已知记录项（非阻塞）

- 文本读块的 `offset` 以字符计（不是字节）：字符偏移才能在 JS 字符串里命名位置而不会切开码点，字节界限由 `cutAtByteBudget` 施加。代价是一个超大文本的续页需要先切出前缀才能量字节，这与 `conversation-read.ts` 已有的「一条 entry 整体解码」限制同源。
- `Range` 只解释单区间形式；多区间或非字节范围头部按「整块」回答（RFC 9110 允许），没有引入 multipart 应答。
