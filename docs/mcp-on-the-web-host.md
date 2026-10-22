# MCP on the Web host

MCP configuration, tests and OAuth sign-in belong to the **Web host**: the account and filesystem of the machine the
Web UI runs on. The owner is the service already running there beside the Web container — the co-located
`hepi-gateway` — reached as a new operation on its authenticated surface. Nothing in this path puts an MCP credential
on the durable backend, and the Web container holds no MCP state.

See [the capability-integration spec](../.scratch/capability-integration/spec.md) decisions 36–42 for why the owner,
the placement and the secret boundary are fixed; this guide records what was built.

## Where the pieces are

| Piece | Where | What it owns |
| --- | --- | --- |
| `McpHostService` | `packages/gateway/src/mcp/host.ts` | The host capability: read, write, test, sign in, sign out, and one selected tool call |
| `packages/gateway/src/mcp/connection.ts` | same package | The one place a configured server is connected: entry resolved, values resolved, credential store, transport, close |
| `packages/gateway/src/mcp/invocation.ts` | same package | One tool call: validation, bounds, deadline, cancellation, result conversion, masking, cleanup |
| `packages/gateway/src/mcp/config.ts` | same package | The two `mcp.json` files, the OAuth state, and the folder trust decision |
| `packages/gateway/src/mcp/secrets.ts` | same package | Masking for every reported reason |
| `@hepi/protocol/mcp-secrets` (`packages/protocol/src/mcp-secrets.ts`) | the protocol package | pi-web's masking rules, preserved verbatim (MIT, Copyright (c) 2026 agegr); the Web panel and this gateway share the one copy |
| `POST /v1/mcp` | the gateway's authenticated surface | The one route the Web process calls |
| `packages/protocol/src/gateway.ts` | shared | The route's request and answer shapes, under the `@hepi/protocol/gateway` subpath: declared once, re-exported by the gateway, read by the Web adapter |
| `@hepi/protocol/mcp-ui` (`packages/protocol/src/mcp-ui.ts`) | the protocol package | The panel contract: `/api/mcp` and `GET /api/project-trust` answer shapes, declared once because the browser renders them. A declaration only: no route logic, nothing started or read |
| `@hepi/protocol/mcp-import` (`packages/protocol/src/mcp-import.ts`) | the protocol package | The paste importer, used twice around one boundary: the browser previews with it and the ingress re-parses with it, so the entry a person sees is the entry the host writes |
| `packages/gateway/src/ingress/mcp-panel.ts` | the client ingress | Composes the host's own answers into the panel's shapes: the one place that behavior lives |
| `packages/gateway/src/ingress/mcp.ts` | the client ingress | Those routes for a Web page or an App, answered from the host this origin runs on |

The Web origin is a presentation and proxy layer: it starts no MCP server and reads no configuration file itself.
The ingress reaches the host service **directly**, not through the durable backend, because a credential must never be
handed to the backend. (The retired Next entry's own `adapters/mcp-host.ts` and `adapters/mcp-surface.ts` did this job
before client-app ticket 17; both are gone and the routes they answered now belong to the ingress.) The backend takes part in MCP exactly one way: it calls `invoke` for a tool a conversation selected
([below](#from-a-durable-conversation-ticket-02)). It reads no `mcp.json`, starts no server, holds no OAuth state and
receives no credential, in either direction.

## Configuration

| Variable | Process | Role |
| --- | --- | --- |
| `HEPI_INGRESS_MCP_GATEWAY_URL` | **client ingress** | The host service that owns this Web origin's MCP configuration, e.g. `http://127.0.0.1:28788`; the only entry that serves a Web page or an App |
| `HEPI_INGRESS_MCP_GATEWAY_TOKEN` | **client ingress** | That service's bearer token, outbound only; stated with the other two or not at all |
| `HEPI_INGRESS_MCP_GATEWAY_ID` | **client ingress** | That service's name in the Backend's own vocabulary, which a folder-scoped request is checked against before it is forwarded |
| `HEPI_WEB_GATEWAY_URL`, `HEPI_WEB_GATEWAY_TOKEN`, `HEPI_WEB_LOCAL_GATEWAY_ID` | **retired Next Web entry** | The same three facts for the entry client-app ticket 17 removed. They are the names `~/.config/hepi/web.env` still carries as rollback material; an ingress deployment states the `HEPI_INGRESS_MCP_*` trio above |
| `HEPI_MCP_TOOLS` | **durable backend** | The operator's **fallback** presentation for MCP tools, as a JSON array of `{ gatewayId, scope, server, tool, description?, inputSchema? }` — identities and presentation only, never a command, URL or credential ([below](#from-a-durable-conversation-ticket-02)). It is no ceiling and grants nothing: a tool a host lists is grantable without an entry here, and a declared entry offers nothing until a conversation is granted. Unset, the backend declares no fallback and still installs `hepi.mcp` whenever a gateway is configured |

All three belong to the Web origin rather than to the backend: which computer's MCP configuration an origin serves is a
property of that origin, and one backend can serve several Web origins on different computers. None reaches the
browser. Unset, the MCP surface answers a named limit (below) and every other setting keeps working.

Project-scoped reads, writes, tests, sign-in and trust resolution require proof that the folder belongs to this
Web origin's local Execution Host. The directory resolver asks the Backend one question with its own service
credential — `GET /api/workspaces/:workspaceId/locality?gatewayId=HEPI_INGRESS_MCP_GATEWAY_ID`, answered
`{ local: boolean }` — and forwards only on an explicit `local: true`. The Backend owns that verdict: it is its own
binding membership (retained bindings included) plus its own host-profile answer, so a gateway with SSH profiles is not
this origin's host. Matching absolute paths on different hosts are not the same folder. Foreign folders, missing roots,
unreadable or unnamed ownership, a refusal and an unanswered query are all refused before the local MCP service is
called, and no verdict is cached. Global operations that name no
folder remain available through the configured Web-host service. Remote file and Worktree operations continue to
resolve their own Execution Host; the local restriction belongs to MCP and project-trust.

`HEPI_INGRESS_MCP_GATEWAY_URL` is deliberately a different variable from the backend's `HEPI_GATEWAY_URL`: in a split
deployment the backend reaches a gateway over an SSH tunnel, while the Web process must reach the host it runs on.

**As last recorded on 2026-10-18**, the workstation origin's `ingress.env` carries the `HEPI_INGRESS_MCP_*` trio —
naming the co-located gateway at `http://127.0.0.1:28788` with that gateway's existing independent token — so
Settings › MCP is served there and reads that host's own `mcp.json`; the earlier `HEPI_WEB_GATEWAY_*` trio in
`web.env` was the same three values for the retired Next entry. An origin that sets none answers the named limit,
which is the documented behaviour for a host that runs no MCP service.
[The 19d7cda deployment record](records/19d7cda-deployment.md) carries that dated evidence, and
[the four materials](client-ingress.md#the-four-materials) states which credential each process holds.

## Files the host owns

| File | Scope | Shape |
| --- | --- | --- |
| `<account home>/.pi/agent/mcp.json` | global | `{ "mcpServers": { ... } }`, the shape every MCP client uses |
| `<folder>/.pi/mcp.json` | project | the same shape, read and written only for a trusted folder |
| `<account home>/.pi/agent/mcp-auth.json` | credentials | one record per server, keyed `mcp__<name>|<url>` |
| `<account home>/.pi/agent/trust.json` | trust | folder path to `true`/`false`/`null`, the pi CLI's own store |

The account is the execution account of the host: its home's `.pi/agent`. `PI_CODING_AGENT_DIR` is deliberately not
consulted, so another process's agent directory can never stand in for the host's own files. The OAuth keys are the
SDK's own, so the `pi` CLI on the same host and this service share one account per server. Neither file is ever
created by a read.

## Operations

`POST /v1/mcp` takes one `operation` and answers `{ ok: true, value }` or `{ ok: false, code, message }`:

| Operation | What it does |
| --- | --- |
| `read` (`cwd?`) | The global file, the project file when a folder is named, and every entry described without any value |
| `write` (`scope`, `cwd?`, `name`, `config?`, `requireNew?`) | Adds, replaces or removes one entry, keeping every other key and the file's indentation; the answer is the listing after the change |
| `patch` (`scope`, `cwd?`, `name`, `patch`) | Changes named keys of one entry and keeps the value of every key the patch does not name (a `null` value removes the key), so a switch or an exposure change never needs the entry's secrets; the answer is the listing after the change |
| `trust` (`cwd`) | The folder's trust decision, read from the host's own trust store |
| `test` (`scope`, `cwd?`, `name`) | Starts the server, lists its tools, closes it, and reports the outcome with a masked reason |
| `sign-in` (`scope`, `cwd?`, `name`) | Starts (or joins) an OAuth sign-in and answers the flow's state |
| `sign-in-poll` / `sign-in-paste` / `sign-in-cancel` (`flowId`) | Reads the flow, hands back the redirected address, or cancels it |
| `sign-out` (`scope`, `cwd?`, `name`) | Removes that server's OAuth state, and cancels its sign-in if one is waiting |

The Web process maps these onto `GET /api/mcp`, `POST /api/mcp`, `POST /api/mcp/test`,
`POST|GET|DELETE /api/mcp/sign-in[/<flowId>]` and `GET /api/project-trust`, which is what Settings › MCP reads and
writes.

### Listing one server's tools (ticket 03a)

`operation: "tools"` answers the question `read` and `test` cannot: what tools does server *docs* have, and with what
schema. It is a sibling of `test` and shares everything a test already shares — the same entry door (`#target`), which is
where **a project folder's trust decision is enforced**, so a folder no decision trusts has its project `mcp.json`
unseen for a listing too; the same connection (`connectServer`), so the same environment, headers and OAuth store; the
same 30-second deadline composed with the caller's abort and with the service stopping, and a connection
closed in a `finally` whatever the answer was.

```json
{ "operation": "tools", "scope": "project", "workspaceId": "local", "name": "docs" }
```

```json
{ "ok": true, "value": { "scope": "project", "server": "docs",
  "tools": [{ "name": "search", "description": "Search the docs", "readOnly": true,
              "exposure": "direct", "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } } } }],
  "total": 1, "truncated": false, "pages": 1,
  "serverInfo": { "name": "docs-mcp", "version": "1.4.0" }, "durationMs": 41, "listedAt": 1792400000000 } }
```

- **A tool the server did not name is not a tool a person can select.** A server authoring a list is authoring
  presentation, and pi-mcp validates only `name` and `inputSchema` on the way up, so every other field is read by type: a
  numeric description falls back to the server's `title`, an `annotations` that is a string says nothing, a
  `readOnlyHint` that is not the boolean `true` is not a read-only claim, and an absent annotation is **unknown**, not a
  safe negative. A tool whose name is not a usable string is left out, and the answer says it is incomplete.
- **Exposure is stated per tool, as this host's own rule reads it**: `toolExposure` by exact name, else the entry's
  `exposure` — the rule a call already applies — with `exposureOverridden` saying which of the two answered. A `hidden`
  tool is **shown** rather than silently dropped, so a person reads "this one is marked hidden here" instead of learning
  it from a `not-exposed` refusal; only the call refuses. The lookup is exact-name only: a pattern key in `toolExposure`
  is stored, counted by `read`, and matches nothing (upstream's own rule accepts patterns; this host does not).
- **Name and description are masked; a schema is passed through whole.** They are the server's own text, so they go
  through the redactor a test and a result use, which holds the entry's literals and every value a `${NAME}` reference or a
  `!command` resolved for that entry. A schema is a document: nothing on this route resolves a reference inside one, the
  same rule `read` follows when it reports an entry's `env` and `headers` by name and never by value. No configuration
  value, credential or path is in an answer.
- **The bounds are the host's, not the server's.** 30 s (`MCP_LIST_DEADLINE_MS`), at most `MCP_LIST_MAX_PAGES = 8`
  `tools/list` pages — `client.listTools()` follows up to a thousand pages inside one deadline, which is a client's
  patience rather than a bound on a host holding a process it started — at most `MCP_LIST_MAX_TOOLS = 256` descriptors,
  `MCP_LIST_MAX_TEXT_CHARS = 300` characters of a name or description, `MCP_LIST_MAX_SCHEMA_BYTES = 32 KiB` for one schema
  (over it the schema is withheld rather than sent in pieces, because half an argument shape invites a call that cannot
  be validated), and `MCP_LIST_MAX_RESPONSE_BYTES = 256 KiB` for the answer as a whole: a gateway caps a **request** body
  at 1 MiB and sets no total cap of its own on a JSON answer, so these are the only bounds a listing has. A cut is always
  a prefix in the server's own order and always says so — `total` counts everything read, `truncated` says something was
  not carried, and `pages` says how far the read went.
- **It changes nothing, so it is safe to ask again.** `tools` is not one of the operations `control.ts` names a mutation,
  so the transport classifies a lost answer as this host being unreachable rather than as an outcome whose effects are
  unknown. A lost `invoke` never is, and that difference is the whole reason the two are separate requests.
- **Asked for, never inferred.** Nothing here lists a server in order to render a setting: `read` answers from the host's
  own files and starts nothing, and a listing is one named server, deliberately. A server's `listChanged` notification is
  not subscribed to — an answer is a snapshot taken at `listedAt`, and refreshing it is another request.

Verified by `packages/gateway/test/mcp-list-tools.test.ts` against the same controlled stdio fixture an invocation test
uses (the answer's own fields, hostile server text, masking of a value the entry was given with the schema kept whole,
the page bound, the byte bound, the configuration-carrying request, the missing/invalid/switched-off server, the folder
no decision trusts, an `unknown-workspace`, a gateway with no MCP capability, a caller that disconnects, and a service
that stops mid-listing), plus `test/control.test.ts` for the transport's own reading of a lost listing.

**Who asks it.** The Backend asks it for one conversation and one named server at a time, and only where a person acts:
when a surface opens one server's tool list, and when a grant of that server is written — a granted tool's description and
argument shape are copied from this answer and from nowhere else, so no client authors the text a model is offered. A state
read asks nothing of a host. See [A conversation's own grants](#a-conversations-own-grants-ticket-03b). The browser surface that puts a tool list in front of a person is [A conversation's tool states in the browser](#a-conversations-tool-states-in-the-browser-ticket-03c); Settings › MCP itself still shows a test's count, because that panel owns the host's configuration and not one conversation's choices.

### Invoking a selected tool

`operation: "invoke"` is the one operation that is not a host setting: it runs one already-selected tool of one
configured server and answers with the result, which is what a durable conversation records. The Backend reaches MCP
tools only through this operation, and the client ingress and the Web process never reach it at all — a browser has no
route to it, and Settings › MCP does not use it.

The request is deliberately narrow:

```json
{ "operation": "invoke", "callId": "…", "conversationId": "…", "workspaceId": "local",
  "scope": "project", "server": "docs", "tool": "search", "arguments": { "q": "x" }, "deadlineMs": 60000 }
```

- It names a **configured** server and **one** of its tools. It carries no `config`, `command`, `args`, `env`, `url`,
  `headers` or `auth`; a body carrying any of them is refused with `invalid_request` before anything is read or
  started, so an invocation can never be a way to have the host run something a selection did not name.
- `callId` is the caller's own identity for the call. The same `callId` in the same `conversationId` while it is still
  running is refused as `busy` rather than run twice, and the answer echoes it back with the server and tool it ran.
- `workspaceId` is resolved by the host against the folders it serves, exactly as the configuration operations resolve
  it, and a project scope is read only for a folder this host's own trust store trusts.
- The entry's own `enabled` and `exposure`/`toolExposure` are honoured: a switched-off server answers
  `server-disabled`, and a server or tool the host's configuration marks `hidden` answers `not-exposed`.
- The tool is looked up in the server's `tools/list` before it is called, so a name the server does not have answers
  `unknown-tool` instead of whatever a server makes of an unknown name.

What comes back is the tool's own result in the two shapes a conversation can record — text, and an image's bytes —
attributed to the call:

```json
{ "ok": true, "value": { "callId": "…", "server": "docs", "tool": "search", "isError": false,
  "content": [{ "type": "text", "text": "…" }], "truncated": false, "durationMs": 42 } }
```

A tool that reports its own failure is still `ok: true` with `isError: true`: that is an answer about the call, not a
transport failure. Every reported reason and every returned block is masked with the entry's literal secrets and the
values resolved for it, so a server that echoes the token it was given cannot return it. Nothing in the answer is a
configuration value: no command, no environment, no header and no credential, in either direction.

The bounds are the host's, not the caller's:

| Bound | Value | What it does |
| --- | --- | --- |
| Deadline | `deadlineMs`, default 60 s, clamped to 5 min | Ends the call and the connection it opened |
| Result | 256 KiB (`MCP_INVOKE_MAX_RESULT_BYTES`) | A larger result is cut and `truncated: true` |
| Arguments | 64 KiB (`MCP_INVOKE_MAX_ARGUMENT_BYTES`) | Refused as `arguments-too-large` |
| Concurrency | 8 calls per host | A call over the bound is `busy`, never queued |

**A call that may have run is never reported as a refusal.** `timeout` and `cancelled` both say the server may have
acted before the connection ended, so a caller must not read them as "nothing happened" and must not repeat the call
blindly. The Backend's own settlement of that uncertainty is ticket 02's; this contract only refuses to hide it. The one
exception is exact the other way: an attempt that ended while the entry's values were still being resolved never built a
transport and never started a process, so it answers with the same code and the words "no server was started, and nothing
ran for it" — the claim this host is entitled to make, and the reason a caller may retry that call.
A caller that disconnects — a revoked credential, a closed socket, a stopped Backend — aborts the call through the same
signal that ends any other operation, and the server process it started exits with it. Stopping the service aborts
every call still running and waits for their connections to close.

**Local only, so far.** MCP belongs to the local gateway beside the Web container, so a gateway serving an SSH host
serves no MCP and answers `mcp_unavailable`. An invocation over SSH is therefore not implemented and not implied: the
host that would run the tool is the Web host's own account, and a deployment whose backend can only reach a remote
gateway has no invocation path today. That is a limit of this slice, not a tested SSH behaviour.

### From a durable conversation (ticket 02)

The backend is the only caller of `invoke`, and a conversation reaches it through a native durable tool rather than a
route of its own. The adapter is `apps/server/src/mcp-conversation-tools.ts` (one extension, `hepi.mcp`); the
deployment's declarations are read and validated by `apps/server/src/mcp-declarations.ts`.

```text
Conversation's model calls mcp__<gatewayId>__<server>__<tool>
  -> backend resolves the conversation's own execution binding (workspace id, gateway id) at call time
  -> GatewayControl.invoke -> POST /v1/mcp { operation: "invoke" }
  -> this host service: entry, values, transport, server, masking, bounds
  -> the server's own blocks, committed as an ordinary durable tool result
```

- **A conversation's grant decides the offer; a deployment may state a fallback.** What one conversation is offered is its
  own durable grant list ([A conversation's own grants](#a-conversations-own-grants-ticket-03b)), and what it may be
  granted comes from the host's own listing of its configured servers. `HEPI_MCP_TOOLS` — a JSON array of
  `{ gatewayId, scope, server, tool, description?, inputSchema? }` — is the operator's **fallback presentation**: the
  identities and words this backend can state without asking a host anything, never a permission over what a grant may
  name, and never itself an offer — with a grant provider composed every registration is `deferred`, so a declared entry
  no conversation was granted is a name nothing resolves for anyone. A granted identity the deployment also declares has
  its declaration replaced by the host's own descriptor, so the model reads the host's words and its arguments are
  checked against the host's schema. A declared tool the host does not actually have is refused by the host as
  `unknown-tool` at the call, which is the honest answer and needs no second authority.
- **A declaration names identities, never configuration.** A gateway id, a scope, a server, a tool, and optionally a
  description and the server's own argument schema. `command`, `args`, `env`, `url`, `headers`, `auth`, `config`,
  `cwd` and `workspaceId` are refused **at backend startup**, naming the entry and the field, so this file cannot
  become a way to have the host run something no selection named. A declaration naming a gateway the backend does not
  configure is likewise a startup failure, not a tool that always fails at the call.
- **Configured, granted and currently runnable stay three states.** Nothing is offered until a conversation selects
  `hepi.mcp` through the existing per-conversation selection seam (`PATCH /api/conversations/:id/extensions`), and it
  is a non-default optional extension; a conversation bound to no execution workspace is refused both that selection and any
  grant, with 409 `unavailable_extension` and `host_unavailable`. A selected extension then offers a tool only if that
  conversation was granted it. The host still answers its own `enabled`/`exposure` and its own folder trust for every
  call: `server-disabled`, `not-exposed`, `not-authorized`, `server-missing` are the host's answers, re-derived nowhere
  in the backend, and a grant carries no second copy of them.
- **The identity of the call is the runtime's.** `callId` and `conversationId` are taken from the durable call, never
  from the model's arguments, and the host echoes `callId` back. `workspaceId` is the conversation's own binding and
  the host resolves it against the folders it serves; no caller names a path.
- **A call that may have run is never repeated.** Each registration is `replay: "unsafe"`, so after a crash the
  runtime settles the interrupted call as `interrupted` — "was interrupted and may have partially run" — and does not
  run the body again; the backend retries nothing at any layer. An outcome the transport cannot settle
  (`outcome_unknown`, `timeout`, `aborted`, `protocol_error`) and the host's own `timeout`/`cancelled` are recorded
  as uncertain refusals that carry the same notice, never as refusals that claim nothing happened.
  `gateway_offline` and `unauthorized` do claim it, and say so.
- **A caller that goes away ends the host request.** The tool's abort signal is handed to the invoke request, so the
  cancellation reaches this host's abort path and the server process it started exits with the call.

Verified by `apps/server/test/mcp-conversation-tools.test.ts`: a real local gateway with a real stdio fixture server
(native name, argument schema, committed result, host refusals, credential masking, a non-MCP gateway's
`mcp_unavailable`, cancellation that ends the host's server), and `test/mcp-replay-crash-child.ts`, which SIGKILLs a
backend **inside** a call whose side effect is already on disk and reopens the same store: the effect stays one line,
the reopened process reaches the host zero times, and the call settles as `interrupted`.

### A conversation's own grants (ticket 03b)

A grant is one conversation's durable allowlist of MCP tools, and it is a person's act: no route in this repository grants
a tool to a model that a human did not choose, and no model grants a tool to itself. The document is
`apps/server/src/mcp-grants.ts` (`hepi.mcp-grants`, conversation scope, `fork: "initial"`); the offer a grant implies
is written into the framework's own `pi.agent.modelTools` by the same commit, so the two records of one fact cannot drift.

A grant lives on the seam that already carries a conversation's selection, `/api/conversations/:id/extensions` — one
read, one write, no second route family. The write's body states the extension names, as it always did, and an optional
`mcp` section:

| Request | What it does |
| --- | --- |
| `GET /api/conversations/:id/extensions` | The conversation's selected extensions, the tool names the runtime resolves as its offer, and its MCP state: whether `hepi.mcp` is selected, the servers the **host** configures (read from its files), its grants, and the offered MCP names. Starts no server. |
| `GET /api/conversations/:id/extensions?mcp=<server>` | The same answer plus that one server's listed tools, asked of the host now. The backend's only request that ever starts a server to ask. |
| `PATCH /api/conversations/:id/extensions` with `{ mcp: { server, tools } }` | Replace one server's grants by exact tool names. `tools: []` revokes every grant of that server, without asking the host. Writes the grants and the offer in one commit. |
| `PATCH /api/conversations/:id/extensions` with `{ extensions }` | Write the extension selection, as it always did; `mcp` may ride along, and either half may be left out to say nothing about it. |

- **The host's listing is the only source of a grant.** A grant of a name the host did not list is refused
  `not_listed` (409) rather than written down to be refused on every call, and a server the host has no entry for is
  refused `server-missing` (409) — both asked of the host, never of this deployment's environment. `HEPI_MCP_TOOLS`
  permits nothing: a tool it never names is grantable the moment the host lists it.
- **A descriptor is a snapshot, never an authority.** An entry carries the host's masked description and argument shape as
  they stood at `listedAt`, plus the identities `gatewayId`/`scope`/`server`/`tool`. It carries no command, no `env`, no URL, no header, no
  token, and no route accepts one: a grant body naming `command`, `args`, `env`, `url`, `headers`, `auth`, `config`,
  `cwd`, `workspaceId` or `token` is refused by name before anything is written, and the fields themselves come from the
  host's own listing, never from a request body. Whether the folder
  is trusted, the entry switched on and the tool exposed stays the host's answer, re-read at every call.
- **A host that withheld a schema is granted without one.** The listing drops an over-bound or non-object `inputSchema` and
  says so; the grant stores `schemaOmitted` and the registration is offered with an empty argument object, which the host
  validates anyway. A tool a person chose is not refused because its arguments cannot be previewed.
- **The granted descriptor is the live offer.** The registration a conversation resolves is rebuilt from its durable
  grants, so the description the model reads and the argument schema the runtime validates a call against are the host's
  own — a re-grant after the server changed its schema takes effect on the next resolution, and a restarted backend
  restores the same registrations from its store without asking a host anything.
- **A call is sent in the scope its own conversation granted.** One tool name is one registration process-wide, and a
  global and a project entry of the same identity carry the same name, so the registration cannot say which file a call
  belongs in. The conversation's own grant can: the request states that grant's `scope`, and a registration's scope is
  used only where no grant document exists (ticket 02's composition). A newer descriptor of one identity replaces the
  registration the moment its scope or presentation changes, and the newest `listedAt` is kept even when nothing changed.
- **A grant that cannot be offered is refused before it is written.** Granted descriptors are registered ahead of the
  operator's fallback, so a deployment whose `HEPI_MCP_TOOLS` fills one server's bound never takes the room a person's
  grant needs; the fallback past the bound is the entry named as refused. A grant whose own descriptors exceed the bound
  is answered `offer_unavailable` (409) and writes nothing, because a grant that offered nothing would be a false record
  of a person's own act.
- **Revocation is immediate, and in-flight work is not unwound.** Taking a grant away removes the name from the offer, so the
  next call settles `tool_unavailable` before arguments are validated and before a request leaves this process; the call
  body also re-reads the grants, so a revocation that lands mid-turn is answered `not_granted` with the claim that nothing
  was sent. A call already at the host is left to its own abort or deadline and is never re-run, per ticket 02's
  `replay: "unsafe"`. A revocation asks no host, so it works on an offline one.
- **A branch holds none of its source's grants.** `fork: "initial"` is the runtime's own semantics for a choice made for
  one conversation, and the backend's attach path reconciles a stored offer against the branch's own empty grant list, so the
  names the branch inherited in `pi.agent.modelTools` are dropped rather than lingering as offers nothing can run. A
  delegation already starts its child with no model filter to add to.
- **A child inherits nothing, and a grant written on a branch or a child stays there (ticket 04).** The delegation seam
  creates a child with `modelTools: null`, so a task-owned child — which the runtime gives a copy of its parent's
  `pi.agent` — is offered none of its parent's MCP tools, and its own grant document starts empty. There is no inherited
  grant: a child that attempts a tool its parent holds settles `tool_unavailable` before any request leaves this process.
  A grant written **on** a branch or a child is that conversation's own and never moves its source's offer, which is the
  same `fork: "initial"` rule read in the other direction. Inheritance is therefore an explicit policy a definition would
  have to state, not a consequence of being delegated to; none is configured today.
- **A child is still a conversation, so a grant written on it is offered there.** Nothing inherited, nothing copied: the
  same seam, the same deferred registration, the same durable document. The one case that needed a real change is a child
  delegated from a **definition**, because `pi.agent.tools` is then an exact enabled list (`read` and nothing else) and
  the runtime filters that set before `modelTools` decides the offer — so a grant written there would have been loaded
  into the offer and still not offered, a 200 for a grant no resolution could reach. The grant write now appends the
  granted names to that exact list, and only to an exact list: an unset or `{ remove }` filter states no allowlist of its
  own and is left alone. The same fact is stated in every report: `reportedSelection` applies `tools` before
  `modelTools`, the order the runtime itself uses, so a restricted child's `toolNames` and the selection seam's
  `offered` list name only what a call would really meet.
- **A stop ends the call, and a resume never repeats it.** `POST …/abort` was already covered; a **stop** is a
  different contract (it holds the conversation, and its resume is a person's explicit act), and it ends an in-flight MCP
  call through the conversation's own scope: the caller's abort reaches the invoke request, the host's server process
  exits with it, and the call settles as an uncertain end. The resume starts no work of its own, so the recorded
  settlement stands, the side effect stays one, and nothing about the stop or the resume relaxes `replay: "unsafe"`. A
  parent's stop stays local; `POST …/subtree-control` is the only seam that reaches children, each with its own captured
  outcome.
- **One conversation runs one MCP call at a time.** Every MCP registration carries `executionMode: "sequential"`, the
  runtime's own round rule (pi-durable `dist/harness/generation.js`: a round containing an offered sequential call starts
  its calls one after another in call order). The host's own bound is eight calls **across every conversation**, so
  without this a single model answer asking for nine tools would take every slot and the ninth — and every other
  conversation's call — would be refused `busy`. The bound is per conversation, two conversations still run at once, and a
  round that mixes an MCP call with ordinary tools runs in call order.
- **A restart re-offers from the store.** `modelTools` is durable, so a reopened backend offers exactly the tools a
  conversation holds grants for, with no listing asked of anyone; a conversation with nothing to change is written nothing.
  A call in flight when the process died stays settled as it was recorded: `replay: "unsafe"` is unchanged by any
  lifecycle handling, so recovery settles it `interrupted` and never repeats a side effect.
- **No self-discovery.** This backend installs no `tool_search` extension and adds no wildcard: a deferred name a
  conversation was not granted has no route to its own `modelTools`, and `tools: ["*"]` in a grant request is refused
  by name rather than expanded.

Verified at the seam by `apps/server/test/mcp-grants.test.ts` (the request shape and its refusals, a grant body naming a
host-owned key refused by name, the host's configuration read as a server list, a granted entry as the host's own words, an
answer that is not a listing, the offer a grant set implies across all three `modelTools` shapes, and one durable case that
grants, revokes, branches and reopens the same SQLite file) and in `apps/server/test/mcp-conversation-tools.test.ts` (a tool
**no** deployment declared listed by its host, granted and run; a granted schema refusing a bad call before the host is
addressed; select-and-grant then run; a grant refused for an unlisted tool or an unconfigured server; a switched-off server
refusing its own listing; a hidden server listed and refused at the call; grant and offer surviving a real backend restart
over the same store; a fork isolated from its source's grants; a revoked tool refused on the next call with the host's
server never started for it; and ticket 04's lifecycle cases — nine calls in one round all settling while a second
conversation's call is not refused `busy`, a grant written on a branch staying there while the source keeps its own, a
delegated child offered none of its parent's tools with its attempt refused before any host is addressed, a conversation's
own stop ending the call it was running with the host's server exiting and a resume repeating nothing, and a
definition-restricted child reporting exactly the tools its own filter enables while a grant written on that child is
offered and really runs).

### A conversation's tool states in the browser (ticket 03c)

Settings › Extensions, in the **conversation** scope, under the `hepi.mcp` extension, is where one conversation's granted
tools are seen. It is the same panel that writes whether `hepi.mcp` is selected at all, and the MCP block lives inside it
because a selection and its grants are one durable fact on one seam. Neither shared shell file gains a prop and no new
route family is introduced.

- **The four states are four answers, each read from the one fact that states it** and never collapsed into one badge:
  *configured* is the host's own file, answered by the state read; *exposed* is the host's listing of that server, asked by
a person; *selected* is this conversation's grant; *currently available* is all three plus the conversation selecting
  `hepi.mcp` and being bound to a workspace whose gateway resolves. Nobody pressing List changes none of those, so an
  unasked exposure reads as a question (`exposure not asked`) rather than as a "no".
- **Discovery is explicit and per named server.** Opening the panel makes one request, the state read, which asks the host
  to read its files and starts no server. A server's tools appear only after that server's own "List tools" press —
  `GET /api/conversations/:id/extensions?mcp=<server>` — and a listing grants nothing: the checkbox is a separate act
  that writes one grant, and clearing it writes one revocation, which the backend answers without asking a host. No
  route here lists several servers at once.
- **Refusals keep the seam's own name.** `needs-auth`, `server-disabled`, `project-untrusted`, `server-missing`,
  `unknown-workspace`, `timeout` and `cancelled` are rendered from the seam's code rather than a second status
  vocabulary; an empty listing reads as an empty listing, a truncated one says how many of how many it carried, and an
  unreachable host reads as one — three different sentences, never the same.
- **An unread configuration is unknown, never an absence.** The host's configuration read is what states *configured*, so
  when it answers nothing — an offline host, a gateway this deployment does not configure, a folder this host does not
  serve — the seam answers `serversKnown: false` with its own `serversRefusal` code instead of an empty list, and the
  panel lists the **union** of the servers the host names and the servers this conversation holds grants of. A server only
  a grant names is shown with `configured: unknown` and `availability unknown`, its grant stays selected and its
  revocation stays offered: an empty set asks a host nothing, so revoking works while the host is away. The host's own
  named refusal is kept as it is — the panel adds no status of its own.
- **Browser state holds no credential, no resolved value and no host path.** The projection (`mcpPanelState`) is an
explicit allowlist published as one machine-readable attribute on the panel's own root, so a check states what browser
  state *is* rather than trusting that nothing unwanted was copied: no `sourcePath`, no command, no environment, no
  header, no token, no `inputSchema` and no `cwd`. The host's own masked description is what a person reads; a schema the
  host withheld says so and is shown as withheld, not as an empty object presented as the truth.
- **A conversation's own limits are stated before any server's.** A conversation bound to no execution workspace, or one
  whose workspace resolves to no gateway, states that first; an unselected `hepi.mcp` states that the extension is
  selected, not that the tools are unavailable.
- **Every answer belongs to the conversation that asked it.** The seam answers a whole conversation per request, so a
  read, a listing and a write are all fenced by the conversation (and the mount) they were made for: switching the
  conversation in the sidebar is a new block — `key={sessionId}` — and an answer that lands afterwards is dropped rather
  than painted over the new conversation's grants, listings or refusals. A write that lands while the person is back on
  the conversation it was made for re-reads it, because the view that answered before that write may be older than the
  document; the next checkbox then derives its body from the set that conversation actually holds.
- **The extension switch is the newer statement of its own selection.** The switch above the block writes the same
  conversation, so a flip is read from that prop immediately — grants stay, availability goes — and the block re-reads
  the conversation rather than keeping its own snapshot, which is one request that asks no host to connect anything.

Implemented as `packages/ui/src/lib/conversation-mcp.ts` (route and body builders, the state reader, the row derivation
and the allowlisted projection) plus `packages/ui/src/components/McpConversationTools.tsx`, mounted by
`ExtensionsConfig`. The Web origin's adapter forwards both halves of the seam — the read, its `?mcp=` query and the write —
at the Backend's own status and reason, so a refused write names the limit instead of showing a grant as made.

Verified by `packages/ui/src/lib/conversation-mcp.test.mjs` (the four states as four facts, per-server listing routes, a
listing's bounds and refusals, the whole-set grant and revoke bodies, the conversation's own limits, a changed descriptor
and an unknown exposure, a selection the panel above just stored, and a hostile body whose credentials and host paths
must not reach the projection), `apps/web/e2e/mcp-skills/ux-mcp-tool-states.mjs` in a real browser against the production panel (no
listing on mount, one server per press, the four states read per tool, a named refusal, one grant and one revocation each
as one write, the credential/host-path absence above, an extension flip that takes availability away and a re-read that
brings it back, and two conversations switched while a listing and a write are still in flight). The unit half is
`packages/ui/src/lib/conversation-mcp.test.mjs`; the whole journey is
[the ticket 05 section](#the-whole-journey-observed-ticket-05).

### The whole journey, observed (ticket 05)

One browser journey states what the tickets above state one seam at a time: a person adds and tests a server in
Settings › MCP, opens Settings › Extensions in the conversation scope, lists one server's tools, selects three of them,
and the model then calls one and the transcript shows what the server answered. It runs against the deployed shape — the
production Vite Web build served by the real client ingress, the real Backend over its own SQLite files, a real
execution gateway on its own agent directory, the real MCP host service, one Chromium — with the stdio fixture server as
the only stand-in, since it is the host's server and not the code under test. The provider credential is stored through
the ingress the way a person stores one, and its base URL is the run's own controlled completions endpoint, so no paid
request is made.

```
pnpm --filter @hepi/web build
node apps/web/e2e/mcp-skills/ux-mcp-acceptance.mjs      # or: pnpm --filter @hepi/web test:mcp-acceptance
```

The scenes, and what each is evidence for: add/test and the host's own file (`mcp.json` holds what was pasted, no
credential reaches the page); **no auto grant** (the panel names the host's server before anyone chose anything, and
selecting `hepi.mcp` offers no tool and writes no grant — a listing is not a grant); list → explicit selection (one
press lists one server, and each tick writes exactly one grant and the runtime's own offer names it, and the grant
document carries no host-owned key); **real invocation** (the controlled model asks for the granted tool by its own name,
the entry commits with the host's facts on it, the answer is in the transcript, and no configured value reached the
model's prompt); bounded output (a 400 KB result arrives truncated and under 256 KiB); changed schema (a changed
description makes the panel name that grant stale); disabled (a switched-off server is stated, a call is refused
`server_disabled` with no "may have acted", and no earlier entry was repeated or replaced); offline (`serversKnown:
false` with its reason, the conversation's grants kept, a listing a named refusal, and a revocation that still works
because it asks a host nothing); backend restart (the grant is re-offered from the store alone and one call runs once);
cancellation (an in-flight call ends with the caller, settles uncertain, and is recorded once); fork (a branch holds none
of the source's grants and is offered none, while the source keeps its own); untrusted project (a project server in a
folder with no trust decision is refused by the host's own name with the missing decision stated, and a grant writes
nothing); SSH (a gateway started with `HEPI_SSH_HOST` answers `read`, `tools` and `invoke` with
`mcp_unavailable` — SSH file support does not imply MCP execution on a remote host). A deployment with no worker
definition states the delegated-child half as unexercised rather than claiming it.

Two product defects were found by the journey and fixed at their own seams, both in the browser half and both invisible
to a seam-by-seam test:

- **The conversation scope was unreachable.** `ExtensionsConfig` read and wrote `/api/sessions/:id/…`, the retired Next
  BFF's vocabulary, while this deployment serves only the Backend's `/api/conversations/:id/…`; the panel therefore
  answered "conversation not found" and offered the default scope alone, so no person could reach a conversation's MCP
  tools at all. It now asks the Backend's own route.
- **One tick hid the rows it was choosing from.** A grant write's answer states the conversation's grants and offer but
  carries no listing (only a listing read does), and the panel read "no listing in this answer" as "no listing held",
  dropping every tool of that server the moment the first grant was written. `withHeldListings` in
  `packages/ui/src/lib/conversation-mcp.ts` now keeps the readings the panel already holds for the servers an answer says
  nothing about — a state read asks no host to connect anything, and a revocation asks it nothing at all — and
  `appliedWrite` is the write's own use of it. The rule belongs to the reading rather than to one caller: the panel's
  re-read after a refused listing, and the re-read an extension flip triggers, need exactly the same thing.

The fixture server gained one opt-in switch for this: `PI_WEB_FIXTURE_LIST_ECHO_FILE` reads a tool description from a
file, because a host masks every value its configuration holds, so a description varied through an environment value
arrives as a redaction and "the server said something different" would read identically both times.

### Sign-in is the paste flow

The browser runs on the user's computer, which is not the Web host, so the authorization server's redirect cannot
reach a loopback listener on the host. The host offers the authorization URL, the user approves in their browser and
hands back the address they were sent to. That is upstream's own fallback for a callback the browser cannot reach.
A flow keeps waiting for 5 minutes, an ended flow stays readable for a minute, and a pasted address whose `state` is
not the flow's is refused while the flow keeps waiting.

### Project scope is trust-gated

A project `.pi/mcp.json` is trust-requiring content: the host's own resource loader reads it only for a folder with a
trust decision. Writing one behind an untrusted folder would therefore create a file nothing connects, so the host
refuses it with `project-untrusted` and names the folder whose recorded decision is what refused it. The decision
comes from the host's own `trust.json` — the store the `pi` CLI writes — read through `GET /api/project-trust`.

This service only **reads** that store, and so does the whole Web origin: there is no `POST /api/project-trust`, no
Web trust writer, and no request for a decision carried through the durable backend. Recording a decision asks a
person at the machine that owns the folder, so the surfaces that meet an untrusted project — the page's trust dialog
and Settings › MCP's notice — **state the limit and where the decision belongs**, and offer no control whose request
this deployment does not serve:

> Recording the decision is not something this Web origin can do: it belongs to the machine that owns this folder.
> There, in the folder itself, the `pi` CLI records it with its `/trust` command — the `pi` CLI shares this
> `trust.json`, so the decision applies to Pi Web and the CLI alike.

The page's trust dialog is therefore a **read-only** view: it opens from the restricted-mode banner and from Settings ›
MCP, reads the folder's trust and lists what its `.pi/mcp.json` would connect, and offers only Close. Its one GET is
the same answer the panel reads, so a decision recorded on the host shows the next time either reads. Nothing on the
page holds a write's progress or failure, because nothing on the page writes.

This is also why MCP does not depend on a route that answers nothing: before this ticket `/api/project-trust`
answered 501 for every cwd, and the MCP surface now reads the decision from the host that owns the folder.

### Masked failures

Every reported reason is masked: a test's error and stderr, a sign-in's error, and a pasted denial's description. The
values replaced are the entry's literal env and header values, the parts of its URL, command and arguments that look
like credentials, and every value actually resolved while connecting (`${NAME}`, `$NAME`, `!command`). Masking is
applied longest-first, so a value is never left half-replaced by a shorter one inside it. A listing never reports a
value at all: env and header names only.

### The named limit

A gateway that serves no MCP — an SSH gateway, which executes and reads on a remote host, or any gateway constructed
without the capability — answers `{ ok: false, code: "mcp_unavailable", message: "this gateway host serves no MCP
capability" }`. A client ingress with no
`HEPI_INGRESS_MCP_GATEWAY_URL`, answers 503 with the same code and a message naming the variables to set. Both are limits about the deployment, not refusals of what the caller asked for, and every other
setting keeps working.

## Bounds

- A test may take 30 seconds end to end and 15 seconds per request; a `!command` value 10 seconds, or less when the
  caller's abort or the operation's deadline ends it early.
- A listing takes the same 30 seconds and the same 15 seconds per request, reads at most 8 `tools/list` pages, and
  answers at most 256 descriptors, 300 characters of a name or description, 32 KiB of one schema and 256 KiB for the
  whole answer (`MCP_LIST_*` in `packages/protocol/src/gateway.ts`). A read that starts nothing needs no concurrency
  bound of its own: it is one server, asked on purpose, and its process is closed in a `finally` whatever answered.
- An `mcp.json` larger than 1 MiB is reported as `too-large` and neither read nor rewritten.
- A write is written beside the target and renamed over it, at mode 0600, so a partial file is never left behind.
- The host's own environment reaches a stdio server, as upstream's default transport does. An entry that references
  the Web process's login password is not a case here: that variable belongs to the Web container, which is a
  different process on the same machine.

## The browser surface

Settings › MCP is the existing panel, wired to the host service through whichever entry the client reached. It lists
the host's own configuration, adds a server from a pasted config, tests one, signs in and out, and removes one — each
answered with the listing the host read after the change, so no page reload is needed. The panel asks through the
connection's own client, not the page's global `fetch`, so it reaches the client API from a desktop App (another
origin, with a device bearer) exactly as it does from a browser page. Its reads, writes and flows belong to one
workflow module, [below](#the-panels-own-workflow-ticket-07), rather than to the renderer.

- **The folder is resolved before the host is asked.** A browser cwd is a routing address (`/workspace/<id>`), which
  the host knows nothing about. The client ingress sends the **workspace id**, and the configuration host resolves it
  against the folders it serves, so no caller synthesizes a path. The panel is told the address it sent, which is what
  it shows. The ingress refuses a folder that is not this origin's own, by comparing the Backend's binding of the
  workspace id with
  `HEPI_INGRESS_MCP_GATEWAY_ID` and requiring that gateway to serve no SSH profile — because a folder *name* is not an
  identity: two machines can each serve a folder called `local`, and the one that must not be written is the other one.
- **The host stops when the caller does.** The ingress aborts its own call when the caller disconnects or its device
  credential is revoked, and the gateway passes that abort into the operation it is running, so a server being started
  or a sign-in mid-exchange ends there instead of finishing unowned. It reaches the attempt from its first step: a
  configured `!command` value is run with that same abort, and the connection is refused if the caller or the deadline
  ended while values were still resolving, so a cancellation is never a way to have the host start a server — or run a
  value command — for a request that already left. That refusal is reported as `cancelled` or `timeout` with the words
  "no server was started, and nothing ran for it", never as a call that *may have acted*, because this host knows it did
  not. A sign-in whose exchange had already begun stores
  nothing for that caller, and says so as an unknown outcome rather than claiming an exchange it cannot undo was undone.
  The folder resolved is the one the cwd names, never the group it is shown as: a project's second folder and a
  checkout hepi created for it each have their own `mcp.json` and their own trust decision on the host, so selecting
  one of them reads and writes that one, and making another folder of the project the default moves neither.
- **A test's last answer is kept in the Web process**, keyed by the entry the host described, so reopening Settings
  still shows the Connection row. The host keeps no test history, as upstream keeps none, so a Web process restart
  loses it and the row reads `on` until the next test.
- **A test's answer is a count, not a list**, so the panel shows how many tools were found and no names. The host can list them now (`tools`, the section above), and nothing in this panel asks it to yet: a conversation's own tools are shown under [the conversation's tool states](#a-conversations-tool-states-in-the-browser-ticket-03c), where a person asks for one server by name.
- **The panel offers no control the host cannot perform.** The Code mode settings belong to the sessions' runtime, not
  to this host, so the panel is given none and shows no Code mode row; the host keeps no copy of a removed entry, so no
  Undo is offered; and recording a folder's trust decision asks a person on the host that owns the folder, so the
  panel says where the decision is recorded instead of offering a button whose only possible request this deployment
  does not serve. The same rule covers a project **add**: a project server is written only where a decision already
  trusts the folder, so a folder no decision trusts keeps its Project option closed with that reason and the
  `/trust` instruction, rather than offering a step the host would refuse.
- **A deployment that cannot serve MCP says so in the dialog**: no MCP host service configured, or a host service that
  does not answer, is a named limit with no server list and no controls, not an empty list.

### The panel's own workflow (ticket 07)

The panel's reads, its writes and both flows that run beside them are one module, not a sequence of `useEffect`s and
request counters inside the renderer:

| Piece | Owns |
| --- | --- |
| `packages/ui/src/components/mcp-workflow.ts` | the overview readout (fenced by request), the selection the listing implies, every write's pending/answered/failed state with the readback after it, Test per server, and a sign-in's polling until it ends or is disposed |
| `packages/ui/src/components/useMcpWorkflow.ts` | the one React binding: one workflow per connection and folder, a `useSyncExternalStore` snapshot, disposal at unmount |
| `packages/ui/src/components/McpConfig.tsx` | the panel: rows, notices and fields, the Add pane's draft, and the focus a finished change gives back |

The rules this makes explicit, each of which the panel would otherwise have to remember:

- **One readout, one fence.** A write's answer is the listing the route read after the change, so it replaces the
  overview and drops a read that was already on its way; a refused or timed-out write reloads the listing instead of
  showing its intent as saved. A read that failed leaves the listing *unread*, never empty.
- **A change is what the route answered, not what was asked.** Nothing is written optimistically: a switch, an
  exposure, a removal, a group switch, a sign-out and an Add all take the listing their answer carries, and the
  selection follows it (the new server after an Add, the restored one after an Undo).
- **Test runs beside a write; a write never runs beside a write.** Test writes no file, so it is not queued behind a
  change and a change is not queued behind it; its answer is kept per server and about the entry it tested (its
  `configKey`), and it becomes that row's status while it is the newest.
- **A sign-in outlives the viewport, and stops with the connection.** The flow lives on the host, and the workflow
  polls it on its own timers until the flow ends or is gone — hiding the MCP section behind another Settings tab
  neither stops the polling nor cancels the flow. A finished flow reads the overview again, for Signed in and the
  Connection row. Replacing the connection, or closing Settings, disposes the panel: its polls and its undo notice's
  timer end there. A test already on its way is deliberately not aborted, because the route records what it found for
  the next visit.
- **The view keeps the form.** The Add pane's paste, its picked server, the values typed into it, and the Code mode
  budget field are the renderer's own drafts; the workflow never sees a keystroke. An Add's answer is returned to the
  pane rather than applied for it, because only the pane knows whether the draft it sent is still the draft on screen.

Verified by `packages/ui/src/components/mcp-workflow.test.ts` (the readout's fence, a refused change that reloads
instead of claiming a save, a test beside a change, a sign-in polled to its end by the workflow's own timers, a
disposed workflow that asks nothing more, an undo notice that expires on its own timer, and an Add that selects and
tests what it wrote), and in a real browser by `apps/web/e2e/mcp-skills/ux-mcp-workflow.ts` (the production Settings
panel over a host-shaped seam: one read for the first listing, a pending change and the listing its answer carries, a
refusal shown with the host's own reason plus the re-read, a sign-in that keeps polling while its tab is hidden and
ends there, a test whose answer becomes the row's state, and a replaced connection that stops the old panel's polls).

## Not built

- A default of grants — "these tools for every conversation I start" — is not a decision this effort has made. A
  deployment that wants tools broadly available has its declaration path, whose entries are offered as an operator
  fallback, and nothing reads that fallback as a grant. A project-scoped grant document likewise does not exist: a grant is one conversation's
- Recording a folder's trust decision from the browser; it belongs to the `pi` CLI on the host that owns the folder.
  The Web origin reads `trust.json` and never writes it, so there is no `POST /api/project-trust`, no trust writer
  and no route that would carry a decision through the backend.
- A project `.pi/mcp.json` write to a folder no decision trusts, and trusting one in the same step as a write. A
  fresh folder is not a special case: this deployment records no decision, so the add pane says where the decision
  belongs instead of asking the host to trust and write together.
