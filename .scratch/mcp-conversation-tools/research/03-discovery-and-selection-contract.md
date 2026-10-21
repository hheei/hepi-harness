# Ticket 03 research: the live tool-descriptor and fine-grained selection contract

Read-only research. Date 2026-10-19. Worktree `.dev/worktrees/mcp-conversation-03`, branch
`impl/mcp-conversation-03`, base `ebf26df` (ticket 02's tip, which contains `integration/client-app` at `283caa0`:
`git merge-base --is-ancestor integration/client-app HEAD` exits 0). No Gateway, protocol, backend, UI or deployment
file is changed by this report; nothing was deployed and no live host was probed. Spec:
`.scratch/mcp-conversation-tools/spec.md` (approved architecture, restored body). Ticket:
`.scratch/mcp-conversation-tools/issues/03-trust-selection.md`. Every claim carries `path:line` read in this
worktree. What the code says and what a person must decide are kept apart (§7).

## 0. Answers in one screen

| Question | Answer, from the code | Section |
| --- | --- | --- |
| D1 minimal Gateway-owned live tool descriptors | One new **read-only** MCP host operation, `tools`, beside `read`/`trust`/`test`. It reuses `connectServer` and `client.listTools` and answers masked, bounded descriptors (name, first-line description, readOnly, exposure, inputSchema). `connectAndList` already holds exactly those tools today and throws their shapes away. | §2, §3 |
| D2 where a descriptor is stored | Two facts, two owners. The Gateway answers descriptors on demand and persists nothing. The backend stores durably only what a conversation was **granted** (identity names, plus the descriptor read at grant time), refusing host-owned keys by name. No session catalog, no browser-held schema, no credential in either. | §4 |
| D3 fine-grained selection within native Pi seams | Keep `hepi.mcp` as the only extension and register its tools `deferred: true`; the grant writes `pi.agent.modelTools` through the existing `configure` seam — the same field the runtime's own `addTools` writes for `tool_search`. One writer: the backend. Existing route, existing document semantics, no new registry concept. | §5 |
| D4 `deferred` vs a `modelTools` list | `deferred: true` *is* the native answer to "default unselected tools to unavailable": an unset `modelTools` offers no deferred tool at all, and `add` only ever loads deferred ones. The hazard is that `tool_search` loads any deferred tool by itself. | §5.2, §5.3 |
| Revocation / in-flight | No new mechanism needed. `resolveTool` re-resolves the name against the offered list at the start of every call and settles `tool_unavailable` **before** argument preparation and before `execute`, so a revoked tool cannot reach a host. A call already inside `execute` ends only with the caller's abort or the host's own deadline. | §6 |

## 1. The gap, exactly (and it is one operation, not a subsystem)

Ticket 02 recorded the dependency: `apps/server/src/mcp-conversation-tools.ts:23-27`,
`docs/mcp-on-the-web-host.md:304` and its `## Not built` entry at `:315-320`, `issues/02-durable-adapter.md` (block 3).
The host today:

- `packages/gateway/src/mcp/host.ts:42` `connectAndList` calls `connection.client.listTools({ signal })` (:57) and
  keeps only `toolCount: tools.length` (:61) — the names and schemas are in scope and dropped.
- `packages/protocol/src/gateway.ts:193-203` `McpTestResult` carries `toolCount?` (:199) and nothing else about tools.
- `packages/gateway/src/mcp/config.ts:224-260` `describeServer` reports `exposure` (:244) and
  `toolExposureCount = Object.keys(config.toolExposure).length` (:245, spread :255) — a count of names **the entry
  itself already spells**, never what the server has. `readServerConfig` (:367) returns the raw entry and is host-local.
- `packages/protocol/src/gateway.ts:310-324` `McpHostRequest` has no listing member; `McpHostResult` (413-416) keeps
  `value: unknown`, so a new operation needs no result-shape change.
- The backend's surfaces report names only: `apps/server/src/server.ts:2096-2106` (`GET/POST /api/extensions`),
  :2496 (`PATCH /api/conversations/:id/extensions` answers the selection after the write, with the tools it offers).

pi-mcp's listing contract (installed `@earendil-works/pi-mcp@1.1.0`; `docs/upstream-sources.md` records the bump):

- `dist/protocol/types.d.ts:73-81` `Tool` = `name`, `title?`, `description?`, `inputSchema: Record<string, unknown>`,
  `outputSchema?`, `annotations?` (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, :63-69),
  `execution?`, `_meta?`. `ListToolsResult` (83-86) has `nextCursor?`.
- `dist/client.js:189-191` `listTools()` = `listAll("tools/list", "tools", isTool, options)`; `listAll` (218-232) follows
  every cursor up to `MAX_LIST_PAGES = 1000` (:4) and throws on a duplicate cursor (227-229) or overflow (:232).
  **There is no tools page method** (only resources/templates have one, `client.js:197, :207`), so a single bounded
  page requires the raw `client.request("tools/list", { cursor })` (`dist/client.d.ts:46`).
- pi-mcp validates **only** `name` and `inputSchema` (`mcp-test.ts:290` states this about the SDK; the SDK's own
  `isTool` is what `client.js:190` passes to `listAll`), so every other
  field is arbitrary server bytes. This repo ships the hostile cases as a fixture:
  `packages/gateway/test/fixtures/mcp/stdio-server.mjs:50-54` (`description: 42`, `title: { text: "no" }`,
  `annotations: "read-only"`, `annotations: { title: 7, readOnlyHint: "yes" }`, and names `numbered`, `constructor`,
  `toString`; opt-in via `PI_WEB_FIXTURE_ODD_TOOLS`, :77). A descriptor walk reads strings only, type-checks
  `annotations` before touching it, and must not build prototype-keyed objects.

## 2. D1 — the operation, and why reuse keeps it small

The Gateway is the only place that may connect a configured server, and the only one that holds its entry, its
resolved values and its OAuth state (`packages/gateway/src/mcp/connection.ts:206`, `config.ts:367`, `secrets.ts:55`).
A descriptor read is therefore **the same route, the same authority and less risk than `invoke`**: it starts nothing
the operator did not configure. Shape:

```ts
// packages/protocol/src/gateway.ts — one new McpHostRequest member, beside test (317)
| { readonly operation: "tools"; readonly scope: McpScope; readonly cwd?: string; readonly workspaceId?: string; readonly name: string }

/** One entry's listed tools, as this host read them. No entry value, no credential, no path. */
export type McpToolDescriptors = {
  readonly scope: McpScope; readonly server: string;
  readonly state: "listed" | "needs-auth" | "failed";
  readonly error?: string; readonly stderr?: string;         // masked, as McpTestResult does (195-198)
  readonly serverInfo?: { readonly name: string; readonly version: string };
  readonly total: number; readonly truncated: boolean;       // what was listed vs what is answered
  readonly durationMs: number; readonly listedAt: number;
  readonly tools: readonly McpToolDescriptor[];
};
export type McpToolDescriptor = {
  readonly name: string;
  readonly description?: string;   // first line, masked, clipped
  readonly readOnly?: boolean;     // annotations.readOnlyHint === true only; absent is unknown, not false
  readonly exposure: string;       // this host's own rule: toolExposure then exposure (invocation.ts:71-76)
  readonly inputSchema?: Record<string, unknown>;   // withheld + `truncated` when over the bound
};
```

The implementation is a sibling of `#test` (`packages/gateway/src/mcp/host.ts:245-261`) reusing what `#test` already
reuses: `#target` (:395, which is where **project trust** is enforced — 397-403, so an untrusted folder cannot have its
project server listed either), `redactorFor` (`connection.ts:74` over `secrets.ts:55`, `literalSecrets` 27-52: entry literals plus every value a
`!command` or `${NAME}` resolved; `MASK_MIN_LENGTH = 4` :16; the mask is `SECRET_MASK` from
`@hepi/protocol/mcp-secrets`), `connectServer` (`connection.ts:206`), `MCP_REQUEST_TIMEOUT_MS = 15_000` (:19) and
`MCP_TEST_DEADLINE_MS = 30_000` (`host.ts:33`). `#folder` (host.ts:186-196) already turns `workspaceId` into this
host's own root and refuses `unknown-workspace`, so no caller names a path.

Read-only matters and needs no new plumbing: `packages/gateway/src/control.ts:98` `MCP_MUTATIONS` (write, patch,
sign-in*, sign-out, invoke) picks the policy at :187, so an operation absent from that set is `read-only` — the honest
classification, because listing pages a server and repeating it changes nothing. `ANY_CODE` (:70) already passes the
host's own refusal vocabulary through (:198), and `CONTROL_TIMEOUT_MS.mcp = 60_000` (:31) already exceeds the 30 s
deadline. `GatewayHostTransport` therefore cannot classify a lost descriptor answer as `outcome_unknown`
(`host-client.ts:20-36`), which is what makes a refresh retryable while a call never is.

Bounds, chosen to follow numbers the repository already ships rather than invent a scale:

| Bound | Proposed | The existing number it follows |
| --- | --- | --- |
| Deadline | `MCP_TEST_DEADLINE_MS` (30 s), composed with the caller's abort as `#test` does (host.ts:256) | a test already connects **and lists** under this bound |
| Descriptors answered | 256, with `total`/`truncated` stating the rest | `MCP_MAX_TOOLS = 256` (`mcp-conversation-tools.ts:52`); upstream caps a test's tool list at 500 (`vendor/pi-web/lib/mcp-test.ts:60`) |
| Per server counted | 128, unchanged | `MCP_MAX_TOOLS_PER_SERVER` (`:51`) |
| Name | 300 chars, masked before clipping | upstream `TEXT_MAX_CHARS = 300` (`mcp-test.ts:73`, `headOf` :144) |
| Description | first line, then 2 KiB | `MAX_DESCRIPTION_BYTES = 2 * 1024` (`:55`) + `bounded()` (192-195); the first-line rule is upstream's (`mcp-test.ts:300-301`) |
| `inputSchema` | 32 KiB of JSON; over it, withhold the schema and set `truncated` | half of `MCP_INVOKE_MAX_ARGUMENT_BYTES = 64 KiB` (protocol:233): a schema that cannot fit an argument set cannot describe a callable call |
| Whole answer | 256 KiB | `MCP_INVOKE_MAX_RESULT_BYTES` (protocol:231). `readJson` caps a gateway **request** at 1 MiB (`packages/gateway/src/index.ts:1115-1118`); the only response-side bound in the gateway is a stream's 1 MiB **pending-write** cap (`index.ts:747`), which bounds buffered frames, not a JSON answer's total size — this bound is what stops an unbounded schema answer |
| Paging | one page, via `client.request("tools/list", { cursor })` (`dist/client.d.ts:46`) | `listTools` calls `listAll` (`dist/client.js:189-191, 218-233`), which walks up to `MAX_LIST_PAGES = 1000` (`:4`) inside one deadline; a bounded read must not |
| Concurrency | not the `#calls` set | `#calls` (:109) bounds *tool calls* (`invocation.ts:149`, `MCP_INVOKE_MAX_CONCURRENT = 8`); a listing starts nothing the person did not ask to see, and `#test` is already outside that set |

`exposure` per descriptor comes from the host's own rule, already written: `invocation.ts:71-76` `exposureOf` reads
`config.toolExposure[tool]` then `config.exposure`. Re-expressing it in the **listing** is what lets a panel tell a
person "this one is hidden here" instead of their learning it from a `not-exposed` refusal (`invocation.ts:144-145`;
ticket 02's test `the host's own refusals are recorded as they arrived` covers that refusal today). `readOnly` is
`annotations.readOnlyHint === true` and nothing else: an absent annotation is unknown, not a trusted negative — the
fixture's `annotations: "read-only"` (a string) and `{ readOnlyHint: "yes" }` are exactly the cases that must not leak
truth (`stdio-server.mjs:51-53`; upstream's own handling `mcp-test.ts:296-307`).

## 3. D1 — the discovery policy the spec already fixes

Spec, "Open details for ticket work": "Whether tool discovery/schema refresh occurs when opening a conversation or on
explicit refresh; **never call MCP servers merely to render unrelated settings**." Principle 2: "Configured does not
mean trusted or exposed. Tool selection is explicit and reviewable."

That settles the trigger, and the code shows why it must be so:

- **Not on page load, and not as part of `read`.** `#target` + `connectServer` start a process for a stdio entry
  (`connection.ts:229`) and perform an OAuth-aware connect for an HTTP one (:219-227). `read` is the settings-listing
  operation (`host.ts:133`, `227`) and is described **from the file** (`config.ts:224-260`), which is what keeps the
  panel instant. Hanging a connect on it is the thing the spec forbids, and it would hold an unrelated call behind it.
- **Explicit, one server per request.** The operation names `{ scope, name }` as `test` does (protocol:317), so a
  person opens one server's tools and sees what that server said. A fan-out over all servers is one request that starts
  N processes — refused (§7 Q6).
- **A `tools/list_changed` subscription is out.** Spec "First-slice scope" excludes subscriptions explicitly. The SDK
  can listen (`client.d.ts:45-46`) and `ServerCapabilities.tools?.listChanged` exists
  (`dist/protocol/types.d.ts:40`), but `McpHostService` keeps exactly four live collections (`#flows`, `#calls`,
  `#inFlight`, `#stopping`, `host.ts:105-113`) and a `close()` (220-225) that aborts every flow, aborts `#stopping` and
  awaits `#inFlight`. A fifth,
  belonging to no conversation, is a second lifecycle. The honest limit instead: an answer is a snapshot,
  `total`/`truncated` say what was read, and a refresh is a request. Reporting `listChanged` as a **fact** read from
  the initialize result costs no subscription and tells a person whether a snapshot can go stale by itself.
- **Nothing browser-side may be authoritative.** `docs/mcp-on-the-web-host.md:301-303` already records that the last
  test answer lives in the Web process and is lost on restart; `mcp-panel.ts:162-190` keys it by `configKey` so an
  answer is only trusted while the entry is byte-identical. **That freshness rule is the pattern to copy** for a
  descriptor marker — and the reason a durable grant cannot be a browser projection (§4).

## 4. D2 — storage, and the credential boundary

Two different facts; the mistake is one store that tries to hold both.

1. **What a server actually has** — owned by the Gateway, answered on demand, persisted by nobody. It changes when the
   operator's file changes, and the backend cannot know without asking.
2. **What this conversation was granted** — owned by the backend, durable, expressed as tool identities. This is the
   state a revocation edits, the state a fork decides about (ticket 04), and the only state that decides whether a
   request leaves the backend.

So the backend's durable state is a conversation-scoped grant document:

- **identity only** in the selection: `{ gatewayId, scope, server, tool }` — the vocabulary `mcp-declarations.ts`
  already validates (`:70-72` refuses `command`, `args`, `env`, `url`, `headers`, `auth`, `config`, `cwd`,
  `workspaceId` **by name**, at startup). A grant write must refuse the same keys, so no path can put a host-owned
  value into durable state.
- the descriptor fields needed to install a tool (`description`, `inputSchema`, `exposure`) recorded **at grant time,
  from the host's answer**, next to the entry's freshness marker (`configKey`-style, `mcp-panel.ts:162-190`), so
  "this schema came from an entry that has since changed" is a statement rather than a guess.
- scope `conversation`, `fork: "initial"` — the pair `conversation-operations.ts:44-56` already uses to keep one
  conversation's own bindings from travelling into a fork (`WorkspaceDoc` is `current`,
  `RelationsDoc`/`ReferencesDoc` are `initial`). Whether a fork inherits a human's grant is ticket 04's decision;
  `initial` is the safe default and needs no new semantics.
- **not** in `pi.agent`: `AgentState` (pi-durable `dist/harness/types.d.ts:347-376`) is names plus `extensions`,
  `tools`, `modelTools`, `instructions`, `cwd`. Registrations come from the registry snapshot; `resolveAgent`
  composes tools by name from the selected extensions (`harness/agent.js:160-200`), and `server.ts:1237-1238` calls
  `registry.snapshot().installed()` "the one authority".

A session-scoped catalog keyed by `(gatewayId, scope, cwd, server)` is the alternative that avoids storing schemas per
conversation. It needs `defineDocFamily` (`conversation-operations.ts:94` is the only existing family), a per-gateway
identity that survives an SSH profile change (ADR 0005), and an invalidation story for a file that changed on the host.
**Rejected for the first slice**: strictly more mechanism than the problem needs, because the only schemas that must be
durable are those of granted tools, bounded by the same 256/32 KiB numbers. Revisit if storage size measurably hurts.

**Credential boundary, checked rather than asserted.** `name`/`description` are server-authored text, masked by the
redactor built for that entry — the same one `#test` uses (`host.ts:248` `redactorFor(target.config)`), which holds
the entry's literal env/header values, every value a `${NAME}`/`!command` resolved (`connection.ts:43-62` adds each
resolved value to the redactor), URL query secrets and `oauth.clientSecret` (`secrets.ts:27-52`, `urlSecretParts` from `@hepi/protocol/mcp-secrets`). Schemas pass
**verbatim**, the rule the repository already ships for configuration reads: `describeServer` reports
`envNames`/`headerNames` and no value at all (`config.ts:260-261`, `maskedEntry` :230, used at :240). A schema is a document, not a
value source — nothing in this design resolves `${NAME}` or `!command` inside one, and `resolveValue` stays inside
`connection.ts` for `env`/`headers` only (`connection.ts:91-101`). The backend holds no credential either way, and a
browser's route is the ingress's own, which never forwards to the backend (`ingress/mcp.ts:10-16`).

**No new machinery**: the grant is one `defineDoc`, the same shape `extension-selection.ts:18-23` already uses.

## 5. D3/D4 — fine-grained selection inside existing Pi seams

### 5.1 The seams that already exist, and are enough

| Existing thing | Where | Why it is the seam |
| --- | --- | --- |
| `pi.agent.extensions` per conversation | `ExtensionSelectionDoc` `extension-selection.ts:18`; `reportedSelection` :54; PATCH `server.ts:2496`; creation-time `materializeSelection` :88 | the coarse switch: survives restart, already refused for a workspace-unbound conversation (`server.ts:1294-1296`) |
| `pi.agent.modelTools` | pi-durable `types.d.ts:360-372` (state), `:388-392` (`AgentChange` takes registrations or names); applied `offeredTools` `agent.js:204-217`; written by `configure`/`applyChange` `agent.js:55, 100-122`; written by a tool round `addTools` `agent.js:66-90` | **the** native per-tool offer filter, and it is documented to "never widen" |
| `pi.agent.tools` | `types.d.ts:356`; `filterTools` `agent.js:218-231` | enable/disable among selected extensions |
| `deferred: true` | `types.d.ts:264`; `offeredTools` `agent.js:204-217` | the runtime's own "not offered until loaded" |
| `callers: ["model"]` | `types.d.ts:259`; `resolveTool` `tool.js:134`, set by ticket 02 (`mcp-conversation-tools.ts:258`) | nested/script callers resolve among `callable`, not the offer — keeping `["model"]` is what stops a script reaching an external side effect |
| `tool_search` | pi-durable `dist/tool-search/tool-search.js:48, 60, 75`, installed by `createToolSearchExtension()` :81 | a live example of the loader mechanism, and a live hazard (§5.3) |
| Optional-extension registry | `server.ts:1247`; `runtime.install` (`harness.ts:66`); `registry.js:58-64` replaces **in place by name** | one `hepi.mcp` extension can be re-installed with a different tool set without touching any conversation |
| Host-side exposure | `invocation.ts:71-76, 140-145`; `config.ts:93, 119-127` | `hidden` already refuses at call time; per-tool `toolExposure` is the operator's existing vocabulary |

### 5.2 The shape D3 and D4 both point to

`hepi.mcp` stays the only MCP extension; its registrations become `deferred: true`. Selection then has two levels,
both native, one writer:

- selecting `hepi.mcp` (`pi.agent.extensions`) = this conversation may be granted MCP tools at all — the seam ticket
  02 shipped, unchanged;
- granting particular tools = one backend writer commits `modelTools` with the granted names in its `add`
  (`agent.js:113-122` turns registrations into names). `offeredTools` (`agent.js:204-217`) then offers every
  non-deferred tool minus `remove`, **plus exactly the `add`-listed deferred ones**.

The four states the ticket demands are distinct by construction, with no new authority:

| State | Who answers | Where read |
| --- | --- | --- |
| configured | the host's own files | `read` (`host.ts:133`, `config.ts:281`) |
| exposed by the host | the entry's `enabled` + `exposure`/`toolExposure` | `read` (`describeServer` `config.ts:246-263`, `enabled` :250, `exposure` :254), enforced at call (`invocation.ts:140-145`) |
| selected for this conversation | the backend's durable grant, materialized into `modelTools` | `configure` + `reportedSelection` |
| currently available | the intersection the backend can state without a connect | §6 |

"Default unselected tools to unavailable" is then not extra code: `offeredTools` never offers a deferred tool that
`modelTools` does not name (`agent.js:210-216`, `types.d.ts:261-262`). And `addTools` documents the durability a
grant needs: "By name, without the registry: a tool that is not registered now, such as one of an MCP server that is
reconnecting, is offered once it is again" (`agent.js:63-65`).

### 5.3 The one hazard, stated plainly

`tool_search` loads **any deferred, registered, model-callable tool** the model asks for, by name, through
`control.addTools` (`tool-search.js:60` reads `api.agent().deferred`, `:75` returns `control.addTools`; `agent.js:66-90`). Deferred MCP tools are exactly that. A model could
therefore self-grant a tool no person selected, and the host would run it while `toolExposure` is not `hidden`
(`invocation.ts:140-145`).

Two honest readings, and the choice is a person's (§7 Q2):

- **(a) `deferred` + no `tool_search` for MCP.** Today nothing in this repository installs `tool_search`: zero
  references in `apps/server/src` (verified by grep), and `packages/ui/src/lib/api-types.ts:458-464` only describes a
  `toolSearchDisabled` flag that `-builtin:tool-search` in **Pi CLI's** `extensions` turns off — a surface this backend
  does not serve (`apps/web/README.md:21`: the Web host folds the backend's **native** frames and nothing else). So (a) is already true, and
  stays true until someone installs it. That is a fact worth writing into `docs/mcp-on-the-web-host.md` rather than
  rediscovering.
- **(b) not deferred, and the per-conversation set *is* the extension's tool set.** That needs either
  per-conversation extensions (`hepi.mcp.<id>`: registry churn, install/uninstall on the live registry that every
  conversation resolves against, and one conversation's grants appearing in `GET /api/extensions` because
  `installed()` is the whole registry, `server.ts:1237-1238`) or `pi.agent.tools` as an exact array
  (`agent.js:218-231`) — the shape the delegate path already uses (`subagents/delegate.ts:199` sets `tools` from a
  definition, `:200` sets `modelTools: null`, which means "every non-deferred tool").

Recommendation: **(a)**. Keep `deferred`, keep `callers: ["model"]`, keep one `hepi.mcp` extension, and let one
backend writer own `modelTools`. Smallest change to ticket 02, the framework's own vocabulary, no parallel authority,
and no registry mutation on a shared snapshot.

## 6. Revocation, in-flight calls, and what "available" may claim

- **A revoked tool cannot reach a host, with no new mechanism.** `ToolTask` resolves the name at the start of the
  `call` phase against the **offer** for a model-issued call (`tool.js:134-137`), and an unresolved name settles
  `tool_unavailable` (`tool.js:50-54`) **before** `prepareArguments`, before validation, before `execute`. So
  removing names from `modelTools` (or deselecting `hepi.mcp`) stops every call not already running. Ticket 02's
  test `a conversation that never selected the extension is refused before any request leaves the backend`
  (`apps/server/test/mcp-conversation-tools.test.ts`) already exercises this exact settlement; ticket 03 needs the
  same assertion with a revoke *after* a grant.
- **A call already inside `execute` is not stopped by a revoke.** Nothing outside a running task aborts it; the aborts
  that end it are the conversation's own (`context.abortSignal` handed to the invoke request,
  `mcp-conversation-tools.ts:279-284`; `POST /api/conversations/:id/abort`) and the host's (`index.ts:596-609` ends
  the operation when the caller disconnects; `invocation.ts:158` composes caller + deadline + stopping). The
  ticket's "handles in-flight calls explicitly" is therefore answerable as a **statement, not a kill**: a revocation
  stops new calls, an in-flight call settles as whatever it actually did, and per ticket 02's rule an uncertain end is
  never reported as a refusal and never replayed (`mcp-conversation-tools.ts:289-290`, `UNCERTAIN_TRANSPORT` :304, host-side uncertain codes at :317).
  Killing a running MCP call *without* ending the run is not something either layer can promise, because the runtime's
  abort path settles the whole turn.
- **`replay: "unsafe"` is untouched.** Selection lives in a document and `modelTools`; nothing about a grant changes
  the restart rule (`mcp-conversation-tools.ts:236-241` states it where the runtime reads it; ticket 02's SIGKILL
  test proves it). After a restart, grants re-resolve from the durable document — including for a server that is not
  connected at that moment (`agent.js:63-65`).
- **"Currently available" needs no connect**: selected `hepi.mcp` + a workspace-bound conversation
  (`server.ts:1294-1296`, `mcp-conversation-tools.ts:264` `host_unavailable`) + a configured gateway connection
  (`server.ts:1231-1233` `gateway_offline`) + the host's own `enabled`/`exposure` from `read`
  (`config.ts:246-263`: `enabled` :250, `exposure` :254, `usesOAuth`/`signedIn` :262-263). A **name or schema** claim needs the new
  `tools` operation; an availability claim does not. Keeping those two apart is what stops the settings surface from
  starting servers (spec "never call MCP servers merely to render unrelated settings").
- **No credential in browser state.** The browser's route is the ingress's own and never forwards to the backend
  (`ingress/mcp.ts:10-16`, `28`); `read` reports `envNames`/`headerNames` with no values (`config.ts:258-259`);
  the new operation inherits the same redaction (§4). The durable grant document refuses host-owned keys (§4), so a
  credential cannot be written into it either. Ticket 02's masking test proves the result path; a listing test must
  prove the descriptor path with the env/secret fixture.

## 7. Decisions a person must make (not resolvable from code)

The spec left these open deliberately ("Open details for ticket work"). Ticket 02's `HEPI_MCP_TOOLS` is a
**deployment** answer to the same question, so keeping or replacing it is a product decision, not implementation
detail. Each one below is a real fork, with the code fact that constrains it.

| # | Question | Constraining facts | Recommendation |
| --- | --- | --- | --- |
| Q1 | Grant per conversation, per project, or both? | `reportedSelection`/`materializeSelection` already do **session default + per-conversation override** and state "it never rewrites a conversation that already exists" (`extension-selection.ts:6, 54-94`); `WorkspaceDoc` is per conversation (`conversation-operations.ts:44`); ADR 0004 = one project, many folders, one default, so a "project" grant must still name a folder | Reuse that existing shape: a session-scoped default grant list + per-conversation override. **No** new project-scoped grant document until a folder-level need is demonstrated |
| Q2 | May the model load an MCP tool by itself (`tool_search`)? | §5.3 — `deferred` + `control.addTools` makes self-grant legitimate for ordinary tools and unsafe-looking for external side effects; `tool_search` is not installed here today | Decide **before** anyone installs it. Record in `docs/mcp-on-the-web-host.md` that an MCP grant is a human act. If the product wants model-loaded MCP tools, it needs a second rule for what "selected" then means |
| Q3 | May a stored descriptor be trusted across a restart, or must a grant re-read the host before it offers? | `addTools` offers by name even while unregistered (`agent.js:63-65`); `configKey` freshness is the existing cache pattern (`mcp-panel.ts:162-190`); the host already refuses a tool it does not list at call time (`invocation.ts:172-173` `unknown-tool`) | Store the grant durably, label it "schema read at / possibly stale", require an explicit refresh to **change** a schema, and never block a call on a connect — the host's own `unknown-tool` refusal is the safety net |
| Q4 | Keep `HEPI_MCP_TOOLS` as an operator allowlist, or replace it with discovered tools? | `mcp-declarations.ts:70-72` is the only startup-time refusal of host-owned keys and of an unknown gateway (`:51`, `main.ts:115`) | Keep it as a **gate on which servers a conversation may be granted from**, with tools coming from discovery. Deleting it removes the only place a deployment can say "no MCP at all" without an env change |
| Q5 | Does a per-tool exposure rule accept a **pattern**, or only an exact name? | `config.ts:121-124` validates any string key; `exposureOf` (`invocation.ts:71-76`) is an **exact** lookup; `packages/ui/src/lib/api-types.ts:177` advertises "by exact name or pattern"; upstream's own rule is `getMcpToolExposure` (`vendor/pi-web/lib/pi-sdk-internals.ts:243`), which this repo does not have | **This is a live inconsistency, not a new feature question**: the panel comment promises something the host does not do. Either implement pi-mcp's rule in the host or fix the comment. Do not leave the two different, and do not let ticket 03's UI repeat the claim |
| Q6 | Should the Gateway offer one call that lists **all** servers' tools at once? | `McpServerInfo` carries no names; `#target` resolves one entry per request (`host.ts:395`); a fan-out starts N processes | No. One server per request, `read` unchanged. A "list everything" call is exactly the connect-to-render-settings the spec forbids |
| Q7 | When a grant is revoked, is an in-flight call killed or left to settle? | §6 — only the conversation's abort or the host's deadline can end it; the runtime's abort settles the whole turn; ticket 02's rule says an uncertain end is never a refusal | Leave it to settle and say so in the UI. A "kill this call" control would end the run, which is a different user act (`/abort` already exists) |

## 8. Approved beyond doubt, and therefore implementable now

Independent of every Q above, and without touching ticket 02's frozen behaviour:

1. **The `tools` operation itself** (§2): one `McpHostRequest` member + `McpToolDescriptors`/`McpToolDescriptor` in
   `@hepi/protocol/gateway`, implemented in `McpHostService` as a sibling of `#test` reusing `#target`, `redactorFor`,
   `connectServer` and one bounded page. It is **additive**: ticket 01's invocation contract, `invokeTool`,
   `exposureOf`, the concurrency bound and the deadline composition stay as they are; `control.mcp()` needs no new
   method because its policy table already classifies an unknown-to-mutations operation as read-only.
2. **Tests at that seam**, with existing fixtures and no network: `packages/gateway/test/mcp-invocation.test.ts`'s
   harness pattern (local `GatewayRpcServer` + `LocalGateway` + stdio fixture),
   `stdio-server.mjs` with `PI_WEB_FIXTURE_ODD_TOOLS=1` for hostile fields and `constructor`/`toString` names,
   the stdio fixture's own `FIXTURE_TOKEN` env entry plus `env_get` for the masking claim
   (`mcp-invocation.test.ts:95`, `:263`; the upstream `__fixtures__/mcp-env-server.mjs` is not this host's fixture),
   `unknown-workspace`, untrusted project (`host.ts:397-403`), disabled entry (`invocation.ts:142`), `needs-auth`,
   an over-bound schema (withheld + `truncated`), and a caller abort that closes the connection it opened
   (`connection.ts:232`, `onAbort` → `transport.close()`).
3. **A derived availability statement** (§6) from state both sides already hold — no connect, no cache, no new
   authority.
4. **Docs that replace the two known limits**: `docs/mcp-on-the-web-host.md:304` ("the host reports how many tools it
   found, not what they were") and `:315-320` ("Not built": the per-tool list and any listing with schemas), plus
   the Q5 inconsistency in `api-types.ts:177`. Keep `docs/migration-status.md` and the `docs/README.md` index current
   per `AGENTS.md` ("when behavior, configuration, or deployment instructions change, update the owning guide in the
   same change").

What must **not** be implemented before Q1/Q2/Q4 are answered: the durable grant document, whether `deferred` stays
for MCP, and any browser-side selection control. Guessing those is how a second authority appears — the failure mode
`docs/agents/review-policy.md` names ("correct the owning abstraction"), and the reason §7 is separate from §8.

## 9. Suggested ticket split

| Slice | Content | Blocked by |
| --- | --- | --- |
| 03a | Gateway `tools` operation + protocol + Gateway tests + docs of its bounds | nothing (§8) |
| 03b | Backend grant document + `deferred` registrations + grant/revoke at the existing selection seam + backend tests | Q1, Q2, Q4 |
| 03c | Browser: configured / exposed / selected / available as four states, explicit per-server discovery, revocation surface | Q1, Q4, and 03a's answer shape |

03a is where the parent should send work next; 03b/03c need the decisions in §7 first.

## 10. Evidence index (all read in this worktree at `ebf26df`)

- **Gateway** — `packages/gateway/src/mcp/host.ts` 33, 42-61, 105-113, 126-177, 186-196, 203-215, 220-225,
  245-261, 386-403; `mcp/invocation.ts` 28, 38-45, 66-76, 96-117, 127-195, 200-215, 220-244; `mcp/config.ts` 93, 119-127,
  224-263, 290, 367; `mcp/connection.ts` 19, 26-30, 43-62, 74-101, 206-247, 261-275; `mcp/secrets.ts`
  13-16, 27-52, 55-84, 87; `control.ts` 27-35, 45-56, 70, 93-98, 183-222; `host-client.ts` 11, 23, 29-37, 47-58, 98, 234-273;
  `index.ts` 501, 543, 568, 579-591, 596-609, 747, 1115-1118; `ingress/mcp.ts` 10-16, 28, 31, 60-69, 118-133.
- **Protocol** — `packages/protocol/src/gateway.ts` 127, 191-203, 229-233, 244-280, 310-324, 405-416; `src/mcp-secrets.ts`
  (`SECRET_MASK`).
- **Backend** — `apps/server/src/mcp-conversation-tools.ts` 23-32, 43-60, 76-105, 126-171, 174-199, 210-231,
  236-296, 304, 313-320; `mcp-declarations.ts` 18-22, 51, 70-72; `extension-selection.ts` 6, 18-23, 54-94;
  `server.ts` 1221-1247, 1275-1296, 1232, 2096-2106, 2496, 2642; `harness.ts` 52-66, 102-121;
  `main.ts` 21, 45, 115-116; `conversation-operations.ts` 44-56, 94; `subagents/delegate.ts` 195-203;
  `agent-definitions.ts` 45-50, 188-190; `pi-config.ts` 122 (`mcp`, `extensions`, `defaultTools` unsupported).
- **Tests available at that seam** — `packages/gateway/test/mcp-invocation.test.ts` (fixture 49-98),
  `packages/gateway/test/fixtures/mcp/stdio-server.mjs` 21-77 (`STANDARD_TOOLS`, `ODD_TOOLS`, `INVOKE_TOOLS`),
  `fixtures/mcp/env-server.mjs`, `apps/server/test/mcp-conversation-tools.test.ts` (live gateway rig),
  `apps/server/test/mcp-replay-crash-child.ts` (SIGKILL replay), `apps/server/test/extensions.test.ts` 96-292
  (selection seam acceptance), `apps/server/test/faux-fixture.ts`.
- **Runtime packages** — pi-durable 1.3.0 (`pnpm-lock.yaml`, patched by `patches/pi-durable-1.3.0-input-control.patch`):
  `dist/harness/types.d.ts` 240-270 (`callers` 259, `deferred` 264), 347-376 (`AgentState`), 378-395 (`AgentChange`), 414; `harness/agent.js` 55 (`configure`), 66-90 (`addTools`), 92-122 (`applyChange`), 160-200 (`resolveAgent`), 204-231;
  `harness/tool.js` 44-58, 104-137, 170-200, 296-300, 484; `harness/registry.js` 9-14 (state), 58-69 (install/uninstall), 79-84 (name uniqueness **per extension**);
  `dist/tool-search/tool-search.js` 3, 9, 12, 48, 60, 75, 81; `dist/index.d.ts` 4 (exports `AgentDoc`, `configure` — **not**
  `addTools`, which is why the backend must go through `configure`). pi-mcp 1.1.0: `dist/protocol/types.d.ts` 40,
  55-86; `dist/client.js` 4, 154, 189-233; `dist/client.d.ts` 39-56; `README.md` 23-25, 41-44. Installed `CodingTools` (probed
  with node): `read`, `write`, `edit`, `bash`, no `callers`, no `deferred`.
- **UI / upstream copies** — `packages/ui/src/lib/mcp-panel.ts` 162-190, 193-201, 219-220, 440-460, 558-565;
  `packages/ui/src/lib/api-types.ts` 169-181, 226-276, 329, 458-464, 712-742;
  `packages/ui/src/components/McpConfig.tsx` 1698, 1747-1769, 1849-1851; `apps/web/adapters/mcp-surface.ts` 1-60;
  `apps/web/adapters/mcp-host.ts` 1-62; `apps/web/vendor/pi-web/lib/api-types.ts` 314-357;
  `apps/web/vendor/pi-web/lib/mcp-test.ts` 55-73, 144-150, 288-317, 440-485;
  `apps/web/vendor/pi-web/lib/pi-sdk-internals.ts` 47, 96, 243; `apps/web/README.md` 23-27.
- **Docs** — `docs/mcp-on-the-web-host.md` 44-51, 96-97, 115-127, 142-156, 178-215, 301-306;
  `docs/architecture.md` (MCP ownership), `docs/local-integration.md`, `docs/container-deployment.md`,
  `docs/agents/review-policy.md`, `docs/agents/verification.md`, `docs/upstream-sources.md` 148, 174, `GLOSSARY.md`,
  `docs/adr/0002`-`0005`, `AGENTS.md`.
- **Navigation note** — `AGENTS.md` asks for a narrow `graphify query` first, but this worktree has no
  `graphify-out/graph.json` and the primary worktree's graph predates ticket 02's files, so all navigation above is
  direct source search (`find`/`grep`/`read`) with cited lines.

