# 让解法减少状态与分支

范围：对 architecture-routes 已记录问题评估具体解法。2026-10-14；源码为 master 1758c1f + 已有未提交修复。此次不改产品代码。函数名为建议名，不表示已实现。

依据 codebase-design、ponytail-review 和已核对源码：新 Module 应接走真实调用者必须知道的知识。能靠数据表示、平台能力或删除无效路径解决，就不新增策略层。

| 项目 | 推荐解法 | 可删内容 / 必须保留的复杂性 |
| --- | --- | --- |
| 终端 SSE | 同步发送，超过待写预算断开该消费者，复用 reconnect/replay | 删两套 queue/wake/消费循环；保留 replay、cursor、清理、heartbeat、不同 exit 语义 |
| 快照缓存 | 每条保存一次计量结果，维护总量 | 删全缓存重复 stringify；保留 LRU、TTL 和所有删除路径统一记账 |
| Gateway 装配 | 一个 startGateway(resolvedSettings) 拥有构造、listen、close | 两入口只读配置；删两套能力装配知识 |
| 快照旁证 | 一个拥有 acceptance 的接收入口，集中发布共同事实 | 删重复发布；保留 HTTP cache/prefix 与 SSE live rendering 的真实区别 |
| 历史渲染 | 完整 turn 描述 → 窗口 → JSX | 删全量 JSX 后 slice；动态高度、锚点、搜索与展开状态确有成本 |
| trust 控件 | 只读状态与主机端操作说明 | 删注定 501 的写动作及 busy/error 分支 |
| capture | chunks + 已捕获 UTF-8 bytes，最终 join | 删每 chunk 前缀重算；保留字符完整截断、spill、truncated 合同 |
| wire 类型 | protocol 导出公共原始帧，Web Adapter 转显示形状 | 删同义声明；显示类型不强行合并 |
| 能力探测 | 明确 501 unsupported 才是 unavailable，失败仍是 unknown | 保留 boolean/null 就能表达，不加全局注册表或隐式重试 |
| journal / catalogue / 搜索 / SSH 往返 | 保持现状，按实际使用证据重访 | 不因微基准新增调度、索引或跨主机缓存 |

## 1. 终端：删除异步缓冲

当前两个 SSE 方法各有 queue、wake、等待循环和关闭标记。TerminalSessions.subscribe 的 listener 为同步 void，subscribe 同步返回 replay。一个慢 tab 不应阻塞其他读者或共享 shell。

比较三个解法：await drain 会把积压搬到 queue；缓冲合并或丢帧需要维护 offset、reset 与 exit 顺序；超预算断开消费者则复用现有连接结束、120 s reconnect lease 和有界 replay/reset。推荐第三种。

现有 #writeTerminalFrame 继续负责事件格式；所有终端字节，包括 heartbeat，经过同一个私有写入点：编码一次，检查 response.writableLength + 本帧 UTF-8 bytes，超过预算则 destroy，否则同步 write。write 返回 false 表示已接收但超过 highWaterMark，不等于帧丢失；字节预算另有明确上限。

直播 listener 直接发送，不排队。初始化在同一同步阶段完成订阅、headers 和 replay；首次 replay 先于后续 live event。连接 close 清理 timer 和 subscriptions。单会话 exit 结束连接，fan-in 的某个 exit 不结束其他会话。断开消费者不杀 shell。若路由必须等到连接结束才返回，等待 response close 即可，与流控分开。

这是现有私有 Seam 的加深。无需 StreamScheduler、AsyncQueue 或可配置策略框架。

须验证两条 HTTP 路由的正常输出、replay/cursor、heartbeat、慢消费者断开清理、另一消费者继续和恢复 reset。阈值需覆盖合法大帧及 fan-in 初始 replay；多 tab 聚合 replay 可能很大，草率照抄 1 MiB 会导致反复 reconnect。永久慢消费者只能得到具名 reset，不能承诺保留全部历史输出。这是用户可见取舍。

## 2. 缓存：改数据表示，保持现有 Interface

保留 get/set/delete/clear，内部保存：

```ts
type Entry = { snapshot: SessionViewSnapshot; units: number };
type Store = { entries: Map<string, Entry>; totalUnits: number };
```

units 沿用 JSON.stringify(...).length 的 UTF-16 code unit 合同，常量与注释改用该单位。每条写入只计量一次；replace、expire、delete、evict 通过同一个内部 remove 减账，clear 同时清零。get 的 LRU touch 仅重新插入同一 Entry。

缓存条目须按不可变快照使用；实施前确认调用者不修改已缓存对象。不用平行 sizes Map 拼补，也不新增通用 WeightedLRU。新条目序列化仍为 O(自身大小)，总量维护才是 O(1)。不借这次整理改变容量策略。

沿用 public get/set 测试覆盖 replace、TTL、预算逐出、oversize 和 clear，无需再叠加内部记账测试。

## 3. Gateway：共享一次装配

把现有启动实现移入 @hepi/gateway 的可导入入口；CLI 和 main 把配置解析成同一个 resolvedSettings，再调用 startGateway。返回沿用 RunningGateway 的 origin/port/closed/close。

startGateway 拥有 registry、journal、master、runner、各能力、listen 和关闭顺序。local/ssh 判别配置让 profiles 与本地 seed 互斥；plain runner 与 shared runner 用途继续显式。能力差异在装配处选择一次，业务方法不检查 mode。

先对齐 heartbeat 与 SSH workspace 校验，保留两入口既有配置默认与状态目录。配置读取、信号处理和 CLI 展示仍归入口；shared close 保证 master 最后关闭。

不新增 AbstractGatewayFactory、plugin registry 或 DI container。两个真实入口共享一份装配知识，Local/SSH 保持真实 Adapter。

## 4. 旁证：一个接收入口

共同字段归一成 snapshot statement；唯一接收入口先 fold，再对 accepted statement 发布 data/historyHead/failure/leaf 等共同事实。拒绝后立即结束这条 statement 的发布，不另比较 revision。

入口拥有接受决策与共同发布，不只是把 setter 挪进 helper，让调用者继续维护守卫。HTTP 特有 prefix/cache/checkpoint、wrapper reconnect 与 SSE 特有 liveTools/liveMessage 保持明确的来源分支；它们不是同义副本。独立 agent-state 查询仍有自己的获取和排序。

先集中共同发布，保持纯 fold 无 I/O。后续若字段可从已接受事实直接派生，再删除对应 React state；当前不把整个 SessionData 或全部 hook 状态塞入 lifecycle View。branded token、第二个 reducer、回调门都不能自行消除拥有者重复。

验收以乱序、同 revision remount、prefix 保留和来源特有行为为准。当前没有失败，这是整理候选。

## 5. 历史：先选 turn 再渲染

ChatWindow 先构造所有 JSX 再 slice，visibleCount 又至少增长到 messages.length。把已有 user/process/final answer 分组表示成稳定 key + 消息范围的 turn 描述，再只为窗口内 turn 创建 MessageView。

渲染窗口与后端分页/已加载历史是两个状态：旧页改变数据范围，视口决定挂载范围。完整 turn 可避免切开 toolCall/toolResult、ProcessDetailsGroup 和 final answer。单个 turn 很大时仍可能很重，是该粒度的限制。

动态高度需成熟虚拟列表实现或经验证的窗口方案；固定行高无法可靠覆盖 Markdown、图片和展开结果。须验证 prepend 锚点、tail follow、search entry 定位、minimap、展开状态跨卸载、copy/edit 原文。当前 ProcessDetailsGroup 的本地展开状态会随卸载丢失，窗口化时须保留该用户选择。

content-visibility 可减少布局/绘制，但保留 DOM 与 React 实例，不解决驻留规模。窗口化会增加必要逻辑，不能承诺一个小 helper 消除全部成本。应删的是第二份可见范围规则和全量 JSX 构造。

## 6. 其余项

trust：reader + 主机 CLI 写入是当前合同。移除 Web POST 动作，保留状态、MCP 声明与主机操作说明；不为了残留按钮新增 trust writer。

capture：stdout/stderr 各保存 chunks、bytes、clipped；append 只计量新增 text，按剩余 UTF-8 预算完整截断，最终 join 交 journal。全量 live 输出照常转发。与 JSON 字符预算、SSE 帧预算不同，不抽通用 BoundedEverything。

wire：共享原始 Snapshot/Delta 声明放 protocol，Web 显示形状仍由 Adapter 转换。删同义声明，不附送 schema generator 或重复 validator。

能力探测：boolean/null 足够，null 包括尚未知和查询失败；只有 501+unsupported 得出 false。需要独立 loading/error 显示时才扩充类型，不为不存在的 UI 分支造状态机。

journal、catalogue、搜索：同步 admission 有实际持久语义，prune 未证瓶颈，catalogue 夹具低于 1 ms，搜索已有合作式预算。当前最佳选择是保持拥有者，不加调度、索引、缓存与重试。

## 精简清单

- packages/gateway/src/index.ts:L788: shrink: 两套终端 queue/wake/消费循环。同步有界发送、slow-consumer disconnect、连接清理。
- packages/client/src/gateway.ts:L18: shrink: 与 main 重复装配。两入口读取配置 + 单一 startGateway。
- apps/web/lib/session-view-cache.ts:L67: shrink: 全缓存与逐出重复 stringify。Entry.units + totalUnits。
- apps/web/hooks/useAgentSession.ts:L828: shrink: HTTP/SSE 共同事实发布。一个拥有 acceptance 的接收入口。
- apps/web/components/AppShell.tsx:L1406: delete: 必然失败的 trust POST。只读状态与主机操作说明。
- apps/web/components/ChatWindow.tsx:L1266: shrink: 全量 JSX 再 slice。完整 turn 描述 → 窗口 → JSX。

net: -40 lines possible. 仅终端与装配的保守设计估算，非已实现 diff；窗口化可能增加必要逻辑。
