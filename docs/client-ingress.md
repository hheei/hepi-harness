# Client ingress and device credentials

Tickets 02, 03, 05 and 10 of the [shared client plan](../.scratch/client-app/spec.md) deliver the credential path, the
conversation slice, the shared workbench that both clients mount and the conversation control surface end to end: the
Gateway's client listener, the Web session it sets, the device credentials the Backend owns and revokes, the connection
descriptor a client reads first, one conversation a real caller reads, submits to and follows through the same listener,
and the stop/continue, queue, fork, delegation and relation operations that act on it — with the lost-answer rule they
share ([below](#conversation-control-queue-fork-and-relations)). All are implemented and tested, and since 2026-10-18
this listener **is** the deployed Web entry on the workstation: `hepi-ingress.service` serves the tailnet origin that
the Next container used to bind, from `release-1873d24` (see [the cutover record](records/1873d24-deployment.md) and
[client-runtime release](client-runtime-release.md)). The Backend's own port and the execution gateway's loopback
listener are unchanged binds, and the ingress serves no `/v1` route on the client origin.

## What starts

| Entry | What it binds | When |
| --- | --- | --- |
| `apps/server/src/main.ts` | the Backend, on `HEPI_BIND_HOST`/`PORT` | today's entry, unchanged |
| `packages/gateway/src/main.ts` | the execution gateway's internal listener, loopback only | today's entry, unchanged |
| `packages/gateway/src/ingress/main.ts` (`pnpm --filter @hepi/gateway start:ingress`) | the client ingress | **explicit**: only when an operator starts it |

Starting the ingress is a deliberate act with its own configuration; no default entry starts it — the deployment runs
it as its own unit, rendered by `node scripts/ingress-unit.mjs`.

```
HEPI_INGRESS_BACKEND=http://127.0.0.1:8787      # the Backend this ingress fronts
HEPI_INGRESS_SERVICE_TOKEN=…                    # what the ingress presents to the Backend
HEPI_WEB_LOGIN_TOKEN=…                          # optional: the Web login material
HEPI_APP_ORIGINS=http://localhost:1420          # optional: comma-separated App origins
HEPI_INGRESS_DEFAULT_HOST=workstation           # optional: the execution host this origin serves
HEPI_INGRESS_MCP_GATEWAY_URL=http://127.0.0.1:28788  # optional: the gateway that owns this host's MCP configuration and provider credentials
HEPI_INGRESS_MCP_GATEWAY_TOKEN=…                # optional: that gateway's own token, outbound only
HEPI_INGRESS_MCP_GATEWAY_ID=workstation         # optional: that gateway's name in the Backend's own vocabulary
HEPI_INGRESS_HOST=127.0.0.1                     # a non-loopback bind requires HEPI_WEB_LOGIN_TOKEN
HEPI_INGRESS_PORT=8790
HEPI_REVOCATION_CHECK_MS=1000                   # optional: the revocation re-check interval
HEPI_INGRESS_STATIC_DIR=/srv/hepi/web/dist      # optional: the Vite build this origin serves (see below)
```

`HEPI_INGRESS_STATIC_DIR` names a Vite `dist` and makes this listener the page's origin as well as its API's. It is
never inferred from the working directory: absent states that this ingress serves no page, which is what an App-only
ingress or one behind a proxy that already serves the build states, and every non-`/api` path then stays a `404`. An
empty value is refused at start rather than read as "no page", because a page that silently disappears is worse than a
listener that does not start. See [the Web build on this origin](#the-web-build-on-this-origin).

The Backend needs its own service credential (`HEPI_AUTH_TOKEN`, unchanged) and stores device credentials in
`HEPI_DEVICE_CREDENTIALS`, defaulting to `device-credentials.sqlite` beside the conversation database — the same
ownership split the project and skill-repository stores use. No credential row enters the conversation database.

## What a client shows when its first read is refused

The descriptor read is the first thing either host does, so the surface that answers its refusal is the first thing a
person sees. Which surface that is belongs to one rule (`packages/ui/src/lib/web-session-gate.ts`), because the two
hosts are refused for different reasons and only one of them has anything a person can do:

| The read was refused with | Web page (cookie) | App (device bearer) |
| --- | --- | --- |
| `401`/`403`, deployment gated, login configured | the page's own sign-in form (`POST /api/web-login`, same origin), which then re-reads the descriptor | a refusal naming the shell: no page can mint a device credential |
| `401`/`403`, `GET /api/web-auth` says no login | a refusal naming the configuration, not a form that can only fail | as above |
| any other status, or a transport that never got an answer | the failure as itself — never a credential prompt | as above |

A refused cookie read is the deployment asking for its login; a refused bearer is a credential that was revoked or never
issued. The form keeps its field usable after a wrong attempt, clears the material it was given, and never stores it.
The Web entrance uses a centered Hepi card with a labeled access-token field, pending state and inline errors;
on short screens the entrance itself scrolls so its controls remain reachable.
The shared stylesheet explicitly includes `packages/ui/src` in Tailwind source scanning for both Vite hosts;
chat layout and scroll utilities must be emitted from that shared tree rather than only the host entry files.

Two things this replaced, both of which made a first open unusable: the workbench used to wrap the tree in the retired
`DurableLogin`, whose form posts to the Next-only `/api/durable-login` (a route this listener does not serve), and it
treated a refused descriptor as a dead end that rendered the bare word `unauthorized`. `DurableLogin` itself is gone with ticket 17, which retired the whole
Next application; the rule now lives in `packages/ui/src/lib/web-session-gate.ts`.

## Ending a Web session

Settings › General's **Log out** is one route and one credential, and both are stated in
`packages/ui/src/lib/web-logout.ts` rather than in the panel:

| | Web page (cookie) | App (device bearer) |
| --- | --- | --- |
| Is the control offered? | yes, when `GET /api/web-auth` said this deployment gates its page | **no** — no cookie route ends a device bearer, and this origin refuses credential operations to a device |
| What it asks | `DELETE /api/web-logout` on the connection's own transport, same origin | — |
| What `200` means | the deployment cleared `hepi-web-session`; the page reloads `/`, whose first read now needs admission | — |
| What a refusal or a lost request means | the session is **still admitted**: the panel says the logout failed and reloads nothing | — |

Three facts this keeps apart. A **refused or unanswered** logout is not an ended session, so the page does not reload
into a login form for a cookie it still holds. A **bearer** host is offered no cookie logout at all, and asking the
route as a device ends no credential and stops no durable run — an App disconnects by forgetting its own stored
material in the shell, which is [ticket 19's](../.scratch/client-app/issues/19-app-connection-recovery.md) connection
surface, not a Web logout. And **the route is one constant** (`WEB_LOGOUT_PATH` in `@hepi/protocol`): the page and the
ingress read the same string, because the obsolete pairing — a page sending `DELETE /api/web-auth`, the login-state
read, while the listener cleared the cookie on `DELETE /api/web-logout` — was a logout that either 404'd or was
forwarded to the Backend with the cookie still in the browser.

Verification: `node apps/web/e2e/auth-shell/ux-web-logout.mjs` drives the ordinary journey in Chromium against this run's own
ingress, Backend and production Web build — sign in, fail a logout (refused `503`: no reload, session still admitted),
log out for real (`DELETE /api/web-logout`, cookie gone from the jar, a business read `401`), then sign in again. The
bearer half is held by `node apps/web/e2e/auth-shell/ux-panel-ingress.mjs` (the production panel under a device bearer offers no
logout and asks no login-state question) and `packages/gateway/test/ingress.test.ts` (the route clears the browser
cookie for a device caller and leaves that device's credential and record untouched). Command, revision, exit code and
log are recorded in [verification](verification.md#web-logout-contract-ticket-18).

## The four materials

They are separate on purpose, and each one is refused where it does not belong.

| Material | Held by | Reaches | Refused |
| --- | --- | --- | --- |
| Web login material | the operator, then the browser's HttpOnly cookie | the ingress, which sets `hepi-web-session` | as a bearer; from another origin |
| Device credential | one App install, as a bearer token | the ingress, which asks the Backend | when revoked, and for issuing or listing devices |
| Service credential | the ingress process | the Backend's own API | as a client bearer |
| Execution token | the Backend's host client | the execution gateway's internal listener | everywhere on the client listener, which serves no `/v1` |

## The client API

| Route | Identity | Answer |
| --- | --- | --- |
| `GET /api/web-auth` | none | `{ enabled }` — whether this deployment gates its page behind a login, and nothing else |
| `POST /api/web-login` | the login material, same origin | sets the HttpOnly, Strict session cookie |
| `DELETE /api/web-logout` | the session cookie, same origin | clears the same cookie — the Web page's logout ([below](#ending-a-web-session)) |
| `GET /api/descriptor` | cookie or device bearer | the connected Backend's identity, account scope, build id and real capabilities, plus the client the ingress admitted |
| `POST /api/device-credentials` | **Web session only** | one new credential; the token appears in this answer only |
| `GET /api/device-credentials` | **Web session only** | the records, with their revocation state |
| `DELETE /api/device-credentials/:id` | **Web session only** | revokes that one device |
| `GET/POST /api/conversations`, `GET /api/conversations/:id[/state|/entries|/read|/navigation|/navigation/around|/submissions|/control|/commands|/items]`, `POST …/messages`, `…/stop`, `…/continue`, `…/fork`, `…/recall-queue`, `PATCH …/settings`, `…/extensions`, `DELETE /api/conversations/:id` | cookie or device bearer | the Backend's own conversation contract, unchanged |
| `GET /api/conversations/:id/events` | cookie or device bearer | the Backend's own `text/event-stream`, passed through byte for byte |
| `GET /api/sessions/:id/entries/:entryId/{text,thinking,tool-result-image}` | cookie or device bearer | the read block a deferred history entry names, served by the Backend's own `/api/conversations/:id/entries/...` route |
| `GET /api/mcp`, `POST /api/mcp`, `POST /api/mcp/test`, `POST|GET|DELETE /api/mcp/sign-in[/:flowId]` | cookie or device bearer | Settings › MCP, read from and written to **this origin's own configuration host** (see below) |
| `GET /api/project-trust` | cookie or device bearer | the folder's trust decision, read from the host that owns the folder |
| `GET/POST /api/skill-market/{skills,search,preview,bundles}` | cookie or device bearer | the deployment's own repository: the bundles it holds, the catalog it can read, one bundle's content |
| `GET /api/skill-market/{inventory,installed,check}`, `POST /api/skill-market/{install,update}`, `PATCH /api/skill-market/skills` | cookie or device bearer | the execution host's own skills: what it holds, what an installation or replacement did, one installation's revision, and one switch per directory |
| `GET/PUT/DELETE /api/agent-definitions[/document]` | cookie or device bearer | the agent definitions of that same host, read and written there |
| `POST /api/terminal?cwd=…`, `GET/DELETE /api/terminal/:id?cwd=…`, `POST /api/terminal/:id?cwd=…` | cookie or device bearer | the host's own terminal lifecycle through the Backend relay: open or reopen a session, describe it, write to it, resize it, close it |
| `GET /api/terminal/events?tabs=…` | cookie or device bearer | the page's **one** stream for every mounted terminal tab, with each tab's own cursor |
| everything else under `/api` | cookie or device bearer | forwarded to the Backend under the service credential |

A device may not issue, list or revoke credentials: an App cannot mint itself a second identity. The initial issue is
therefore an authenticated Web call, or the Backend's own route for a local operations function — never a master token
stored in the App.

Declared App origins receive preflight for `authorization`, `content-type`, `last-event-id` and `range`, and
`last-event-id`, `content-length`, `content-range` and `accept-ranges` are exposed on responses. An origin that is not declared is refused with 403, including for the one
unauthenticated read. Cookie writes additionally require a same-origin `Origin`; a bearer request does not, because a
bearer states its own authority rather than riding on a cookie the browser attaches by itself.

## History, context and media resources

A history frame carries heavy content **deferred**: a large text or a thinking block arrives as a bounded preview, and an
image arrives as an address rather than as bytes. The address is a wire fact the protocol builds —
`/api/sessions/:id/entries/:entryId/text|thinking|tool-result-image` — and this ingress serves it, so the client that
received the frame can fetch it under the same cookie or device bearer as everything else. The rewrite from
`/api/sessions/...` to the Backend's own `/api/conversations/...` is the **only** route translation the ingress makes;
nothing about the block is interpreted, and the Backend keeps the one projection of history.

| Property | Contract |
| --- | --- |
| Text and thinking | Bounded by default: at most 256 KiB of UTF-8 per answer, with `offset`, `totalBytes`, `truncated` and `nextOffset`. A caller may ask for less (`limit`), never for more. Following `nextOffset` rejoins the block byte for byte, so the bound is on the answer and never on what is reachable |
| Images | A byte range is honoured (`206` with `content-range`, `416` outside the block, `accept-ranges: bytes` on a whole answer). A range is decoded from **only** the base64 groups it touches, so a window of a 10 MiB screenshot costs a window |
| Credential | Never in a URL. The client's reader presents it as the cookie the browser attaches, or as one explicit bearer, and only to the origin the connection was admitted to |
| Refusals | Named: `unauthorized`, `forbidden`, `not_found`, `oversize` (413/415), `unavailable` (5xx or a transport failure), `disposed` (an answer that arrived after its scope ended) |

The client half is `packages/session/src/resources.ts`: one reader per connection scope, created with the Gateway origin
and the credential kind. It resolves a wire address against that origin — an address on any other origin is refused
before a request is made, which is what a native shell needs, where a relative path would otherwise ask the app bundle
for conversation history — assembles a text from its pages, and turns an image into a **blob lease**. A lease is shared
by every reader of one address and revoked when the last one releases it; the scope keeps at most 24 blobs / 32 MiB and
32 texts / 16 MiB, reclaiming the least recently used, and `dispose()` revokes everything and refuses every later read.
An answer that arrives after disposal is dropped rather than retained, so one connection's image never appears in the
next one's view.

**One address, one retained value.** The scope's maps are keyed by the resolved address, so two reads of one image that
overlap in time — two views of the same screenshot, or one view a development StrictMode replay puts through its effect
twice — end on **one** blob URL and one byte count, whichever body lands first; the second read is a second lease on the
blob already retained. The same holds for a text assembled twice. What that does **not** collapse is the request: each
caller still fetches under its own signal, because aborting one caller must not cancel another's read, so an overlapping
pair costs two requests and one retained blob. Because an address is never re-keyed to a second blob, a lease's release
can only ever drop the blob it was handed, and `dispose()` sees every URL the scope created.

`range` is a forwarded request header and a preflighted CORS request header, and `content-length`, `content-range` and
`accept-ranges` are exposed, so a declared App origin can read a ranged image.

## Execution-side resources: skills, installations and agent definitions

Skills, installations and agent definitions belong to the **execution host account** (ADR 0002), and a client reaches
them through this same entry. What it names is a **workspace**; which computer and which login that workspace is on is
the Backend's own binding resolution, exactly as it is for a conversation.

| Fact | Owner | What the caller sees |
| --- | --- | --- |
| which host and account serve a workspace | Backend binding (configured workspace, retained binding, Project folder) | the host's own account in an inventory answer, or the host's own refusal |
| the skills a host holds, their provenance, baseline state and revision | execution host, read through the gateway's resource discovery and installation capability | `GET /api/skill-market/inventory` |
| publish, replace, switch, check | execution host's installation capability | the Backend's own status, `code` and state |
| the repository's bundles, catalog search and one bundle's content | the Backend's repository | `/api/skill-market/{skills,search,preview,bundles}` |
| agent definitions | the host's `<agent dir>/agents` and `<workspace>/.pi/agents` | the whole document, raw and parsed, plus `capabilities` |

**No client request names a computer.** The entry's own default host (`HEPI_INGRESS_DEFAULT_HOST`) is forwarded as
trusted configuration and the Backend resolves it against its configured gateways, but a resource operation names only
its `workspaceId` — so the entry's default can never override a Project's recorded binding. A folder on the entry's own
machine and a Project folder on an SSH host are addressed by the same call, and the answer states the account of the
host that really served it.

**A host that cannot answer is not an empty host.** An unreachable host answers `unreachable_host` with a one-line
reason, a workspace this deployment does not bind answers the installer's own `not_found`/`unknown_workspace`, a
replacement the caller did not confirm answers `confirmation_required` with the state it saw, a confirmation pinned to a
snapshot the host no longer holds answers `conflict` with the edit intact, and a document naming a capability this build
cannot execute answers `unsupported_capability` with its field. Nothing is retried: a publication whose answer was lost
is `outcome_unknown` and is never sent again.

**Adoption stays a second outcome.** A publication or a switch names the initiating conversation only when that
conversation runs on the workspace being written; the answer carries `reload` separately from what happened to the files,
so "installed and not reloaded" is two facts rather than one invented one.

The client half is `packages/session/src/execution-resources.ts`: one connection scope, holding the repository reads and
the `select(workspaceId)`ed target. The connection decides the origin and the credential — the browser's own cookie, or
one explicit device bearer, and never a credential in a URL — and disposing a target is what retires its answers, so an
inventory that arrives after the selection moved is refused as `disposed` instead of replacing the new host's view. The
Web's own `/api/agent-definitions` proxy forwards the workspace and no host for the same reason, so the two entries
cannot disagree about which computer a definition lives on.

**The shared workbench reads through that scope, not around it.** The Skills panel, the Agents panel, the quick delegate
and the composer's skill-dormancy annotation are the same components in both hosts, and each reaches its host through
the connection it was mounted under (`useExecutionTarget`): a Web page's relative origin and cookie, an App's configured
Gateway and device bearer. A relative `fetch` inside the shared tree would ask the App's bundle for a host's skills, so
the seam is what makes one component correct on both hosts. Selecting a target is also the fence: switching execution
target disposes the previous one, and its late inventory is `disposed` rather than published into the new host's view.

Ticket 12's own record — the commands, the revision and the exit codes for the two-host ingress test, the client seam's
suite and the regressions that still hold the host-side contracts — is in
[the ticket](../.scratch/client-app/issues/12-execution-side-resources.md#answer).

## The conversation slice

A caller reads a conversation, submits input and keeps receiving the same facts the Backend publishes, without the
Gateway inventing a second conversation API. What crosses the ingress is the Backend's own contract, and the Gateway
adds only the two things that belong to a transport boundary: routing and identity.

| Fact | Owner | What the caller sees |
| --- | --- | --- |
| create, read, state, history pages, entries and read blocks | Backend `ConversationOperations` | the Backend's status, body and `code` |
| submit, stop, continue, steer/follow-up, recall, fork, rename, remove | Backend durable commands | the Backend's admission receipt, `requestId` and `control` |
| `snapshot` / `state` / `submission` / `resync_required` / `state_oversize` frames | Backend stream | the same event names, the same JSON, the same bytes |
| heartbeat comment frames and the disconnect | Backend stream and socket | unchanged; the ingress never writes a frame of its own |
| authentication, CORS, the default host | client ingress | decided here, once per request |

**Nothing is decoded on the way through.** A conversation's event stream is piped from the Backend's response into the
caller's socket, so a frame, a keepalive comment (`:` line) and a chunk boundary all arrive exactly as written. An
ingress that parsed each frame and re-encoded it would drop the keepalive (it carries no event) and would buffer a turn
that is still running; the bytes are not the Gateway's business, so it does not touch them.

**Cancellation is forwarded, not absorbed.** A caller that goes away ends the read, which ends the ingress's own upstream
request, which the Backend already treats as a detached stream client. Nothing attached is left running behind a client
that left, and the conversation itself is untouched — its run stops only through its own durable stop command.

**A lost answer is recovered by request id, never by repeating the write.** The `requestId` a caller generated before
sending is the durable identity of that submission, so after a lost response the caller reads
`GET /api/conversations/:id/submissions?requestId=…` and learns what actually happened. Sending the same `requestId`
again converges on the same submission, and creating a conversation with the same `requestId` answers the conversation
it already created: a retry after a lost answer neither re-sends an unknown write nor creates a second conversation.

## The terminal fan-in

A terminal is a session on the conversation's execution host, so it stays behind the Backend relay: the client names a
routing cwd (`/workspace/<id>` plus the folder inside it) on every request, and the Backend resolves that to the
workspace binding and the gateway that owns it. The relay is what keeps workspace authorization and multi-host routing
in one place, and no client ever addresses an execution host or holds an execution token.

| Fact | Owner | What the caller sees |
| --- | --- | --- |
| open, describe, input, resize, close | the host's `TerminalSessions`, through the Backend relay | the host's own status, `code` and exit |
| every mounted tab on one connection | the Backend relay's merge over the gateways it routes to | one `text/event-stream` whose frames each name their tab |
| per-tab cursor and replay | the host's retained tail, named by the caller | a continuation from the offset that tab has read, or the retained tail with `reset: true` |
| which host a tab runs on | Backend workspace binding, resolved per request | the tab's own folder, never the ingress's default host |

**One stream for every mounted tab, read with `fetch`.** A browser allows six connections per origin, and a page with a
few terminal tabs would spend them all if each tab held its own; the page therefore holds one stream for every mounted
tab and each frame names its tab. It is read with `fetch` rather than `EventSource` because `EventSource` states no
credential: the Web page states nothing and the browser attaches its own HttpOnly cookie, while an App presents one
device bearer. Neither branch can put a credential in a URL. The reader also owns the request, so a released tab aborts
it instead of leaving the browser to retry, and the stream is reopened by the client with each tab's own cursor.

**A tab is attached for as long as it is mounted.** A tab the page has released is detached, and the host's reconnect
lease then runs for a session nobody is attached to — the same behaviour a panel with its own connection had. A caller
that goes away ends the Backend's upstream request, so no host stream is left holding a shell for a reader that left.
A frame for a tab the page has already detached belongs to an attachment that is over and is dropped, so one tab's
output is never written into another's.

**A stream answers before it has anything to say.** Both the relay's stream and the ingress's proxy flush the response
head, so a continuation from the cursor a tab already read — which has nothing to replay — is attached immediately
rather than waiting for the next keepalive to arrive.

**The stream belongs to the connection, not to a mount.** The client states its origin, its credential and the
platform's fetch once, as `WorkbenchClient.connection`, and the shell hands that one value to the stream and to every
panel. A surface therefore compares it by identity: the same connection keeps the stream it has, a switched one closes
it and opens the next, so a tab's cursor never travels into a scope where it means something else.

**The stream is created by the effect that shows the connection.** Closing it is what that effect's cleanup does, so the
stream may not be memoized across a cleanup: both hosts mount their roots in `StrictMode`, whose development build
replays an effect by running the cleanup and then the effect again on the same state, and a memoized instance would be
handed back closed — every attachment the page made afterwards would be refused. The stream is created by the effect and
held in state instead, so a replay gets a live one and a real unmount still releases the one that was shown. Until that
effect has run there is no stream, and a surface is handed **none** rather than the stream of the connection being
replaced: the panel then builds nothing, and the next render states the stream and its effect runs once, with the
widget, the host's answer for the tab and the attachment all made in that one pass. Releasing the last
mounted tab aborts the request rather than leaving the browser to retry, and the panel's own describe, write, resize
and close present exactly the identity its stream was opened with.

### The host this origin serves

Which computer a caller is served from is a deployment fact, so it is stated by the ingress (`HEPI_INGRESS_DEFAULT_HOST`,
the gateway id the Backend was configured with) and forwarded on every admitted request as `x-hepi-default-host`. The
Backend resolves it against the gateways it was configured with, so an id this deployment does not know is the existing
`configuration_required` refusal rather than a route to somewhere else. A caller's own header or query parameter of the
same name cannot substitute for it: the header is not in the forwarded-header list, and a request that names a host the
deployment does not serve is refused by the same resolution. With no default host configured, every host-scoped route
answers its own `configuration_required` — the ingress never guesses one.

### Host-local MCP and project trust

MCP configuration, its credentials and every server process belong to the computer a caller is served from, so these
routes are **not** forwarded to the Backend: the ingress answers them from that host's own authenticated `POST /v1/mcp`
(`HEPI_INGRESS_MCP_GATEWAY_URL`/`HEPI_INGRESS_MCP_GATEWAY_TOKEN`, with `HEPI_INGRESS_MCP_GATEWAY_ID` naming that host).
No MCP credential is handed to the Backend, no client is given the host service's token, and no client reaches `/v1` to
do it directly. The answer shapes are declared once in `@hepi/protocol/mcp-ui`
(`packages/protocol/src/mcp-ui.ts`) and the aggregate that composes them is
`packages/gateway/src/ingress/mcp-panel.ts`, the ingress's own: the protocol owns the declaration because a browser
renders it, and the gateway owns the behavior because it is the entry that answers it.

- **The host resolves the folder, and the binding says which host.** A request names a folder as the browser addresses
  it (`/workspace/<id>`); the ingress sends the workspace id and never a path, and the configuration host resolves it
  against the folders it serves. A name is not an identity, so the id is checked first against the binding the Backend
  owns: the ingress asks one question with its **own service credential**,
  `GET /api/workspaces/:workspaceId/locality?gatewayId=HEPI_INGRESS_MCP_GATEWAY_ID`, and forwards a folder-scoped
  request only when the answer is `{ local: true }`. The Backend decides that verdict from its own binding membership
  (retained bindings included) and its own host-profile answer — a gateway that executes over SSH profiles serves
  folders on other machines, so it is not this origin's host — and the ingress reads no list, profile, root or account
  shape to reach it. A refusal, a body that is not that verdict and a transport failure are all `false`: "could not
  ask" is never "asked, and it is this machine", and nothing is remembered, so a host that goes away stops being this
  machine on the next request. A workspace bound to another gateway is refused here, before any host is asked, so a
  folder this machine happens to call `local` is never answered for a `local` that belongs to someone else; a folder
  the bound host itself does not serve is refused by that host (`unknown-workspace`, answered 403 `cwd-denied`).
  `/durable`, the sentinel that means "no folder", leaves the global configuration alone. No path is synthesized and
  nothing is cached.
- **A cookie write is same-origin; a bearer is its own authority.** A write under these routes is refused unless it is
  same-origin **or** it presents a device bearer: a cookie is presented by the browser on its own, so a declared App
  origin must not be able to make the browser write with this session's cookie, while an App reaching this origin from
  its declared origin with its own bearer is stating its own authority and is served.
- **A caller needs an identity, and keeps it — including while the host is working.** These routes are answered after
  the ingress admitted one. A device bearer is re-verified on the revocation interval while the request is in flight — a
  test that starts a server, or a sign-in mid-exchange, is exactly the kind of operation that outlives its admission —
  and either that revocation or a caller that simply stops listening ends the operation **on the host**, not just the
  socket here: the host aborts the work it started, and a sign-in whose exchange was already under way stores no
  credential for the caller that left. That answer claims no rollback — the exchange with the authorization server may
  have completed — so it is reported as an unknown outcome, and any record the host stored earlier is left alone. The
  next request is refused by the identity check.
- **A deployment with no such service answers a named limit.** The three MCP variables are stated together or not at
  all; absent, `/api/mcp` and `/api/project-trust` answer 503 with `code: "mcp_unavailable"` and a message naming them,
  and every other client route keeps working. The ingress never falls back to the Backend or to another machine's
  configuration.
- **Reading a trust decision is the only trust route.** Recording one asks a person, on the host that owns the folder.

### Host-local provider credentials

Provider credentials belong to the same account as that host's `mcp.json`: the `<home>/.pi/agent/auth.json` of the
machine a caller is served from. So `GET /api/auth/providers`, `POST /api/auth/api-key/:id` and
`DELETE /api/auth/api-key/:id` are answered here too, from that host's authenticated `POST /v1/providers/auth`, over the
**same** configured service (`HEPI_INGRESS_MCP_GATEWAY_URL`/`_TOKEN`) rather than a second pair of variables that could
disagree about which machine holds the credentials (`packages/gateway/src/ingress/providers.ts`). The durable Backend
receives no credential and serves no route for one: a raw key travels from the authenticated caller to this listener and
on to that one host, and stops there. A set or remove is answered with the host's listing **after** the write, never with
the value it was given, and a listing carries presence, credential type and the hint the host masked.

- **A removal states what it expects to remove.** `DELETE /api/auth/api-key/:id?expectedType=api_key|oauth` is checked
  against the record the host holds; a listing the panel read before someone else changed the file cannot delete the
  credential that replaced it (`credential_mismatch`, answered 409 and left alone).
- **Three kinds of "no" stay three.** The host serving no provider capability at all (an SSH gateway, or one composed
  without the service) answers the same 501 `code: "unsupported"` every other unserved capability uses, so the panel
  withholds the control. A deployment that configures no host service answers 503 `code:
  "provider_auth_unavailable"` naming the variables to set — unconfigured, not unserved. A host that cannot be reached or
  that refused this origin's token answers 503 and is offered a retry, because the credential was not changed and a person
  can act on that. A refused request (`invalid_request` 400), an unknown provider (403) and a type that no longer matches
  (409) are shown against the field the person just used.
- **A sign-in runs on that host, and is followed by every caller of this one.** The same account is why
  `/api/auth/login/:id` and `/api/auth/logout/:id` are answered here too, see
  [provider sign-in flows](#provider-sign-in-flows).
- **Sign-out names the account, never a flow.** `POST /api/auth/logout/:id` drops whatever the host stores for that
  provider — a subscription as much as a key — and answers the listing that resulted. It is served even by a host that
  runs no sign-in flows, because it is the removal the listing already owns.

### Provider sign-in flows

A provider's own device, manual and copy-code flows run on that same host, driven by `@earendil-works/pi-ai`'s login
against `~/.pi/agent/auth.json` (`packages/gateway/src/provider-login.ts`, served on `POST /v1/providers/login`). The
ingress relays them over one path per provider (`packages/gateway/src/ingress/providers.ts`):

- `POST /api/auth/login/:id` starts a flow; with `?flow=` it answers the question that flow is asking.
- `GET /api/auth/login/:id` reads the flow this caller has open for that provider, or the one `?flow=` names — which is
  how a reloaded panel resumes a sign-in nobody cancelled. Where the caller has both an open flow and an ended one still
  held readable, the open one answers: the ended record is an outcome, and reporting it in place of a live flow would leave
  a panel following the previous attempt. A terminal flow on a read is therefore expected, not an error, and the panel starts
  a fresh sign-in on seeing one — the start is the idempotent one, so a flow really is open answers the same flow.
- `DELETE /api/auth/login/:id?flow=` ends that flow and nothing else. Ending it reaches the credential store too: the
  write a finished exchange makes is handed the flow's abort signal, so a flow this host ended cannot leave a credential in
  `auth.json` because its network work happened to settle first.
- `POST /api/auth/logout/:id` drops the host's stored credential for that provider.

The claims that shape this surface:

- **A flow is polled, not streamed.** A person finishes a browser flow on another device, so the tab that opened it is
  expected to reload or close. A stream would read that as a cancellation, which hands a flow's lifetime to a socket.
  Polling leaves the host's own deadline as the only thing that ends it. A flow's id is the whole of a caller's claim on
  it: one ingress shares one host bearer across its clients, so the host keys each flow by the caller it admitted (a
  device credential's id, or this origin's own web session) and answers a stranger with the same `flow_unknown` 404 it
  would give an id that never existed.
- **A revoked caller loses its own flows, and no one else's.** This entrance re-checks a device bearer while that
  caller's request is attached and tells the host to forget the caller's flows when the credential is gone, so a revoked
  client cannot leave a flow running that finishes and stores a credential nobody can now reach. The provider's wait is
  cut short rather than run out; because the exchange with the authorization server may already have completed, this is
  reported as an outcome the host does not claim to have undone, and the dropped flow writes no credential: the store write a
  finished exchange makes carries the flow's abort signal, and is refused at both moments this host owns — waiting behind
  another writer, and committing what the provider returned.
- **A start is idempotent per caller.** A repeated start, or a start whose answer was lost, rejoins the caller's open
  flow instead of opening a second authorization address that would race the first for one file entry.
- **Nothing a flow says is a credential.** The answer a person typed and the token a flow produced are masked out of
  every step, event and error this surface passes along, in both directions. What has to stay whole to be usable does:
  the authorization address (its PKCE challenge is the provider's, and masking it breaks the sign-in) and the code a
  person reads to another device (RFC 8628's user code is not a bearer token).
- **Its limits stay named.** A host composed without the sign-in service — an SSH gateway, or a deployment that only
  ever stores keys — answers 501 `code: "unsupported"`, so the panel withholds sign-in while the key path and sign-out
  beside it keep working. An unconfigured host service answers 503 `provider_auth_unavailable` and an unreachable host
  503 `provider_auth_unreachable`: both are retryable faults, never a deployment's limit. A refused request (400), an
  unknown provider (403), a flow that is not waiting for an answer (409), a host at its flow limit (429) and an id that
  is nobody's open flow (404) are shown against the field the person just used.

### The two directions stay apart

The Backend reaches a host only through the execution gateway's internal listener, with the execution token. The client
listener serves no `/v1` route at all, and the same internal route refuses the client cookie, the ingress's service
credential and any client bearer. A deployment where the ingress and the execution gateway are the same process still
keeps two listeners, two bind addresses and two credentials; nothing is proxied from one to the other, so a request
cannot recurse back through the ingress.

## The shared workbench, and whose state a page holds

Ticket 05 moves the React workbench out of the Next app and into `packages/ui`, which both hosts mount. What differs
between them is stated by the host and nowhere below it:

| Host | Router | Ingress origin | Credential | Build |
| --- | --- | --- | --- | --- |
| Web | `BrowserRouter` — the query is the page's search string | empty: the page's own origin | the httpOnly cookie the browser attaches | `apps/web`, Vite, static |
| App | `HashRouter` — the query is the fragment of the bundled document | the configured Gateway origin | a device bearer the shell holds | `apps/app`, Vite, inside the shell |

**One logical query, whichever address it lives in.** The workbench reads `location.search` from the router the host
mounted and writes a search string back through a replace-navigate; it never assembles a path or a `#`, and it never
reads `window.location`. That is what makes `?session=` and `?cwd=` mean the same thing on a served page and in a
packaged App, where `window.location.search` is empty because the query is in the fragment. `next/navigation` is gone
with the Next router; the session and folder callers were updated in the same change and no old link form is preserved.

**A page holds one connection's state.** A client is created per connection from the descriptor the ingress answered,
and the profile, Backend id and account scope it names are the key every scoped store uses:

| Store | What a wrong key would do | Scoped by |
| --- | --- | --- |
| composer drafts (`sessionStorage` + memory) | show one connection's unsent text in another's composer | `profile\|backendId\|accountScope` |
| remembered conversation views (page memory, LRU) | answer a lookup with another Backend's history for the same id | the same scope plus the session id |
| staged lifecycle turns (page memory) | restore a turn that belonged to the previous connection | the same scope plus the composer key |

Durable conversation ids are unique **within one Backend**, so two connections can hold a conversation with the same
id — an App profile switch, or two Web origins behind one profile. Switching connection is therefore a new scope that
starts empty, not a re-read of the same keys, and nothing is imported from the previous one. A connection's answers are
fenced by its **disposal** — a disposed client refuses the request, the body and the frame — while a conversation's
**acquisition** generation orders reads and frames within one conversation. They are two questions, and treating a
reconnect as a newer read is how the first would answer the second.

**One lifecycle owner, one stream owner.** The extraction moved the session hook, the pure projections and the
completion registry into the shared package; it did not add a second state machine. `AgentEventConnection` remains the
only owner of a conversation's stream, opened by the first reader and closed by the last, so the open surface and a
background interest in the same conversation read one connection and releasing one of them closes nothing.
`dispose` on a client closes that connection's streams, revokes its blob leases and refuses later requests; it never
stops the run, which ends only through its own durable stop.

**One transport, and the host states its way in.** The descriptor, the session catalogue, the conversation read, its
history pages, every submission and its request-id lookup, the stream lease and the folder validation are all asked on
the connection's client — its Gateway origin, its credential, and nothing at all once it is disposed. No surface below
the workbench assembles an origin, a header or a relative path, and none of them reaches a global `fetch`: in the App
that would ask the bundle's own document, under no credential, for a conversation it does not serve. The stream is the
same fact: each host states the source of its own ingress (a Web page's same-origin address under its cookie, an App's
configured Gateway origin under its device bearer), and the workbench's completion registry reads the client's one
connection rather than opening a second one. Closing that registry releases the readers it added and closes no socket.

**One assembly per connection, and the request seams are that connection's own.** `workbenchConnection(client, identity)`
in `packages/ui/src/lib/workbench-scope.ts` is the one place a connection is built: the client, the scope key, the
identity it was admitted as, the file surface derived from the client and the conversation API of that client. The
workbench calls it from the effect that owns the client's lifetime, so a StrictMode replay builds one live connection and
a switch builds the next one; every browser fixture calls the same function, which is what keeps a fixture from handing
the production surfaces a lookalike. `useApiRequest`, `useWorkspaceApi`, `useCapabilityServed` and
`useSessionUiState` therefore ask `connection.client.request` and have no page-origin fallback: a relative `fetch` in
the shared tree would ask the App bundle for a route it does not serve, and there is no product surface mounted outside
a connection that would need one. The Web host's own sign-in and public probes stay on the page's `fetch`, because they
are the page host's routes rather than the Backend's.

**Both navigation reads are relayed as written.** `GET /api/conversations/:id/navigation` answers the Backend's own
bounded page of committed user-message anchors, and `GET /api/conversations/:id/navigation/around` the bounded target
window one of that page's coordinates addresses — opaque coordinates, ordering cursors, snapshot and scope identities,
capped previews, projected entries with their read-block URLs, and stated byte sizes. This listener forwards each exactly
as the Backend wrote it. It re-pages nothing, renames no field, re-truncates no preview and invents no reason for a read
the contract refused; the bytes a caller reads and the bytes the Backend answers for the same query are equal, for a page
and for a window (`packages/gateway/test/ingress-navigation.test.ts`). A second owner of the outline would be a second
answer about which user messages a conversation holds, and a relay that re-projected a window would be a second projection
of history content, so neither is added here. See [Chat](chat.md#the-full-history-navigation-outline).

**The route vocabulary is the Backend's own.** The workbench asks `/api/conversations…`, which is the route this
ingress forwards unchanged, so a Web page and an App reach one conversation contract through one entrance. The only
translation this ingress makes is the deferred read block (`/api/sessions/:id/entries/:entryId/{text,thinking,tool-result-image}`
→ the Backend's own `/api/conversations/:id/entries/…`), because that address is a wire fact the protocol builds for both
halves of a client. Everything else under `/api` is forwarded as written, so the retired Next BFF's `/api/sessions…` and
`/api/agent…` paths reach the Backend and are answered `404 {code:"not_found"}` there — a client on the old vocabulary has
the right origin and credential but no route behind it.

The client half is `packages/ui/src/lib/conversation-api.ts` (`createConversationApi`): one API per connection, built
with the connection (`workbenchConnection`) so AppShell, the sidebar, search, raw history, Settings, the references
surface and the session hook read one object instead of assembling the same one each. The catalogue and its running
poll, search, create, the conversation read, the by-id open, bounded history pages, the request-id submission lookup,
settings, commands, an explicit reload, the raw history read and the auto-name ask are each one request on the
connection's own client; the named control operations are `@hepi/session/control` over that same client. A catalogue row is a projection of
the Backend's own answer (`conversation-catalogue.ts`), and the list version it carries is the Backend's, never a second
derivation. The event stream is `conversationSource()` in `@hepi/session/browser`: a same-origin
`/api/conversations/:id/events` under the page's cookie, or the App's Gateway origin under its device bearer.

**The catalogue, project, workspace and worktree surfaces read the Backend's own routes too.** `packages/ui/src/lib/workspace-api.ts`
(`createWorkspaceApi` / `useWorkspaceApi`) is the one seam the sidebar, the folder picker, the New Project dialog and the
New Session context bar ask: `GET /api/workspaces`, `GET /api/projects`, `POST /api/projects`, `DELETE /api/projects/:id`,
`DELETE /api/projects/:id/folders/:folderId`, `GET /api/hosts`, `GET /api/host/directories` and
`POST /api/worktrees { workspaceId, operation }` for the list, create and remove of a checkout. The retired Next BFF's
`/api/sessions/ui-state`, `/api/home`, `/api/default-cwd`, `/api/cwd/browse` and `/api/worktrees?cwd=` are not asked any
more: the sidebar document is `/api/sidebar-state`, and the home and "use default directory" answers are derived from the
workspace and project listings the Backend publishes (`configuredHome`, `configuredDefaultCwd`). Two capabilities no
Backend route serves are stated as limits instead of requested: a folder picker offers existing directories only (the
retired BFF created one on the Web host), and "open in file manager" is a capability of the machine the browser runs on,
which this page is not.

**No client names the computer it is served from.** Which execution host an origin's callers belong to is the
deployment's own fact, so the ingress states it (`HEPI_INGRESS_DEFAULT_HOST`, and `HEPI_WEB_LOCAL_GATEWAY_ID` for the Web
process) on the requests it forwards and the Backend resolves it against its configured gateways. Only a **remote** target
— a profile the Backend's own `GET /api/hosts` listed — is named by the caller, so browsing another computer is always an
explicit choice and never a fallback. A worktree operation is addressed by a workspace id, which is the Backend's binding
resolution to the host that holds the project's folders; the host's own refusals keep their names (`dirty`,
`not_supported`, `unreachable`, `outcome_unknown`).

Nothing here changes what a lost answer means. A `requestId` is still the identity of an attempt, `GET
/api/conversations/:id/submissions?requestId=…` is still the only recovery, and a refusal (4xx) stays distinct from an
outcome this client could not establish. Bounded history is still the Backend's `/entries?before|tail` page.

**The scope is installed before the tree renders.** The connection's scope is what every scoped store keys by, so it is
stated during the composition root's render rather than in an effect: effects run from the leaves up, and a composer that
waited for one would read its draft under the previous connection's scope — or under none at all on the first mount —
and then save that text under the new connection. A composer additionally reads and writes only while the store is
installed for its own connection, so a tree that somehow outlives its scope adopts nothing.

**One load, one snapshot.** The conversation read and the `/state` read answer the same native snapshot, so a load that
wants both asks once and projects that one accepted answer for the transcript and for the composer beside it. A read the
fold refuses still takes a fresh state read, because a window the surface has already replaced is not the conversation's
current composer state — which is the same reason a resync takes one.

The App's build is checked for what it may not carry: no Next module, no Node builtin, no coding-agent runtime and no
internal credential reach its bundle, and the browser smoke asserts the scope, the blob revocation and the logical query
in a real Chromium rather than in a Node module graph.

## Settings over the client API (ticket 11)

The settings a client reads and changes travel the same `/api` surface as everything else, so they inherit the one
credential check and the one Backend. The ones a Backend owns are forwarded unchanged; the ones no owner serves are
named as this deployment's limit instead of being answered as a missing conversation.

| Route | Owner | Answer |
| --- | --- | --- |
| `GET /api/models` | Backend | the models it can actually serve, their limits, the thinking levels each accepts, and the model it starts a conversation with (stated as `null` when it configured none) |
| `GET`/`PUT /api/models-config` | Backend | its own `models.json`: read as the deployment holds it, written only after validation on a throwaway runtime, applied to the live runtime |
| `GET`/`POST /api/extensions` | Backend | the installed extensions with their tools and sections, and the global default selection a **new** conversation takes |
| `GET`/`PATCH /api/conversations/:id/settings` | Backend | that conversation's model and thinking level |
| `PATCH /api/conversations/:id/extensions` | Backend | that conversation's own extension selection and the tools it now offers |
| `GET /api/descriptor` | Backend, via the ingress | the identity a settings cache is scoped to: Backend id and account scope |

### What is a limit, and what is a missing route

A settings capability no process owns answers `501` with `code: "unsupported"` and a sentence naming the reason. The
ingress states it **before** forwarding, because a plain forward would reach the Backend's conversation router and answer
`404 conversation not found` — which a client reads as "this deployment serves it, your request was wrong", and a panel
turns into an error instead of a named limit. The check sits after the identity check, so a stranger cannot enumerate
what this deployment does not do.

| Not served | Why |
| --- | --- |

| `/api/models/enabled` | the enabled-model scope is not served here |
| `/api/models/refresh`, `/api/models-config/discover`, `/api/models-config/catalog`, `/api/models-config/test` | provider catalog refresh, discovery, upstream catalog and connection test are not served here: each needs a network pass over a provider's endpoint. Which models a credential this host stores *authenticates* needs no such pass and is resolved afresh on the Backend's own reads (docs/providers.md), so this limit is not what keeps a newly stored key from appearing |

A panel reads these as the deployment's own statement and withholds the control, exactly as it already did for the
routes the retired Next BFF answered that way. The one rule is
`packages/ui/src/lib/capability-availability.ts`: `capabilityServed` asks a route, `unsupportedCapability` reads the
same limit off an answer a panel already has, and `capabilityNoticeKey` decides the text. A request that never arrived
reads as *unknown*, never as a limit — offline, a proxy or a timeout says nothing about which routes exist.

The question travels the **connection**, not a relative `fetch`: `useCapabilityServed` asks through the workbench's own
`WorkbenchClient`, so an App whose page was loaded from a bundle asks the Gateway it was admitted to instead of
resolving `/api` against an origin it does not have. There is no second transport to fall back to: every one of these
questions is about the Backend this workbench was admitted to, and a surface that has no connection is not mounted at
all (`useWorkbenchConnection` states that as a wiring error).


### Two scopes, and they are different owners

The global default extension selection is what a **new** conversation materializes; a conversation that already exists
keeps the selection written into it, so a later change to the default never rewrites it. A per-conversation selection is
written into that conversation's own `pi.agent.extensions`. A conversation bound to no execution workspace cannot select
the extension that needs one, and a name this deployment has not installed is refused as a whole (`400`,
`unknown_extension`) rather than partially applied.

A model and a thinking level are that conversation's own settings. A model the deployment does not offer is refused
(`400`) and the conversation keeps the model it had, so the recovery is another pick rather than a lost session; a
thinking level this build does not know is refused as a level.

### What a client is never told

The four materials stay apart here too. The catalog carries provider id, model id, name and limits — never a credential
and never a base URL — and the settings answers hold that: the catalog, `models.json`, the extension inventory and a
conversation's settings contain no service credential, no device credential and no provider secret. A `$NAME` reference
is the operator's own configuration and is what the editor shows; the value it resolves to is the material. A refusal
never echoes the bytes it read, which is why a parse failure is reported as a fixed sentence rather than the reader's own
message. The `x-hepi-client` header the ingress sets for the Backend is not echoed back either: it is the ingress's
statement, not a client fact.

### A settings cache belongs to one connection

The model catalog is read on every conversation switch, so a client caches it — but a cached catalog is only valid for
the connection that read it. Two Backends, or two account scopes of one Backend, can serve the same folder path and offer
different models, so the scope is the **whole** key: the Backend id and account scope the descriptor states, plus the
caller's own key (a cwd, a conversation) inside it. In-flight reads are scoped too — a read for one connection never
resolves another's request — and a save bumps a generation so a read that was already running when the save happened
cannot populate the cache with the answer the save replaced.

The rule lives once, in `@hepi/session/settings` (`connectionScopeOf`, `createScopedCache`); `createScopedCache` is the only
export a caller uses, and the catalog cache in `models-cache.ts` is one instance of it rather than a wrapper around it.
The composer's own catalogue read (`useAgentSession.loadModels`) is wired to it: the read goes through the workbench's
`WorkbenchClient` — this Gateway's origin and this connection's credential — and the page's one cache holds the answer
under the connection's scope plus the folder, so a switch reads the new connection's catalogue instead of the previous
one's and two selectors on one page share one read. Closing Settings changes nothing — the refresh is the write, not
the dismissal, and a dialog closed without an edit neither drops an entry nor asks the deployment anything.
The answer itself is read by one function, `packages/ui/src/lib/catalog-answer.ts`. This ingress forwards the Backend's
catalogue as the Backend states it — `models` is the list of models it can serve — while the retired Next BFF restated
the same list twice, a `provider:id` → name map under `models` and the entries under `modelList`. The workbench reads
both into one shape before any selector sees them, so a deployment whose answer carries a list cannot be read as though
its models were a name map. That mismatch is not cosmetic: it put model objects where a name belongs and the composer
failed to render at all.
The workbench's catalog cache (`packages/ui/src/lib/models-cache.ts`) is that rule rather than a second copy of it, and
the scope it keys by is the same identity `packages/ui/src/lib/connection-scope.ts` gives every other scoped store, so
drafts, remembered views and a cached catalog cannot disagree about whose connection they belong to. The instance lives with the rule rather than with the hook that first
read a catalog, because the surface that supersedes the answer is a different one: Settings › Models stores or removes a
provider credential, and its write is what a change is stated through.

**A change is stated once and followed by whoever is mounted.** `models-cache.ts` holds both halves of the rule: the one
page cache, and `subscribeModelCatalog`, the set of mounted readers. Every writer of a model-domain resource — a
`models.json` save the Backend reported `applied`, a stored or removed credential, a sign-in that stored one, an
`enabledModels` write — calls `invalidateModelCatalog()`, which drops the cached answer and then tells those readers.
Each reader re-runs its own bounded read (the same one its mount makes, failures retried on the same delays), so a
composer on screen shows the list the write produced **while Settings is still open**, and a page with no mounted reader
asks the deployment nothing until something reads it again. Nothing is fetched, resent or re-selected by the rule itself:
the answer says what the deployment offers, never what a conversation should run, so the current model and the draft stay
as they were.

A write that did not apply claims no change. A `models.json` save answered `applied:false` reads the file back and
states saved-but-not-applied; a refused credential write leaves the listing and the catalog exactly as they were. A
catalog read that fails is stated where the model is chosen, with a Retry that is one more read of the same route and no
part of a mutation. There is no `modelsRefreshKey` between the shell, the chat window and the conversation hook: the
same write that used to wait for the dialog to close is what states the change now.

Nothing is signalled to the Backend when a credential changes, because there is nothing a signal could say that the
Backend does not re-resolve on the read it was already going to make. Which models a credential authenticates is decided
by the availability pass of the account that process was configured with: environment mode consults its own
`HEPI_*` variables and no file at all, while Pi mode reads its configured agent directory's `auth.json` afresh rather
than from a cache. That file is the one this Gateway writes only when both processes were pointed at the same directory
— same account and path, and across hosts a shared or identically mounted one; a Backend elsewhere reads its own
(docs/providers.md). Availability therefore belongs to the Backend's account, and a cached page answer is the only
staleness a credential change creates here. That is the
distinction `POST /api/models/refresh` stays a limit for: fetching *which models exist* at a provider is a network read
of a third party, a different capability, and the enabled-models view withholds that button where this origin answers the
limit rather than reporting a provider endpoint as unreachable.

A shared read outlives the composer that started it, so its lifetime is the **connection's**: a composer that goes away —
including the cleanup half of a StrictMode replay — retires its own interest in the answer and never cancels a read
another composer is waiting on, while disposing the connection aborts the request on the wire and refuses an answer whose
transport replied late. What a composer's own abort still fences is its own state: a shared answer that arrives after it
left is not written into a composer that is gone.

A descriptor that states no Backend id or no account scope is refused instead of defaulting: collapsing an unstated
identity into one shared scope is how two connections would start reading each other's settings.

### Verification

Command, revision, exit code and log for the tests that hold this contract are recorded in
[ticket 11's own answer](../.scratch/client-app/issues/11-models-providers-and-extensions.md), beside the checks that
were run on the adapted revision. The ingress tests run over real HTTP against a real Backend and assert only what a
client can observe through it; the cache tests hold the scope rule at its own seam.

## The Web build on this origin

The Web page is a Vite build — static files and a browser router — and the ingress serves that directory on its own
origin, beside `/api`. Same origin is the point: the Web session is an HttpOnly cookie scoped to this origin, so a page
served anywhere else would have to reach this API cross-origin with a credential the browser will not attach, and a
second static host would be a second deployment to keep in step with this one. No framework runtime is added: this is a
file lookup, not a second application server.

| Request | Answer |
| --- | --- |
| `GET|HEAD` a path that names a published file | that file, with the MIME its extension states |
| `GET|HEAD` a navigation path that names no file | the build's `index.html`, so a route the workbench owns is openable directly |
| `GET|HEAD` a missing **file** (its last segment has an extension, or the path ends in `/` below the root) | `404` `{ error: "not found" }` — never the page |
| any other method | `404`, unchanged from a deployment that serves no page |
| `/api/...`, including an unknown route | the client API's own answer; an unknown route stays the API's `404` and is never the page |
| `/v1/...` | `404`, as before: the execution listener is a different bind |

**Confinement.** A request names a file *under* the configured root or it names nothing. Segments are decoded once,
before any comparison, so an encoded `..` is refused as the traversal it is; a segment that decodes to a separator or a
NUL is refused for the same reason. The candidate and the root are both resolved through their real paths, so a symbolic
link inside the build that points outside it is refused too, and a path that leaves the root is answered `404` rather
than refused with a reason — absence is the only fact this surface owes a caller.

**Cache.** A Vite asset states its own content in its file name, so `assets/*-<hash>.<ext>` is answered
`cache-control: public, max-age=31536000, immutable`. Everything else — `index.html`, `manifest.webmanifest`, `sw.js`,
`offline.html`, an unhashed icon — is republished under the same name by the next build, so it is answered `no-cache`
with a weak entity tag and revalidated, and a revalidation that still matches is a `304` with no body. A stale service
worker is a page that cannot be replaced, which is why it is never cached immutably.

Every answer states `x-content-type-options: nosniff` and a `content-type` derived from the file name, so a browser
never re-decides a type from the bytes. `HEAD` answers the same headers and no body. A file is piped rather than
collected, and a caller that goes away ends the read with it.

Nothing here changes the client API: the same cookie and bearer checks, CORS answers and revocation re-checks apply to
`/api` exactly as they did, and a static request is never forwarded to the Backend.

## Every request checks, and nothing is cached

Each request's identity is checked against the Backend's records before anything is forwarded, and the ingress keeps no
success. A revocation is therefore effective on the next request. A response that stays open — a conversation event
stream — is re-checked on the revocation interval, so an already attached stream ends within **one interval
(1000 ms by default) plus scheduling**, which is the declared revocation bound. Revoking access ends access; it does not
abort the agent run behind it, which stops only through its own durable stop command.

A Backend or credential authority that cannot be reached is a refusal, not a remembered grant: a device bearer is
answered 503, and the Web session cookie is only as good as the ingress's own material, so an unreachable Backend yields
no data. The ingress never logs a token, and it never forwards the caller's cookie or bearer to the Backend.

## Verification

Command, revision, exit code and log for the tests that hold this contract are in
[verification](verification.md#client-ingress-and-device-credentials-ticket-02),
[verification](verification.md#client-ingress-conversation-slice-ticket-03),
[ticket 05's own record](../.scratch/client-app/issues/05-shared-ui-routing-and-scope.md#answer) and
[verification](verification.md#conversation-control-queue-fork-and-relations-ticket-10). The credential tests run over
real HTTP against a real Backend, covering the Web cookie, the device bearer, issuance and revocation, restart
persistence, preflight, the refusal of every other material, the absence of the internal execution surface, and the
revocation bound on an attached stream. The static tests run over real HTTP against a real temporary Vite-shaped
`dist`, covering the page shell, asset MIME, immutable versus revalidated cache policy, `304` revalidation, `HEAD`,
traversal and symlink confinement, a missing asset staying `404`, the SPA fallback, and the `/api` separation in both
directions. The conversation tests run over the same seam with a real execution gateway
behind the Backend, covering the read/create/submit/follow contract, the native frames, the default host, request-id
recovery after a lost answer, byte-identical stream pass-through, the heartbeat, cancellation reaching upstream, and the
routing between the client listener and the internal execution listener. The control surface's own suite is recorded
beside them.

## Conversation control, queue, fork and relations

Ticket 10 adds the named domain operations a client calls to control a conversation, and they are what
`packages/session/src/control.ts` (`createConversationControl`) exposes. Each one is **one request to the Backend's own
route**: the Backend owns the control revision, the receipt a request id names, the queued item, the branch, the
reference and the tombstone, and nothing on this side keeps a copy of any of them, infers "busy", or schedules a retry.

| Operation | Route it reaches | What the Backend answers |
| --- | --- | --- |
| `stop(requestId, { expectedControlRevision? })` | `POST /api/conversations/:id/stop` | the outcome, whether the ordinary scope still drains, the committed control and the durable receipt |
| `continueRun(requestId, { text?, whenBusy?, expectedControlRevision? })` | `POST /api/conversations/:id/continue` | `resumed`, `stopping` (the hold and every queued item stay) or `allowed` |
| `control(requestId?)` | `GET /api/conversations/:id/control` | the committed control, plus that request id's receipt — the read that resolves a lost answer |
| `send(requestId, text, { whenBusy?, queueOnly?, images? })` | `POST /messages`, or `POST /busy` when `queueOnly` | the submission, the control it was admitted under, and a resume answer when one happened |
| `recallQueue()` | `POST /api/conversations/:id/recall-queue` | the withdrawn text, in queue order, for the composer to edit |
| `items()` / `editItem()` / `cancelItem()` | `/api/conversations/:id/items[/:submissionId]` | the queued item, the conditional edit and the native cancel |
| `fork({ at?, requestId })` | `POST /api/conversations/:id/fork` | the branch's identity and its catalogue row |
| `delegate({ name, task, requestId, conversationId? })` | `POST /api/conversations/:id/delegate` | the child (or the dispatch), with `created` telling a new child from a replay's |
| `addReference({ conversationId, entryId?, label? })` | `POST /api/conversations/:id/references` | the referencing conversation's references with each one's named outcome, idempotent by target plus entry; an unresolvable target or entry is refused by that outcome's own code and stores nothing |
| `info()` / `rename()` / `remove()` | `GET`/`PATCH`/`DELETE /api/conversations/:id` | relations and native edges, the new name, or the tombstone |
| `subtreeControl({ requestId, action, selected? })` | `POST /api/conversations/:id/subtree-control` | the captured scope, one durable outcome per child and that child's current catalogue row — see [subtree stop and interrupt](chat.md#subtree-stop-and-interrupt) |
| `subtreeRequest(requestId)` | `GET /api/conversations/:id/subtree-control?requestId=` | the same record read back, or `null` for the Backend's own `unknown_request`: the read that resolves a lost answer and refreshes a race the caller lost, while controlling nothing |

A queue-only admission (`whenBusy` steer or follow-up) never resumes a held conversation: staging a draft is not the
user's decision to continue, and only `continueRun` or an immediate `send` is. It carries the **same content** an
ordinary send carries — the protocol's own text and image blocks — because the queue-only route is the same admission
seam with `resume: false`: a draft is admitted with what the user wrote it with, and the Backend answers a draft it
cannot admit (an empty body, an image the selected model cannot read, an attachment the protocol refuses) **before**
anything is queued, so the surface can keep the text and the images instead of being told the turn was staged. The one
asymmetry that remains is deliberate: a queued item is the runtime's own inbox entry, and `recallQueue()` hands its
**text** back for the composer to edit — an attachment on a recalled item is not returned (recorded limit, not a
silent drop of the admission). Every operation that writes is the
Backend's own commit, so two clients of one conversation read one authoritative state — the control and the queue ride
the same state frame the stream publishes, and neither is inferred from the answer a client just received.

### Three outcomes, and no fourth

Every operation answers one of three things, and they are deliberately not interchangeable:

- **a value** — the Backend's own answer;
- **a refusal** — a 4xx, carrying the Backend's status, its code (or the `reason` its receipt recorded) and its message.
  A refusal will never be admitted, so it is safe to show and safe to act on;
- **an unknown outcome** — no answer was received: a dropped connection, a 5xx from the hop in front of the Backend, a
  body this build cannot read. It carries the **request id the attempt was made under** and is **never retried**. A lost
  write may have committed, and the only honest resolution is to ask the conversation about that id — `control(id)` for
  a stop or a resume, the submission lookup for a message, the same attempt id for a fork or a delegation. That is the
  same rule [ADR 0006](adr/0006-durable-submission-lifecycle.md) already states for a pending submission — an unknown
  outcome is looked up, never resent — so one conversation does not have two vocabularies for a lost answer.

The request id therefore belongs to the **attempt**, not to the HTTP request: a fork or a delegation that is retried
reuses the identity of the attempt it repeats, and only an attempt that has **settled** releases it. For a subtree request
that settles two ways — its own answer, or a read-back that states `completed`, which is where a lost race actually
settles — and both release it, because a held identity is answered from a capture that is already finished and reads as a
control that reached nobody. The identity is also paired with the selection confirmed under it (`subtreeConfirm`), so a
resume repeats that subset rather than one re-read from a listing that has moved since.

### Provenance and identity

A fork and a delegation create a conversation whose identity is its own: the native fork source (or owner edge), the
creator, the display parent and the definition a child came from are four separate facts, and the child's configuration
and context strategy come from the definition rather than from the request. A failed create is a refusal with its own
code and creates nothing; a retried attempt is answered with the conversation it already made, so a lost answer cannot
manufacture a second copy.

A removed conversation is out of the catalogue, keeps its records readable by id, and refuses every control write with
`session_deleted`. Revoking a device or losing a connection ends access, never the run: a run stops only through the
conversation's own durable stop.
