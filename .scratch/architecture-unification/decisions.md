# 已定决策与 ask-matt 路由

2026-10-14；用户已授权全部可执行解法及实施。此努力采用 ask-matt 的 to-spec → to-tickets → implement-spec frontier；前两阶段完成后进入实施，数字参数与窗口库选型由有界实验解决。无需重复询问已授权范围。

设计原则与验收以 [spec](spec.md) 为唯一来源。原 [solutions](../architecture-routes/solutions.md) 为输入证据，原「此次不改产品代码」只描述当时分析。

| 决策 | 结论 | 拥有者 |
| --- | --- | --- |
| 产品范围 | 九项 actionable 解法全部实施，journal/catalogue/search/SSH 往返 advisory 保持记录 | spec |
| 终端流控 | 同步有限写入，慢消费者断开；保留 replay/reset/lease | 03 |
| 初始 replay | 用真实多 tab 与编码实验选有限预算及发送方式，必须排除无限重连 | 03 |
| 缓存单位 | 保持 serialized UTF-16 code units，Entry 一次计量 + running total | 05 |
| Gateway | 单一装配消费 resolved settings，两入口读配置 | 02 |
| snapshot | 唯一 acceptance owner，来源特有 effects 显式 | 01 → 06 |
| 历史 | 先完整 turn 描述，再窗口，再 JSX；loaded data 与 mounted window 分开 | 08 → 09 → 10 |
| 窗口选择 | 浏览器验证之后选一种 implementation，依赖/license 同时记录 | 09 |
| trust/capability | trust 只读 + 主机指引；unsupported 才 unavailable，其余 unknown | 07 |
| wire/capture | 公共 raw 合同；capture chunks + UTF-8 counter | 01 / 04 |

新机制保持既有 ADR 0001/0005/0006/0007，没有新的持久格式或难回退的主机所有权选择，不创建推测 ADR。若实施发现必须改变这种约束，先记录具体决策及证据。

Integration branch: `integration/architecture-unification`。源码已有未提交且已验证的前序任务；这次以 shared checkout 的明确 owned paths 并行，保留这些源码，不用从 HEAD 建出的空 worktree 伪称等价基线。各票有独立 agent context，03/04 同 owner 按顺序完成。

实施 owner 领取对应票，独立工作只修改 owned paths。共享文件冲突是排程问题，不伪造产品依赖。coordinator 整合公共 export、运行整合 checks、更新一次默认 graph；冻结 deep graph 的历史指纹应显式保留。
