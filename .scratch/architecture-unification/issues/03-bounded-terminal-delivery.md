# 03: 慢终端消费者有界断开并正确恢复

**What to build:** 一个终端接收者暂停读取时，网关内存积压有限，shell 和其他接收者继续运行，重连得到准确 replay/reset。

**Blocked by:** None (can start immediately)

**Status:** claimed

**Spec:** [统一设计](../spec.md)

## Acceptance criteria

- [ ] 共享私有写入点覆盖两路 event 与 heartbeat；编码一次并按真实 UTF-8 frame bytes 检查有限 response 积压。
- [ ] 同步 subscriber 直接写入，删两套 queue/wake/消费循环；不把积压转移到另一个异步队列。
- [ ] budget、单帧与聚合 replay 的有限处理策略有原始实验依据，合法 replay 无无限重连，不按 tab 数无界放大容量。
- [ ] 关闭统一清理 timer/subscription；单会话 exit 与 fan-in 部分 exit 行为保持，断开不杀 shell。
- [ ] 慢 socket 达预算后连接结束，重复断开/重连无订阅泄漏；input/resize 和独立接收者仍可用。
- [ ] Last-Event-ID / 各会话 cursor、replay-before-live、reset、120 s lease 保持；永久慢读者的非 lossless 限制如实记录。
- [ ] 用真实 HTTP writer 验证正常、多 tab、Unicode/control encoding 和慢读者；host double 与真实 PTY/SSH 的证据明确区分。
- [ ] 更新终端使用说明与能力限制；数值、源码指纹和日志绑定本次运行。

## Verification

两条真实 Gateway HTTP/SSE 路由及 reconnect/input/resize；有界慢 socket + 正常接收者，必要真实 PTY/SSH 对照。 每次结果保存命令、源版本/dirty指纹、实际退出码和原始日志；本 ticket 更新自己的当前指南。

## Context

读取 [已定决策](../decisions.md)、[导航与 owning guides](../navigation.md) 和 [review notes](../review-notes.md)。按 spec 删除被替代知识与路径；可跨 Module 整理，最终 Interface 应统一且可维护。具体源位置在导航表，本 ticket 的行为目标不绑定过时文件布局。
