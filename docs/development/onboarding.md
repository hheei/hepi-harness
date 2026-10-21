# Onboarding: from checkout to a running development stack

本页是[开发者手册](../developer-handbook.md)的实操部分:前置条件、安装、开发态启动、测试、构建、Rust 调试构建、
配置与状态、以及"这些文件分别属于谁"。操作细节的权威来源仍是
[local integration](../local-integration.md);本页只补充入门顺序与容易踩的点,不复制细节。

## Prerequisites

| 需求 | 版本 | 依据 |
| --- | --- | --- |
| Node | 22.19+ (上游 runtime/SQLite);直接跑 `.ts` 入口需稳定 type stripping,用 Node 24+(已在 26.5.1 上验证) | [root README](../../README.md#requirements) |
| pnpm | 12.4.1 | `packageManager` in `package.json` |
| 浏览器 | Chrome/Edge/Firefox 111,Safari/iOS 16.2 | `apps/web/package.json` `browserslist` |
| SSH 模式 | 工作站 OpenSSH + 一条已认证的远端路由 | [local integration](../local-integration.md#ssh-prerequisites) |
| 桌面 App | Linux x86_64 + WebKitGTK 4.1;Rust 工具链 | [apps/app README](../../apps/app/README.md) |

Android **不构建也不宣称**:构建主机没有 SDK。

## Install

```bash
git clone <repo> && cd <repo>
pnpm install          # from the root
```

没有全局安装步骤。工作区包通过 `workspace:*` 互相引用,并且 `@hepi/gateway`、`@hepi/protocol`、
`@hepi/session` 都解析到各自的 `src` 入口,所以 `node --watch` 能跨包重启。

## Development: four processes, and why the fourth is separate

`pnpm dev` 起三个进程(`scripts/dev.mjs`):

| 进程 | 包 | 默认地址 | 环境要点 |
| --- | --- | --- | --- |
| gateway | `@hepi/gateway` | `http://127.0.0.1:8788` | `HEPI_GATEWAY_TOKEN=local-gateway-token`、`HEPI_GATEWAY_ID=workstation`、`HEPI_WORKSPACE_ID=local`、`HEPI_ALLOWED_COMMANDS=bash`、root 默认仓库目录 |
| backend | `@hepi/server` | `http://127.0.0.1:8787` | `HEPI_AUTH_TOKEN=local-server-token`、`HEPI_GATEWAY_URL`、`HEPI_DB=.dev/hepi.sqlite` |
| web | `@hepi/web` | `http://127.0.0.1:30141` | Vite dev server,`/api` 代理到 `HEPI_INGRESS_ORIGIN`(默认 `http://127.0.0.1:8790`) |

**client ingress 不在里面**,必须自己起一条:

```bash
HEPI_INGRESS_BACKEND=http://127.0.0.1:8787 \
HEPI_INGRESS_SERVICE_TOKEN=local-server-token \
pnpm --filter @hepi/gateway start:ingress
```

为什么分开:ingress 是部署自己的监听器,不是开发脚本的产物;生产里它和 Web 构建同源,开发里 Vite 代理扮演同一角色。
没有 ingress,页面能加载但没有 API。

可选项:`pnpm dev --only=server,web` 只起子集;`HEPI_DEV_WORKSPACE`/`--workspace=<dir>` 换工作区根;
`PORT`、`HEPI_GATEWAY_PORT` 覆盖端口。开发态状态全在 `.dev/`(SQLite、gateway journal、verify 日志),不碰任何
生产路径。

## Configuration: who reads which variable

| 变量 | 读取者 | 说明 |
| --- | --- | --- |
| `HEPI_DB`, `HEPI_PROJECTS`, `HEPI_SKILL_REPOSITORY`, `HEPI_DEVICE_CREDENTIALS` | Backend | 四个 SQLite 文件;默认在 `HEPI_DB` 同目录 |
| `HEPI_BIND_HOST`, `PORT`, `HEPI_AUTH_TOKEN` | Backend | 非 loopback 绑定必须显式给 token |
| `HEPI_GATEWAYS` 或 `HEPI_GATEWAY_URL`/`HEPI_GATEWAY_TOKEN`/`HEPI_GATEWAY_ID` | Backend | 执行目标;`HEPI_WORKSPACE_ID` 绑定默认工作区 |
| `HEPI_PROVIDER`, `HEPI_MODEL`, `HEPI_PROVIDER_BASE_URL`, `HEPI_PROVIDER_API_KEY` | Backend | 默认环境模式;未配置则无默认模型 |
| `HEPI_CONFIG_SOURCE=pi` | Backend | 读本机 agent 目录(`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`) |
| `HEPI_HEARTBEAT_MS` | Backend | 会话流心跳,默认 30 s,0 关闭 |
| `HEPI_MCP_TOOLS` | Backend | 运维兜底的工具声明(JSON 数组) |
| `HEPI_GATEWAY_TOKEN`, `HEPI_WORKSPACE_ROOT`, `HEPI_WORKSPACE_ID`, `HEPI_ALLOWED_COMMANDS` | gateway | 执行侧;SSH 模式加 `HEPI_SSH_*` |
| `HEPI_GATEWAY_DB` / `HEPI_GATEWAY_DATA` | gateway | call journal;一个进程一个 journal |
| `HEPI_TERMINAL_HEARTBEAT_MS` | gateway | 终端流心跳,默认 30 s,0 关闭 |
| `HEPI_INGRESS_BACKEND`, `HEPI_INGRESS_SERVICE_TOKEN` | ingress | 必需 |
| `HEPI_WEB_LOGIN_TOKEN` | ingress | Web 登录材料;非 loopback 绑定时必需 |
| `HEPI_APP_ORIGINS` | ingress | App 允许的跨域来源,不在列表里的直接拒绝 |
| `HEPI_INGRESS_DEFAULT_HOST` | ingress | 本 origin 服务的 gateway id,逐请求转发;客户端不能自选 |
| `HEPI_INGRESS_MCP_GATEWAY_{URL,TOKEN,ID}` | ingress | 本机 host service,三者必须同时给或同时不给 |
| `HEPI_INGRESS_STATIC_DIR` | ingress | Vite `dist` 目录;不设表示不服务页面 |
| `HEPI_REVOCATION_CHECK_MS`, `HEPI_UPLOAD_BATCH_BYTES` | ingress | 撤销重检间隔、单次上传上界 |

**状态文件属于谁。**

| 文件 | 所有者 | 说明 |
| --- | --- | --- |
| `<db>/hepi.sqlite` | Backend | 会话、任务、提交记录;一个部署一个写者 |
| `<db>/projects.sqlite` | Backend | Project 元数据 |
| `<db>/skill-repository.sqlite` | Backend | 技能仓库索引(可选;打不开不阻止启动) |
| `<db>/device-credentials.sqlite` | Backend | 设备凭据记录(散列) |
| `<gateway-data>/calls.sqlite` | gateway | 执行 call ledger;一个进程一个 |
| `<home>/.pi/agent/mcp.json`, `mcp-auth.json` | 执行主机账号 | MCP 配置与凭据 |
| `<home>/.pi/agent/auth.json`, `models.json` | 执行主机账号 / Backend(`pi` 模式) | Provider 凭据与模型文件 |

真实取值只写在主机上 0600 的私有 env 文件里,不进仓库、不进文档、不进 unit 文件。

## Tests

| 范围 | 命令 |
| --- | --- |
| 按改动选择 | `pnpm verify:changed`(`--base=<branch>` 含已提交、`--dry-run` 只打印计划、`--test-file=<path>` 只跑指定文件) |
| 全量档位 | `pnpm verify --profile=fast`(typecheck + 工作区测试)、`--profile=full`(再加 Web 单测) |
| 单包 | `pnpm test:server`、`test:gateway`、`test:session`、`test:protocol`、`test:web:unit` |
| UI 单测 | `pnpm --filter @hepi/ui test` |
| 脚本自身的测试 | `pnpm test:scripts` |
| 文档/入口 | `pnpm check:docs`、`pnpm check:entrypoints` |
| 浏览器场景 | `pnpm --filter @hepi/web test:<name>`(清单见 `apps/web/package.json`) |
| 失败集比较 | `pnpm compare:tests --base=<SHA>` |

`apps/web` **没有**通用 `test` 脚本:它的单测由 `scripts/test-web-unit.mjs` 枚举,浏览器检查必须单独跑。
基线、已知失败与预算见 [verification](../verification.md) 与 [verification practice](../agents/verification.md)。

## Build

| 目标 | 命令 | 产物 |
| --- | --- | --- |
| Web 页 | `pnpm --filter @hepi/web build` | `apps/web/dist`(ingress 用 `HEPI_INGRESS_STATIC_DIR` 服务) |
| App UI 包 | `pnpm --filter @hepi/app build` | 壳内嵌的 bundle |
| 桌面产物 | `node apps/app/scripts/build-artifacts.mjs [--profile=release] [--reproduce]` | 产物 + `provenance.json` |
| 客户端运行时发布目录 | `pnpm build:client-runtime` | 见 [client-runtime release](../client-runtime-release.md) |
| 后端镜像 | `docker build`(在 build host 上) | 见 [container deployment](../container-deployment.md) |

**不要在 `remote-host` 上编译或构建**:那台主机只运行容器与做只读验证。匹配目标架构(`linux/arm64`)在 `workstation` 或 CI
构建,再把**预构建产物**移过去。这是主机属性,不是某次改动的属性,见 [AGENTS.md](../../AGENTS.md)。

## Rust debug build: one shared cache, six jobs

桌面壳的构建成本集中在 Cargo。仓库把这件事收进一个脚本,并把缓存移出各 checkout。**仓库根目录没有 `Cargo.toml`**,
清单在 `apps/app/src-tauri/Cargo.toml`,所以 ad-hoc 构建要么在壳目录里跑,要么给 `--manifest-path`:

```bash
# 在仓库根目录执行:先导出环境,再指定清单
eval "$(node apps/app/scripts/cargo-build.mjs)"   # 打印并导出构建环境(默认 --profile=debug)
cargo build --manifest-path apps/app/src-tauri/Cargo.toml
# 或直接用 tauri,它在壳目录里工作,同样继承上面的环境
pnpm --filter @hepi/app exec tauri dev

# 在壳目录里执行时,清单由目录决定
(cd apps/app/src-tauri && eval "$(node ../scripts/cargo-build.mjs)" && cargo build)

node apps/app/scripts/cargo-build.mjs --prune-cache  # 保留最多两代缓存
```

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CARGO_TARGET_DIR` | `<git-common-dir>/.dev/cargo-target` | 所有 worktree 共享一份缓存,而不是每个 checkout 一个 `src-tauri/target` |
| `CARGO_INCREMENTAL` | debug `1`,release `0` | 增量让第二次开发构建便宜;release 只构建一次并测量 |

`src-tauri/.cargo/config.toml` 声明 job 数,**不**声明 `target-dir`:实测 checked-in 的相对路径会按每个 checkout
解析,主树与 worktree 会各自建一份 `.dev/cargo-target`。Cargo 自己的 target 锁会把两个并发构建串行化(第二个等,
不重复编译)。

默认 profile 是 `debug`,开发与验收用的就是它。`build-artifacts.mjs --profile=release` 才用清单里的 release
profile(`opt-level = "s"`、LTO、`codegen-units = 1`、strip、`panic = "abort"`),代价高,所以永远不是默认;
`provenance.json` 用 `build.profile` 与 `build.production` 记录这次产物是哪一个,debug 产物不会被标成 production。
发布标签是否**必须**用 release,取决于你走的打包流程:仓库里没有脚本会拒绝 debug 产物,别把"只有 release 能发布"
当成已强制的规则。详见 [apps/app README](../../apps/app/README.md#build-and-package)。

## Debug

- 服务端/网关:`pnpm dev` 已带 `node --watch`,改 import graph 内任何模块都会重启;SQLite 写入不触发重启
  (`--watch` 跟模块图,不跟目录)。
- 单个进程:`pnpm --filter @hepi/gateway start`、`pnpm --filter @hepi/server start`(后者会先 `build:ui` 打
  `public/diagnostics.js` 诊断页脚本,页面在 `/diagnostics`)。
- 检查留存:`verify`/`test:web:unit` 每次运行把命令、SHA、dirty 状态、退出码和原始日志写到
  `.dev/verify/<timestamp>-<label>/`。
- 只读部署检查:`pnpm deploy:inspect`(加 `--probe` 多一次固定 SSH 读);计划:`pnpm deploy:plan`。两者都不打印
  主机名、地址、登录名、绝对根或 registry。

## Next

- 架构与逐层实现:[developer guide](../developer-guide.md)
- 症状排查:[troubleshooting](troubleshooting.md)
- 使用流程:[user guide](../user-guide.md)
