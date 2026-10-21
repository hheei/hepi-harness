# 目录与依赖重整记录（F1/F2/F3）

来源：文件架构审计 `518bc7c6`；文档导航基线 `67e36829`。用户随后明确要求将剩余命名与目录优化落到代码，并允许直接破坏旧接口。本轮代码已整合到主工作区，验证结果见 [Verification](../../docs/verification.md)。

## 本轮范围

- **F1：依赖方向。** Gateway 的 MCP 行为归 Gateway；跨进程 DTO、纯导入解析和共享路径规则归 `@hepi/protocol`。现有调用端直接使用所有者导出，移除 Gateway 对 `@hepi/ui` 的依赖。
- **F2：UI 特性簇。** `packages/ui/src/lib/file/`、`chat/`、`provider/` 收拢对应前缀的实现及同目录测试；同步迁移当前 import。保留文件名，测试仍递归枚举。
- **F3：E2E 主题目录。** 当前驱动和独占 fixture 按 acceptance、auth-shell、chat、history、mcp-skills、terminal、workbench-files 分组；同步迁移 package scripts、CI 与当前指南。
- **诊断入口。** Backend Diagnostic Page 的源码、HTML、生成脚本与 URL 使用 diagnostics 命名；`workbench.js` 仍是与 `workbench.html` 配对的手写静态脚本。

当前布局、入口及检查接缝见 [Developer guide](../../docs/developer-guide.md#directory-map)。历史验证记录保留其原 revision 的路径。

## 退役测试的边界

删除的 33 个 `.mjs` 驱动都直接依赖已移除的 Next 二进制或 `.next/BUILD_ID`，同时删除独占 fixture 与失效脚本。删除不代表对应浏览器旅程重新通过；当前替代接缝及剩余覆盖限制见 [Migration status](../../docs/migration-status.md) 与 [CI](../../docs/ci.md)。

## 剩余候选与重开条件

`session-*` 的名字涉及 Session Transport、Session Row 与 Conversation 的区别，本轮保留；不做统一词汇替换。`terminal-*`、`lifecycle-*`、`connection-*` 各簇较小，当前没有独立搬迁收益。剩余 MCP UI 文件在 F1 所有权迁移后按实际职责判断，避免仅为目录对称再搬一次。

下一批以具体导航摩擦或责任边界问题为依据；每批同步迁移当前调用端、验证入口与所属指南，使用 [review policy](../../docs/agents/review-policy.md) 判断材料性问题。
