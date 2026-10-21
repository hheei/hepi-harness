# 审计后续执行记录

用户于2026-10-14授权：优先修复审计建议1、2，建议3、4分别验证并形成research。基准master@1758c1f。共享工作区，修改尚未提交；原始审计是修改前的历史证据。

## 工作归属

| 工作 | Worker | 范围 | 状态 |
| --- | --- | --- | --- |
| CLI Worktree | agent-7 | packages/client与其README | 完成；公开HTTP、打包CLI本地/SSH验证通过 |
| Settings/登出 | agent-11 | Web生产代码、新增auth/capability测试 | 完成；生产构建、23项真实浏览器检查通过 |
| Web测试漂移 | agent-12 | 现存Web测试 | 完成；7个文件修正并通过，16个上游/未交付功能失败保留分类 |
| 文档事实/链接 | agent-8 | architecture/migration/index/Web README及历史死链 | 完成；docs检查0死链/0未索引，Settings措辞由协调者整合 |
| 部署探针 | agent-10 | 只读probe及测试/指南 | 完成；fixture回归与真实只读probe通过 |
| 后续功能research | agent-9 | 功能缺口验证、现有接口与实现方案 | 完成；真实adapter seam探测、主源与实施候选已记录 |
| 性能research | agent-13 + agent-14/15 | 大文本/资源树/搜索/已加载历史验证 | 完成；协调者合并原始结果、分名脚本与浏览器限制 |
| Module设计审查 | agent-16/17/18 | 后端、Web、Gateway/CLI | 完成；四个修复候选、长历史调查与advisory已去重 |

## 范围决定

Settings先恢复当前支持能力的完整使用路径、正确登出，并让未支持功能的可用性明确。Provider增强、Agents、Push等完整运行能力留在研究范围；不以按钮存在或成功响应空值冒充实现。

探针修复及线上核验仅进行只读操作。运行时不部署、不重启、不build/install。真实缺服务仍必须报告失败，不能为通过而吞掉错误。

Worker运行focused checks，协调者检查集成diff，执行verify:changed和必要浏览器/HTTP seam核验；通过后不无理由重复整套检查。研究区分当前实测、历史测量与未测推断，保留命令、revision/dirty、exit和日志位置。

## 已完成验证

- CLI：typecheck、10/10 tests、build、installed tarball smoke均exit0；真实localhost sshd创建/删除Worktree通过。证据在`.dev/verify/agent7/`。
- 文档：修复13死链与3未索引历史指南，检查exit0。`.dev/verify/docs-fixes.json`是该次记录；后续文档整合另记检查，不冒充同一次source。

- 部署探针：缺Health字段的容器现在报告none，真实probe exit0；runtime backend56ff08f、Webdf24b7c均healthy/restart0。仅只读核验，没有部署。日志`.dev/verify/2026-10-14-deploy-probe/`；运行时backend包含perf闭环commit6899a8c，Web/gateway版本仍须独立判断。

- Web测试：7个漂移文件的focused runs全部exit0。16个剩余失败文件对应未交付上游runtime/launcher/provider路由，保持可见，未删/跳过。原始日志移至`.dev/verify/audit-web-drift/logs/`；最终全套273 files / 2297 tests：2281 pass / 16 fail，exit1；记录的前后运行无新增失败名称，不是detach双revision比较。

## 功能研究

[features-research.md](features-research.md)已完成。确认Provider discover/test/auth、导出、Agents、Push缺少路由；fork可用而会话内树无公开数据源；SSH Workbench未装配。Provider凭证必须由后端拥有，不能接旧Web主机凭证写入代码。下一批优先Provider增强；导出与Push根据通知交付语义选择顺序。Push的服务端触发、重启/多实例去重仍需验证，不以既有helper占比估算完成度。

## 最终集成验证

- verify:changed exit1仅Web已分类失败；选中的typecheck/client/script/entrypoint/docs均通过，51脚本测试。记录`.dev/verify/2026-10-14T08-05-30-379-verify-changed/verify.json`。随后修改的model-visibility owner独立typecheck和165项focused checks exit0，未变client/tooling结果复用。
- 最终Web单测exit1、2281/2297 pass、16 fail；`.dev/verify/2026-10-14T08-23-27-576-web-unit/web-unit.json`。未删除/skip测试来冒充绿灯。
- 本地隔离Next生产构建exit0；Settings浏览器23项exit0，覆盖模型配置下一请求应用、重启保留、登出/401/重登录、未支持开关及具名说明。证据见[Settings](fixes-settings.md)。
- 线上仅只读probe；authenticated GET /api/models=200、unauthenticated=401。backend56ff08f、Webdf24b7c healthy/restart0；这些是原运行版本，未部署本次修复。

## 性能与设计研究交付

[performance-research.md](performance-research.md)：真实大粘贴使历史不可达；资源/搜索在本机合成规模下够快且边界具名，不能外推远端/超大单历史；真实React浏览器2000条加载后的DOM/heap/longtask增长有数据。正常工具50KiB由真实函数与应用点确认，端到端工具探针未执行成功，负结果保留。

[design-review.md](design-review.md)：按用户指定skill，四个实际修复候选是跨Execution Host MCP归属、大文本恢复/分页、快照接受后的元数据旁路、SSH初始linked worktree删除后的有效目录。活动历史挂载范围investigate，装配/计数/发现失败协议/源码形状测试record。审计阶段新增候选尚未实施；后续单独授权的四项修复及根因分类见 [design-fix results](../design-fixes/results.md)。其余调查和 advisory 仍保留，不能把四项完成理解为所有新研究发现已修复。

研究脚本曾有协调者分配的同名冲突，现使用四个独立入口；两原始探针从创建调用完整恢复，保留原run日志/数据，不因改名重跑。源代码与文档当前未提交，构建和研究日志在.dev，未重启生产。

## 最终文档与导航检查

在1758c1f + 本轮dirty源码上：`pnpm check:docs --json=.dev/verify/audit-followup/docs-final.json` exit0，195 Markdown、0死链、0未索引；`pnpm check:entrypoints --json=.dev/verify/audit-followup/entrypoints-final.json` exit0，63入口存在、2项既有缺失、无新缺失。`git diff --check` exit0。上述JSON/同名log保留在.dev。

协调者仅运行一次`~/.local/bin/graphify update .`，exit0；AST图更新为10803 nodes/21398 edges，日志`.dev/verify/audit-followup/graph-update.log`。代码导航已更新；本次没有运行LLM语义文档提取或重新label。浏览器补测记录的三个fixture端口经ss核验无监听。
