# 非阻塞记录

全部记录取自 [architecture analysis](../architecture-routes/README.md)，不是新增实现任务。

| 项目 | Trigger / evidence | Impact / disposition | Revisit |
| --- | --- | --- | --- |
| catalogue 全扫描 | 200k 合成夹具约 0.85ms；无普通使用失败 | record：当前收益不足以引入索引与缓存 | 真实长会话 profiling 表明 material 成本 |
| journal sync/prune | 同步 begin/complete 有持久语义，prune 尚未证瓶颈 | record：保持单拥有者 | 用户延迟报告或真实 profiling |
| session search | 有 entries/bytes/time 合作式预算，native page 不可中断 | record：未证正常查询损害 | 预算突破或实际搜索请求延迟 |
| SSH repeated discovery | 可测重复往返，但没有已批准 transport rewrite | record：避免跨主机 speculative cache | 实际 remote 工作流 latency 或单独优先级 |
| 巨大单 turn | 完整 turn 粒度不能限制单 turn 内部节点 | record：窗口仍解决多数普通历史增长；沿用 deferred text | 实际巨大 turn 仍造成交互失败 |
| 已加载 prefix heap | DOM window 不等于数据 eviction；prefix 仍为 authoritative read projection | record：本 spec 分开 mounted 与 loaded，不伪称总 heap 固定上限 | 真实数据 heap 压力需单独定义 eviction/navigation 合同 |
| 历史缓存探针 | probe-loaded-history-cache 读取旧内部 global Map，cache 改表示后失败；非 suite/prod caller | record：历史探针不再适用于当前缓存布局；性能旧结果仍绑定旧源码 | 下一次实际需要跑该探针时改走公开 cache Seam，更新夹具/版本，避免兼容 shim |
| 多 MB structured args | read-block text deferral 不覆盖 structured tool arguments | record：此前边界保持，非本次帧合同迁移的新修复 | 实际 frame_too_large 或用户单独优先级 |

已显式授权的结构整理仍按 tickets 实施，即便原分类为 advisory；未授权的记录不会自动进入修复循环。review 发现 material 正常使用失败时按 owning Seam 修复，并记录具体 trigger。
