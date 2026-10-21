# 04: verbose execution 捕获改为线性累积

**What to build:** 输出很碎的命令仍完整 live 转发，重复 call 从账本得到同一个有界结果，捕获不反复扫描已有前缀。

**Blocked by:** None (can start immediately)

**Status:** claimed

**Spec:** [统一设计](../spec.md)

## Acceptance criteria

- [ ] stdout/stderr 各拥有 chunks、UTF-8 retained bytes 和 clipped；只计量新 chunk，最终 join 一次。
- [ ] 预算边缘不切坏多字节字符；各流独立限额，零/空输出和默认 capture 行为保持。
- [ ] live sink、spill、spillUnsupported、truncated、失败与 outcome-unknown 合同保持。
- [ ] 真实 execute 与 repeat-call lookup 验证结果一致且未重复执行；不是仅复制 append 的算法探针。
- [ ] 相同输出量比较小/大 chunk scaling，记录实测范围，不推断所有真实命令被冻结。
- [ ] 删除旧 append 重扫逻辑，沿用 journal ownership；不引入通用 buffer/budget framework。

## Verification

Local/SSH execute 的既有公共 Seam 和真实 journal replay；Unicode、两流、spill/无 spill 用同合同夹具验证。 每次结果保存命令、源版本/dirty指纹、实际退出码和原始日志；本 ticket 更新自己的当前指南。

## Context

读取 [已定决策](../decisions.md)、[导航与 owning guides](../navigation.md) 和 [review notes](../review-notes.md)。按 spec 删除被替代知识与路径；可跨 Module 整理，最终 Interface 应统一且可维护。具体源位置在导航表，本 ticket 的行为目标不绑定过时文件布局。
