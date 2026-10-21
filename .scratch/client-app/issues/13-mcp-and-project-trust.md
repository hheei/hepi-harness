# 13 — 通过命名客户端 API 管理 MCP 与 project trust

Type: implementation
Status: resolved
Blocked by: [06](./06-catalogue-projects-and-worktrees.md) (resolved)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

用户在 Web/App 明确知道 MCP/trust 作用于哪台配置宿主，不会因入口变化改错机器。

## Scope

承接当前 Web-host MCP 面板与 trust 的命名管理合同，并显式绑定配置宿主。区分 entry host、execution host 与 SSH profile；任何扩大到远程宿主管理的能力须另有授权，本票保持当前支持边界。

## Acceptance

- [x] 现有读取/修改/test/登录等受支持 MCP 操作及项目 trust 行为在正确配置宿主工作。
- [x] 缺少 host service 时返回命名限制，绝不改用 Backend 或任意 SSH 机器读取私密配置。
- [x] App 身份仅访问授权 client API，无法直通 /v1/mcp 或 /v1/execute；内部管理 token 不交给客户端，MCP 凭证不经 Backend 转存。
- [x] 客户端身份按明确流程授权 host-local 操作，撤销与 scope 切换生效。

## Implementation

The panel aggregate is declared **once**, in `packages/ui/src/lib/mcp-panel.ts` (framework-free; the host service and the
folder resolution are handed in), and both client entries answer it: the client ingress for the App and the Web page,
and the Web entry's Next route as its thin half. The routes are the same names as before, so the panel is unchanged in
what it asks for.

- `packages/gateway/src/ingress/mcp.ts` — `GET /api/mcp`, `POST /api/mcp`, `POST /api/mcp/test`,
  `POST|GET|DELETE /api/mcp/sign-in[/:flowId]` and `GET /api/project-trust`, answered from the host's own
  authenticated `POST /v1/mcp` (`HEPI_INGRESS_MCP_GATEWAY_URL`/`HEPI_INGRESS_MCP_GATEWAY_TOKEN`/
  `HEPI_INGRESS_MCP_GATEWAY_ID`, stated together or not at all). These are the only `/api` routes the ingress does not
  forward to the Backend.
- The folder a request names is sent as the **workspace id** (`/workspace/<id>` → `{ workspaceId }`), and
  `McpHostService` resolves it against the registry of folders that host serves
  (`packages/gateway/src/mcp/host.ts`, `McpHostRequest.workspaceId`): no caller synthesizes a path, another host's
  folder is refused there as `unknown-workspace` (403 `cwd-denied`), and `/durable` leaves the global configuration
  alone. The Backend's control surface keeps sending `cwd`, unchanged. **The id is verified first**: the ingress reads
  `/api/workspaces` and `/api/hosts` with its own service credential and forwards a folder-scoped request only when
  the Backend binds that workspace to `HEPI_INGRESS_MCP_GATEWAY_ID` and that gateway serves no SSH profile.
- Identity is the ingress's own admission; a device bearer is re-verified on the revocation interval while the request
  is in flight, and the abort reaches the host's own operation (`McpHostService.execute(request, signal)`), so a revoked
  credential — or a caller that simply disconnects — ends the work rather than letting it finish. A sign-in whose
  exchange was already under way stores nothing for that caller and reports an unknown outcome instead of a rollback it
  cannot perform.
- The panel and the trust dialog ask through the connection's client (`connection.client.request`), not the page's
  global `fetch`, so the desktop App reaches the client API on its own origin with its own credential. The trust
  dialog's boundary is a prop, so a fixture outside a workbench keeps the page's `fetch`.
- Four constructors in `mcp-import-core.ts`/`shell-words.ts` were rewritten from TypeScript parameter properties to
  declared fields: Node's strip-only TypeScript refuses parameter properties, and the gateway's own tests load these
  modules through `mcp-panel` now. No behavior change.

## Review corrections (findings at `eaf86ab`)

Three material findings, each fixed at the seam that owned it, with the reviewer's own repros run green.

| Finding | Disposition | Fix |
| --- | --- | --- |
| The ingress forwarded the caller's `workspaceId` to the configuration host unchecked: with two hosts both serving an id `local`, a workspace the Backend binds to another gateway was answered — and written — on the wrong machine. | `fix` | The binding is the Backend's fact, so the ingress asks it (`/api/workspaces`, `/api/hosts`, service credential, nothing cached) and forwards a folder-scoped request only when the workspace is bound to `HEPI_INGRESS_MCP_GATEWAY_ID` and that gateway serves no SSH profile; otherwise 403 `cwd-denied`. No path is synthesized and no cwd is treated as authorization. |
| The MCP branch applied the cookie's same-origin write guard to every identity, so a declared App origin could read but not add, test, sign in or cancel (403 `origin denied`). | `fix` | The guard is the cookie's: it applies to a Web session only. A device bearer from a declared App origin is served, and the CORS policy is unchanged; a cross-origin cookie write is still refused. |
| Revocation aborted the ingress's own HTTP call but not the work it started, and a client disconnect aborted nothing: a revoked sign-in still completed its OAuth exchange and stored credentials. | `fix` | The ingress aborts on a disconnected response as well as on revocation; the gateway passes that abort into `McpHostService.execute`, which threads it into the test connection, `authorizeMcp` and the OAuth store's commit point. Nothing is stored for a caller that left, the outcome is reported as unknown rather than as a rollback, and an already stored record is left alone. |

Reviewer repros (`/tmp/ticket13-review`), on the corrected tree: `public-seam-repro.ts` 2/2 pass (App-origin write 200;
`CANCELLED_HOST_HTTP_CLOSED true`), `workspace-binding-repro.ts` 1/1 pass (disable 403, configuration file unchanged),
`revocation-host-repro.ts` 1/1 pass (`OAUTH_TOKENS_PERSISTED_AFTER_REVOCATION false`). The repo's own
`packages/gateway/test/ingress-mcp.test.ts` gained the equivalent public-seam cases (collision, declared-origin write
vs cross-origin cookie write, disconnect, revoked sign-in) and now runs 9 tests.

## Evidence

`packages/gateway/test/ingress-mcp.test.ts` (9 tests, real Backend + real configuration host + real ingress over HTTP):
an add writes the host's `mcp.json` and a test starts the fixture server and reports `connected`/`4` tools; the listing
afterwards carries the recorded test answer; a project folder is read from that folder's own `.pi/mcp.json` with its
untrusted decision; another host's folder is refused `403 cwd-denied` and a non-routing cwd with it; the trust route
reads the host's `trust.json` and answers 405 for a write; a deployment with no host service answers 503
`mcp_unavailable` naming both variables while `/api/descriptor` still answers; and a device revoked while the host call
is out ends that call (`503 mcp_unreachable`) and the next request is 401.

Also passing: `packages/gateway` 343 tests, `@hepi/ui` 120, `@hepi/protocol` 51, `@hepi/app` 3, and the Web adapters
`host-cwd-ownership`/`durable-api`/`agent-definitions` (18). Typecheck passes for gateway, ui, web, app, protocol,
session.

Limits: the Web entry's Next route still exists (deleted in ticket 17) and keeps its own `HEPI_WEB_GATEWAY_URL`
resolution; the Android App is still blocked (ticket 04); no live deployment or paid provider is involved.

## Verification

现有 capability/trust 与 MCP 场景，加入口和配置宿主不相同、缺服务及越权拒绝。

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；新增问题依照[review policy](../../../docs/agents/review-policy.md)判断实际影响。

## Review notes

涉及 G2/G3，见[架构审查](../review-notes.md)。其中 record 项不形成额外依赖。完成本票即更新能力矩阵与本票状态；全部 Blocked by 关闭后才开始。
