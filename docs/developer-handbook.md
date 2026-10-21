# Developer handbook

从 checkout 跑起 Hepi、找到功能的所有者、验证改动。架构细节见 [Developer guide](developer-guide.md),
操作步骤由各功能指南维护。

## 开始开发

按 [Onboarding](development/onboarding.md) 安装依赖并启动开发栈;最短入口见 [Root README](../README.md#getting-started)。
`pnpm dev` 启动 gateway、Backend、Web;client ingress 需另开终端。

```bash
pnpm verify:changed
pnpm verify:changed --base=main --dry-run
```

不带 `--base` 检查相对 HEAD 的本地改动;带 `--base=<branch-or-SHA>` 包含已提交分支改动。
覆盖范围与额外浏览器检查见 [Verification](verification.md),CI 边界见 [Continuous integration](ci.md)。

## 按任务找入口

| 任务 | 入口 |
| --- | --- |
| 找进程边界、关键文件与验证接缝 | [Developer guide](developer-guide.md) |
| 了解运行时语义、领域名词、能力边界 | [Architecture](architecture.md)、[Glossary](../GLOSSARY.md)、[Migration status](migration-status.md) |
| 排查无模型、登录、文件、终端、MCP、恢复问题 | [Troubleshooting](development/troubleshooting.md) |
| 了解用户操作 | [User guide](user-guide.md) |
| 部署或发布 | [Runbook](deployment-runbook.md)、[Client-runtime release](client-runtime-release.md)、[Releases](releases.md) |
| 找其他指南 | [Documentation index](README.md) |

## 怎么读代码

先窄查询,再回源码确认:

```bash
~/.local/bin/graphify query "WorkbenchConnection" --budget 1000
~/.local/bin/graphify explain "WindowProjector"
```

默认 `graphify-out/graph.json` 是部分 AST 导航索引;HTTP/SSE 契约、动态分发与装配仍需读源码。
规则见 [Graph navigation](agents/graph-navigation.md)。改动流程见 [AGENTS.md](../AGENTS.md),
结果记录见 [Verification practice](agents/verification.md),问题分级见 [Review policy](agents/review-policy.md)。

## 约束与证据

行为描述以源码为据;验证结果绑定命令、revision、退出码与原始日志;已部署状态只对检查的主机和日期成立。
确认线上版本先执行 [Runbook](deployment-runbook.md) 第 1 阶段,不要从文档里的旧计数推断健康。
主机、账号、地址与凭据使用 `<client-host>`、`<runtime-host>`、`<ingress-origin>`、`<gateway-token>` 等占位符;
真实取值留在主机的 git-ignored 私有配置中,见 [Deployment](deployment.md)。
