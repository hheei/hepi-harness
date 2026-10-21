# Gateway DESIGN review

审查时间：2026-10-14；源码基准：master `1758c1fb4479e9d4637a957857246c5998619d73`，共享工作区 dirty，包含已授权 CLI worktree 修复。按当前源码审查，未把旧缺陷当作未修复发现。只新增本文；未改源码、测试、指南、graph，未提交或部署。

执行本地、git-ignored 的 `.pi/skills/skills/engineering/codebase-design/SKILL.md` 与 DEEPENING.md；已读 GLOSSARY.md、review-policy.md、verification.md。复用父会话 graph 导航；结果截断后，按指定文件与具体符号确认。GatewayRpcServer 在 packages/gateway/src/index.ts；SshWorktreeServer 在 worktrees.ts；ExecutionHostEnv/gatewayEnvironment 在 packages/gateway/src/environment.ts；不存在独立 rpc-server.ts、ssh-worktrees.ts、apps/server/src/gateway-env.ts，未据假定文件名评判。

## 发现与处置

| 优先级 | 处置 | 发现 | 证据性质 / 重访条件 |
| --- | --- | --- | --- |
| P2 | fix | SSH worktree 存在性检查依赖 profile 初始 root；删掉初始 linked worktree 后，其他正常目录的 list/remove 失效 | 本次真实 localhost SSH + HTTP 复现。修复执行目录选择与错误归属；不需新增 Module |
| P2 advisory | record | 两个 Gateway 入口重复承担 registry、Adapter 选择与生命周期装配 | 源码确认重复；旧 CLI 漏装 worktree 已有公开 Interface 失败记录，当前已修。下次能力/transport/生命周期策略需改两个入口，或用户明确优先精简时重访 |
| P3 advisory | record | discover 的 Interface 声明成功/failed union，Implementation 实际只返回 loaded 或 throw | 源码与调用方确认额外分支；未发现当前用户流程失败。下次修改发现错误协议或出现调用方漏处理时重访 |

### 1. P2 / fix：Execution Host 连接配置泄漏为“初始目录永久存在”义务

定位：packages/gateway/src/worktrees.ts:389、:390；调用链 :184 → :382 → :423。正常配置可以把 Gateway 初始 root 指向 linked worktree；同一 profile 也能注册主 checkout 或其他项目目录。执行/文件路径按 WorkspaceRegistry 里的 owner.root 解析，但 sshExistingPaths 不接受当前 listing 已解析的目录，固定以 profile.remoteRoot 为 cwd/root。

具体触发：profile 初始 root 为 <repo>-worktrees/seed；同一 registry 注册仍存在的 <repo>；先从 main 请求删除 seed（允许删除非 main checkout），再列 main 或被删 seed。删除成功，后续两个 POST /v1/worktrees list 都答 HTTP 500 {ok:false,code:"execution_failed"}。直接调用 SshWorktreeServer.execute 则抛 code=outcome_unknown、message="the SSH host did not answer which checkouts exist"，没有返回 WorktreeResult。main 仍在，SSH 仍通；失败来自 runner 在已删除目录执行 cd，而非主机失联（packages/gateway/src/runner.ts:216）。listEntries 在 :184 不捕获此失败，RPC 最外层 :507 将它降为通用 execution_failed。

Interface 本应只要求“workspaceId 解析到所属 Execution Host 与目录”，并由 list 的 Implementation 在旧 worktree 已消失时推断主仓库（worktrees.ts:196、:203）；现在调用方还必须维护 profile 初始目录的存活。这是已有 fallback 规则在 SSH Adapter 上失效，且主目录 list/remove 也受牵连。没有证明数据丢失；create 不走存在性列表，不能声称所有操作都失败。scope 内实际影响已足够归为 fix。

依赖：git、目录存在性检查属 local-substitutable，现有真实临时 repo 可测试；Gateway→SSH helper 属 remote but owned，主机上的命令由项目控制，OpenSSH 是外部 transport。GitCommandRunner / ExistingPaths / SshRunner 已是实际 Seam，Local 与 SSH 是两个真实 Adapter。无需新“host resolver”或协议。

最小连贯改动建议：让 listEntries 把自己正在使用的、已由 resolveRepository/fallback 选定的目录传给 ExistingPaths；SSH Adapter 在该目录执行存在性检查，local Adapter 可忽略目录参数。不要仅改为 owner.root：被删 seed 的 owner.root 同样不存在，会继续破坏 fallback。把存在性检查失败收回 listEntries 的 GitFailure/WorktreeResult 归属，保留具名错误。隐藏的是执行目录选择与失败转换义务，提升已有 Module 的 Depth 与 Locality。删除测试：删去 sshExistingPaths Adapter 后，远端目录判断必须重现于各调用方；它有 Leverage，应修正现有 Adapter，而非删除或增加装饰层。

验证应仍经 POST /v1/worktrees，复用真实 sshd fixture，加“初始 root 为 linked worktree，删除后 main listing + seed fallback”情形；当前真实 SSH 用例 packages/gateway/test/worktrees.test.ts:287 只把主 checkout 设为 profile root，删除另一个 checkout，所以不会覆盖此触发。未写或删除测试。

### 2. P2 advisory / record：装配策略缺少 Locality；当前 CLI 修复已经有效

生产装配证据：packages/gateway/src/main.ts:36、:44、:47、:58、:75 与 packages/client/src/gateway.ts:35、:41、:44、:57、:66。每个入口都必须记住：execution/files/install/workspaces/worktrees/terminal 用同一个 registry；SSH profile/root 从 registry 解析；execution/install 用 managed master，filesystem/workspace/worktree/terminal 用 plain runner；Workbench/MCP 仅 local；rpc 关闭完再关闭 master（main.ts:79；client gateway.ts:84）。GatewayRpcServer 的八参数装配 Interface 在 index.ts:497，位置与能力缺席语义也属于调用方知识，尤其 worktree 缺席答 not_supported（:587）。

发生过的维护影响有具体证据：旧分发 CLI 在该位置传 undefined，公开 /v1/worktrees 失败；.scratch/development-audit/fixes-worktree.md 与 .dev/verify/agent7/prefix-reproduction.log 已记录。当前 client gateway.ts:57 已选择 Local/SSH worktree Adapter，:66 已装配，不再报告旧行为为缺陷。其正常 list/create/remove 已有 CLI 公开测试与 tarball smoke。留下的是下次新增能力需复制组合策略的 advisory，不是要求再修一遍已修缺陷。

backend 的 environment 装配是第三处调用点，但职责不同：apps/server/src/server.ts:978 从已存 WorkspaceDoc 解析 binding，再调 gatewayEnvironment；:1099 资源路径复用同一 binding。它不拥有 SSH credentials、managed master 或本机 Gateway 生命周期。已确认的是两个生产 Gateway 装配入口；不把 backend env factory 硬并成第三个 Gateway 入口。

最小 deepening 候选：在 @hepi/gateway 内收拢这两个入口共享的运行装配与启动/关闭 Implementation。CLI 仍解析 flags/config/env，独立 main 仍解析 env，然后各自只给同一 Module 传已归一化配置。共享 Module 负责 registry、Local/SSH Adapter 选择、local-only 能力、prepare/listen/close 次序；失败启动的清理也由同一 owner 处理。不要新增 generic container、DI framework、capability 插件注册表，也不要把 backend 的 binding factory 纳入这项改动。

依赖：registry 与 Adapter 选择为 in-process；journal、本地文件、git、监听端口为 local-substitutable；SSH commands/helpers 为 remote but owned；MCP 现有 Module 保留。已有 Local/SSH 两个 Adapter；无需为只有一个使用场景的 config normalizer 再创建 port。

删除测试：只把八个参数包进 object 再逐项转发，装配知识仍留两处，复杂度消失不了——这是 pass-through，没有 Depth。若删掉真正共享的装配 Module，registry/master/local-only/关闭顺序知识将重新散落两个入口，它才有 Leverage。目标是隐藏策略，不是缩短文件。保留上游 NodeExecutionEnv、Gateway 账本、worktree 规则与真实 transport Adapter 的 Implementation。

仅说明调用方用法，未调用 DESIGN-IT-TWICE、未选择替代 Interface 设计流程：

~~~ts
const running = await startGatewayRuntime(normalizeGatewaySettings(settings));
// caller gets origin/port, closed, close(); no registry or runner stitching
await running.close();
~~~

若用户重访，沿现有 RunningGateway 小 Interface 收拢即可。公开验证仍驱动 CLI/HTTP：packages/client/test/gateway.test.ts:33，smoke-pack.mjs:212、:303。两类测试分别验证 CLI 源码运行与分发 tarball，有不同义务，不能因共享装配就删除其中一个。

### 3. P3 advisory / record：发现结果与持久化失败状态混在一个 Interface

证据：apps/server/src/workspace-resources.ts:143 将 discover 声明为 Promise<WorkspaceResourceState>，其 union 在 :58 含 failed；实际 discover(:187) 遇缺 env、snapshot 失败、无描述或坏 frontmatter 都 throw（:192、:194、:368、:571），仅 :217 返回 loaded。failed 是 ensureAdoptedResources 内 discoverOrFail(:526) 为持久化状态产生的值；reloadResources(:506) 则依赖 throw 来保留旧 adopted 状态。

实际调用方 apps/server/src/skill-install.ts:478 既 catch，又在 :484 检查 state.status === "failed"；server.ts:1119 调 ensureAdoptedResources 后才 expand。这不是文件长导致浅，而是一个发现 Interface 同时暗示两种失败协议，增加调用方义务。inventory 对不同发现失败统一映射 unreachable_host，但 message 保留原因；本线没有证明该命名造成 material 用户故障，不扩大为 blocker。

最小 cut：将 discover Interface 收窄为 Promise<LoadedResourceState>，明确失败 throw；WorkspaceResourceState 仍用于 adopted 持久化，discoverOrFail 仍是唯一转换位置，Reload 仍失败前不 commit。调用方可删仅为 discover union 存在的 failed 分支。纯类型/职责修正，不新增 DiscoveryService、Result-wrapper Adapter 或第二套资源状态 Module。删除测试：整个 Loader 不能删，precedence/trust/frontmatter/持久化知识会回到 inventory、submission 与 Reload 调用方；应删除的是多余协议义务，保留已有 Depth。

这是 inferred 维护收益，未做类型改动或故障复现。现有 snapshot/资源公开测试已以 throw、HTTP failed 状态或旧 adopted 保留作可观察断言（resource-snapshot.test.ts:100；workspace-resources.test.ts:384）；没有发现此次已授权变更造成 source-shape 测试 churn，故不提出删除测试。

## 已有 deep Module：保留其 Leverage

| Module / Interface | 隐藏的 Implementation 与义务 | 删除测试 / 真实 Seam |
| --- | --- | --- |
| Gateway.execute / abort / close，index.ts:163、:252、:272 | workspace-scoped callId、fingerprint 冲突、admission 顺序、重试拒绝、unknown outcome、capture 上限、关闭时 abort/drain | 删除后各 transport/caller 都要重写账本与取消规则；LocalGateway/SshGateway 两 Adapter，MemoryLedger/GatewayExecutionJournal 两 Adapter。实质 Depth，不按 abstract class 或文件长度评判 |
| gatewayEnvironment，environment.ts:21；backend server.ts:981、:1101 | upstream ExecutionEnv 方法适配、logical/physical path、durable callId、abort 请求、file Result 重建、NDJSON 输出、失联不重发；资源读额外 executionHost/resourceSnapshot | 看似转发，但删掉会让所有 durable tool 与资源调用方理解 wire 协议与错误；这是有用 Adapter。保持 copy-first NodeExecutionEnv 及 upstream ExecutionEnv，不重写协议 |
| worktreeRequest，worktrees.ts:317；WorktreeServer.execute | branch/root 校验、remote ref precedence、porcelain 解析、dirty/force/main checkout 拒绝、gone-worktree fallback、批量检查目录 | Local/SSH 执行路径共用同一规则，有两真实 Adapter。修 #1 在已有内部 Seam；不把纯 git 规则重拆成策略框架 |
| resourceSnapshot + Workspace Resource Loader，filesystem.ts:558；workspace-resources.ts:193、:483、:505 | Gateway 封装主机 account/root、有限快照、frontmatter head、read failure vs absence；Loader 封装 trust/precedence/canonical dedup、命令扩展、adopted replay、active-run candidate 延迟 | SnapshotReader(:163、:585) 是 internal Seam，网络 Adapter 已有，内存视图提供遍历；一次 snapshot 而非 N 次 RPC 是可见性能 Interface。删除后目录规则或 durable Reload 顺序会散落 inventory/submission/render；不要泛化成资源 DI 系统 |

Execution Host 身份必须来自实际执行侧，不能 backend 猜 home：local filesystem.ts:143、:310；SSH filesystem.ts:448，远端 helper 的 account_of；SshWorkspaceServer 的 profile listing 可带单 host error（ssh-workspaces.ts:97），browse 单独要求 account 成功（:112）。这些不是无用防御或 pass-through。共享 registry 的 workspaceOwner(workspaces.ts:120) 隐藏 opaque id→profile/root 规则，避免各 Adapter 按 id 前缀猜主机；本次 #1 是目录选择漏到 Adapter 的局部问题，不证明 registry 应重写。

resourceSnapshot 的 16 MiB / 20,000 entries 上限属调用方性能 Interface，超限具名失败而非半 catalog（filesystem.ts:420、:422、:696）。性能研究 performance-research.md 的真实本地测量支持正常规模可用，远端规模未测。本线不提出分页/缓存/索引。该研究的大粘贴分页失败属 history-window/public chat Interface，非本报告 owner，不重复认领。

## 验证与限制

本次新增验证：只执行下面一条 focused reproduction，直接用当前源码、既有真实 localhost sshd fixture、真实 git 与公开 POST /v1/worktrees；无 mock runner、无付费 inference。命令 node --input-type=module 的完整 stdin 见附录；revision 1758c1f / 工作区 dirty；exit 0，8.0 秒。exit 0 表示探测运行并清理成功，不表示被测行为正常。fixture 使用 tmp 目录、临时 keys 与 pinned known_hosts，finally 关闭 RPC 与 fixture 自有进程，源码无修改。

原始日志保存在本文附录，符合“仅写本报告”范围。没有全套重跑。当前 CLI worktree 正常路径复用、且读过原始记录：pnpm --filter @hepi/client typecheck / test，exit 0，10 tests，.dev/verify/agent7/client-checks.log；pnpm --filter @hepi/client smoke:pack，exit 0，6 checks（含真实 SSH），.dev/verify/agent7/client-smoke.log。两者记录 1758c1f，dirty audit 修复；它们证明正常 main-root 情形，不证明 #1。

读过 public-seam 测试实现，不声称本次重新执行。未测生产 deployment、远端冷缓存资源成本、startup bind failure、长时间终端压力。没有另开实现迭代；#1 交给父会话按 policy 分类，#2/#3 完成 record 即止。

附录记录审查核心源码 SHA-256，便于共享工作区后续变更判断验证可否复用。

## 附录：本次 probe 命令与原始日志

~~~sh
node --input-type=module <<'NODE'
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GatewayRpcServer, SshGateway, SshWorktreeServer, WorkspaceRegistry, createSystemSshRunner, sshWorkspaceSeed } from './packages/gateway/src/index.ts';
import { sshdFixtureSkip, startSshdFixture } from './packages/gateway/test/sshd-fixture.ts';
const skip = sshdFixtureSkip();
if (skip) { console.log(JSON.stringify({skip})); process.exit(0); }
const run = promisify(execFile);
const fixture = await startSshdFixture();
let rpc;
try {
  const main = join(fixture.root, 'repo');
  const seed = main + '-worktrees/seed';
  await mkdir(main, {recursive:true});
  for (const args of [['init','-q'],['config','user.email','test@example.com'],['config','user.name','Test']]) await run('git',['-C',main,...args]);
  await writeFile(join(main,'README.md'),'baseline');
  await run('git',['-C',main,'add','README.md']);
  await run('git',['-C',main,'commit','-qm','baseline']);
  await run('git',['-C',main,'worktree','add','-qb','seed',seed]);
  const profile = {id:'seed',host:fixture.host,port:fixture.port,identityFile:fixture.identityFile,knownHostsFile:fixture.knownHostsFile,remoteRoot:seed};
  const registry = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
  console.log(JSON.stringify({registered:registry.registerResolved('main',main,profile.id)}));
  const runner = createSystemSshRunner();
  const worktrees = new SshWorktreeServer(registry,{profiles:[profile],runner});
  rpc = new GatewayRpcServer(new SshGateway({id:'probe',token:'probe',profiles:[profile],allowedCommands:[],runner,workspaces:registry}),undefined,undefined,undefined,undefined,worktrees);
  await new Promise(resolve=>rpc.server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:'+rpc.server.address().port;
  const call = async body => { const res=await fetch(origin+'/v1/worktrees',{method:'POST',headers:{authorization:'Bearer probe','content-type':'application/json'},body:JSON.stringify(body)}); return {status:res.status,body:await res.json()}; };
  console.log(JSON.stringify({before:await call({operation:'list',workspaceId:'main'})}));
  console.log(JSON.stringify({removeSeed:await call({operation:'remove',workspaceId:'main',path:seed})}));
  console.log(JSON.stringify({afterMain:await call({operation:'list',workspaceId:'main'}),afterSeed:await call({operation:'list',workspaceId:'remote-seed'})}));
  try { console.log(JSON.stringify({directAfter:await worktrees.execute({operation:'list',workspaceId:'main'})})); } catch(e) {console.log(JSON.stringify({directThrow:{code:e.code,message:e.message}}));}
} finally { await rpc?.close(); await fixture.stop(); }
NODE
~~~

原始 stdout/stderr（exit 0）：

~~~text
{"registered":{"ok":true,"value":{"id":"main","root":"/tmp/hepi-sshd-eOFcu9/remote-root/repo","created":true}}}
{"before":{"status":200,"body":{"ok":true,"value":{"projectRoot":"/tmp/hepi-sshd-eOFcu9/remote-root/repo","isGit":true,"isTopLevel":true,"currentWorktreePath":"/tmp/hepi-sshd-eOFcu9/remote-root/repo","worktrees":[{"path":"/tmp/hepi-sshd-eOFcu9/remote-root/repo","branch":"master","isMain":true},{"path":"/tmp/hepi-sshd-eOFcu9/remote-root/repo-worktrees/seed","branch":"seed","isMain":false}]}}}}
{"removeSeed":{"status":200,"body":{"ok":true,"value":{"removed":"/tmp/hepi-sshd-eOFcu9/remote-root/repo-worktrees/seed"}}}}
{"afterMain":{"status":500,"body":{"ok":false,"code":"execution_failed"}},"afterSeed":{"status":500,"body":{"ok":false,"code":"execution_failed"}}}
{"directThrow":{"code":"outcome_unknown","message":"the SSH host did not answer which checkouts exist"}}
~~~

源码 SHA-256：

~~~text
e12df8963cae6aaf0782a9c423e400b62d718f575a9ce4d07d6b30cd67da203c  packages/gateway/src/index.ts
567f345fceae8f9978c759f940d34fada84bd3cf6ee7bf926b6c97ca32757abc  packages/gateway/src/main.ts
b44cb8c4367d737d861a9b698ef48772a30f5e3cbaf93b6de58198c18579c898  packages/gateway/src/worktrees.ts
09059e2d3b2cf65f7104c8a56406858865f9f1ad732dbcc6bd40edc2d6f4bcfc  packages/gateway/src/filesystem.ts
32cc2a3f26d14a68ccf678f7184b9eb42011927d90002e52f3761a73916ce6d3  packages/gateway/src/ssh-workspaces.ts
918fc0ea00b352f70c982329a89d377a8121fc0fa2d351f01c47f449cdc14996  packages/gateway/src/environment.ts
83d22d0162c33c197d0a717aa259b3aa2b52c4e80593dc692eea5a3189ddd5d3  packages/client/src/gateway.ts
7115da3d02eb691ef002f5a2e504111bf8460e68ae2669b778d9cff6799bb832  apps/server/src/workspace-resources.ts
~~~
