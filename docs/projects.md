# Projects

A **Project** is a display name and one or more existing folders on one execution host, exactly one of which is its
**default**. A new conversation runs in the default folder; every other folder is metadata — not a tool root, not an
injected prompt — and exists so an already-created conversation stays resolvable when the default later changes. A
project itself creates nothing: every folder is chosen from what already exists on the host.

The host may be **this computer** (the Web origin's own, `HEPI_WEB_LOCAL_GATEWAY_ID`) or **a configured SSH host**:
one of the backend's configured gateways and, on it, one configured SSH profile. All of a project's folders are on that
one host; a project never mixes computers. A remote folder is chosen from the remote host's own directories, validated
and canonicalized by that host, and registered under the same kind of opaque workspace id a local one gets — so
execution, files, installation and workspace management all resolve it through one lookup. See
[ADR 0005](adr/0005-ssh-project-one-profile-explicit-owner.md).

## What a project records

| Field | Meaning |
| --- | --- |
| `id` | The project's display identity. Unrelated to any folder and to any workspace id. |
| `name` | Display-only. Nothing is named after it on disk. |
| `hostId` | The configured gateway id that serves the execution host every folder is on. |
| `profileId` | The configured SSH profile of that host, for a remote project. Absent for a local one. |
| `defaultFolderId` | The project's own folder that **new** conversations bind. |
| `folders[].id` | The folder's identity inside the project. This is what `defaultFolderId` names. |
| `folders[].workspaceId` | Opaque and stable, one per folder. This is what a conversation binds. |
| `folders[].root` | The canonical path of that folder. |
| `createdAt` | When the project was recorded. |

A project stores no gateway URL or token: the connection belongs to the deployment's environment, and the project only
names the configured host it uses. See [ADR 0003](adr/0003-projects-bind-runtime-registered-workspaces.md) for why the
host is named rather than inferred.

## What a browser cwd is

The browser addresses a workspace as `/workspace/<workspaceId>` and never sees a physical root. That vocabulary is
declared in `@hepi/protocol/files` (`packages/protocol/src/files.ts`), because the client ingress reads it as well as the
workbench: the parser, the cwd sentinel and the predicates over it (`workspaceRoutingLocation`,
`workspaceIdOfRoutingPath`, `isWorkspaceRoutingPath`, `UNBOUND_CWD`, `isUnboundCwd`). The project rules built on it —
groups, defaults, roots — stay in `packages/ui/src/lib/project-routing.ts`, and a surface imports the vocabulary from the
protocol and the project rules from the adapter, so neither is reached through the other. Every surface takes its answer
from those instead of parsing a path itself:

- **`/workspace/<id>`** is a workspace location. The file tree, the file index, Git and the worktree list exist only
  for one, and the workbench adapter serves only these paths.
- **`/durable`** is the adapter's own cwd for a conversation with **no execution workspace** — a conversation recorded
  before any workspace was bound. It is not a directory on any host. Such a conversation stays in the sidebar and its
  chat stays open, it is not a "recent project" and has no project identity, and the workspace surfaces are not asked
  about it at all: there is no folder to list, no Git status to read and no project to trust. Because it names no
  folder it is also **no group of its own**: a sidebar sitting on that cwd shows no empty project named after the
  sentinel, and only a conversation with no execution workspace can put a row under such a group.
- **A physical root the host itself reported** — a configured workspace's root, or a project folder's root — resolves
  to that workspace's routing path, ignoring a trailing separator. This is what makes an old bookmark or a remembered
  path reach the folder it names instead of being refused. Nothing is guessed from the shape of a path: a directory
  the deployment does not serve has no routing path and is still refused.

**A routing path is never shown as a path.** `/workspace/<id>` is correct for every request and wrong as a label:
it names a folder by an opaque id a person cannot place. Every surface that *shows* a location shows the folder
instead, and every call that *addresses* one still sends the routing path. A session's row carries both — `cwd` and
`projectRoot` are the routing address, `projectDisplayRoot` is the folder the host reported — as does a validation
answer (`cwd`/`projectRoot`/`projectKey` beside `displayRoot`) and a project folder (`cwd` beside `root`). One
helper turns an addressed path into the shown one (`displayPathUnder` in `packages/ui/src/lib/display-path.ts`), so the
sidebar's group headers, the shell's title and session detail, the search results, the file tree's and viewer's path
tooltips and a terminal tab's name all read the folder, while the file tree, the viewers, Git, the terminal protocol
and the config panels keep addressing the routing path.

`POST /api/cwd/validate` and `GET /api/worktrees?cwd=` answer the same identity for the same path, so the sidebar
cannot report a different project than the folder it is showing. The delivered home-navigation guard keeps a
conversation open while the folder identity is being resolved; its original implementation was `9e5af9d`, integrated
in `242796f` with the driver correction in `c122f0b`. `POST /api/default-cwd` names the workspace the
deployment was configured with, so a new session starts where its conversations run; `GET /api/home` reports the home
of the account the tools run as, as the host itself reports it, and never the `/durable` sentinel.

SSH Worktree listing runs Git and directory-presence checks in the same resolved repository directory. Removing
a profile's initial linked checkout therefore does not break listing of a surviving checkout or the existing main-repo
fallback. A transport failure remains a named Worktree failure. This discovery does not rebind a conversation whose
execution folder was removed.

## Configuration

| Variable | Process | Role |
| --- | --- | --- |
| `HEPI_WEB_LOCAL_GATEWAY_ID` | **Web UI server** | Which of the backend's configured gateways serves *this Web origin's* execution host. Sent as `hostId` on the host-scoped requests that **choose** a host (browsing, creating a Project, the home and default-directory answers). Unset, or naming a gateway the backend does not configure, makes those routes answer `configuration_required`. It is **not** sent on a recorded Project's own metadata operations: those act on the host the Project itself records. |
| `HEPI_PROJECTS` | backend | Project metadata database. Defaults to `projects.sqlite` next to `HEPI_DB`. |
| `HEPI_GATEWAYS` | backend | Optional JSON array of `{ "id", "url", "token" }`, for a backend that serves more than one execution host. |
| `HEPI_GATEWAY_ID` / `HEPI_GATEWAY_URL` / `HEPI_GATEWAY_TOKEN` | backend | The single-connection form of the same thing, used when `HEPI_GATEWAYS` is not set. |
| `HEPI_SSH_HOST`, `HEPI_SSH_PROFILE`, `HEPI_SSH_PORT`, `HEPI_SSH_IDENTITY`, `HEPI_SSH_KNOWN_HOSTS` | gateway | The SSH host a gateway serves. A gateway configured with `HEPI_SSH_HOST` serves the profile `HEPI_SSH_PROFILE` (default `loopback`) and offers it as a remote execution target. |

`HEPI_GATEWAY_URL` is the address **the backend** reaches a gateway on (in the split deployment, the tunnel's loopback
address). The browser never receives it, nor a token: the Web origin proxies project and directory requests through the
backend.

The host mapping is a property of the Web origin, not of the backend, because one backend can serve several Web UIs on
different computers. Each origin names its own host and can only browse or create a project on that host. A deployment
with no `HEPI_WORKSPACE_ID` can still create projects.

A Project, once recorded, names its own host — the one its folders were registered on, which for a remote Project is a
configured SSH gateway and not the origin's own computer. Its metadata operations (`PATCH`, folder unlink, removal)
resolve that recorded identity: the origin's `hostId` is not required and, when a caller does send one, it may only
confirm the recorded host. A request naming a *different* host is still refused with `409 wrong_host`, and one naming
a gateway this deployment does not configure with `409 configuration_required`. That is what lets the origin which is
showing a remote Project remove it, and it changes nothing for a Project on the origin's own host.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /api/projects?hostId=` | Every recorded project, its folders and its default. The account is resolved for the host the calling origin named; another host's project reports that host instead. |
| `POST /api/projects` `{ hostId, name, folders: [{ root, default? }] }` | Registers every folder on the named gateway and records the project, as one registry workflow. Exactly one folder must carry `"default": true`, and no folder may repeat: either is `400` `invalid_request`. `400` `invalid_root` for a folder that is absent or not a directory, `409` `configuration_required` for a missing or unknown `hostId`, `503` `gateway_offline` when that host cannot be reached. Nothing is recorded unless every folder was accepted. |
| `PATCH /api/projects/:id` `{ defaultFolderId, hostId? }` | Names another folder **of that same project** its default. The host is the Project's own recorded one; `hostId`, when a caller sends one, must name that host. `400` `unknown_folder` when the folder is not the project's (mere existence elsewhere is not enough), `404` `unknown_project`, `409` `wrong_host` when a named host is not the project's, `409` `configuration_required` when the Project's own host is not configured. This is the metadata contract only: no control edits the default on its own. The one place a user changes it is a folder's unlink, whose prompt asks which folder becomes the default when the default folder is the one being removed. |
| `DELETE /api/projects/:projectId/folders/:folderId?defaultFolderId=&hostId=` | Unlinks **one** folder, metadata only, acting on the Project's recorded host; and is the folder's own operation rather than a default change. A non-default folder goes on its own and the project's default is unchanged. The project's **default** folder may only go when `defaultFolderId` names another folder of the same project that stays, which is what leaves the named folder the default. Removing the project's **last** folder removes the project record in the same transaction, so no read ever returns a folderless project. Answers `200` with the project as it stands (or `null` when it went) and `removedFolderId`, `400` `unknown_folder` for a folder that is not the project's or a replacement that is not another of its folders, `400` `default_replacement_required` for the default folder removed without a replacement, `400` `unexpected_replacement` for a replacement named while unlinking a non-default folder, `404` `unknown_project`, `409` `wrong_host` for a named host that is not the Project's, `409` `configuration_required` when the Project's own host is not configured. |
| `DELETE /api/projects/:id?hostId=` | Removes a project's **metadata only**, on the host the Project itself records: the project record and its folder links go in one transaction, together with a retained binding per folder. No directory is created, changed or deleted, no conversation is deleted, no workspace id is reused and no host registration is undone. Nothing is refused because conversations are bound — no conversation is read at all, so no bound-conversation count exists to return. Answers `200` with the project that went, `404` `unknown_project`, `409` `wrong_host` for a named host that is not the Project's, `409` `configuration_required` when the Project's own host is not configured. |
| `GET /api/host/directories?hostId=&profileId=&path=` | The directories of the named host's execution account below `path` (its home when no path is given), with the account that listed them. With `profileId`, the listing is that profile's own remote host; the path must be absolute. |
| `GET /api/hosts` | The execution targets the deployment configured: each gateway id, and for a remote gateway its profiles with the host, the configured root, and the account the host itself reports. Ids and names only — never a URL or a token. |
| `POST /v1/workspaces` (gateway, bearer token) | Local: `{ operation: "list" }`, `{ operation: "register", workspaceId, root }`, `{ operation: "browse", path? }`, `{ operation: "profiles" }` (an empty list). SSH: the same with `profileId` on `register`/`browse`, and `profiles` answering the gateway's configured profiles. |

Browsing is read-only and is not confined to a workspace root — choosing a root is what it is for. It returns
directory names and canonical paths only, and it runs as the gateway's own execution account. File and execution
requests keep their existing confinement.

## Behaviour worth knowing

- **No filesystem mutation.** Creating a project records existing folders. Neither the dialog nor the backend creates,
  renames or deletes a directory, and the folder picker offers no "new directory" control on this path.
- **One default, and only the default is a new conversation's root.** Every new-session affordance of a recorded
  project — the header's New, a group's own "+", the composer's bar — binds the project's default folder, whichever of
  its folders the sidebar happens to show. The other folders are never additional tool roots and are never injected
  into a prompt.
- **Binding is permanent.** A conversation binds one folder's workspace id and never changes it. Naming another folder
  the default affects new conversations only: every folder of a project stays resolvable for the conversations already
  bound to it, and a default change never moves one.
- **A folder has an unlink of its own, and a Project is never left without a default.** Unlinking a non-default folder is separate from the default selector: the default is untouched, and the folder's own conversations keep running where they are. The default folder may only go when the same request names another of the project's folders as the replacement; the last folder's removal takes the project record with it in the same transaction. Every unlink writes the same retained binding a project removal does, so it leaves the folder exactly as resolvable as a removed project's folder — and exactly as unavailable as a new target.
- **Removal removes metadata only, and the binding outlives it.** A folder's binding needs the workspace id and root from the folder row plus the host id and profile id from the project row, so deleting the project row would otherwise cost a conversation bound to one of its folders its execution environment — it would keep its history and its stored workspace id and silently lose `read`/`write`/`edit`/`bash`. The removal therefore writes a **retained binding** (`workspace_id, host_id, profile_id, root`) in the same transaction, additive to the schema and changing nothing about the existing project, folder or default-folder records. Resolution is configured workspaces, then retained bindings, then project folders.
- **A retained binding is never a target and is never pruned.** It stays in `GET /api/workspaces` carrying `retained: true` — that is where a bound conversation's display root is resolved from — and is excluded from every new-session picker, from `GET /api/home` and from `POST /api/default-cwd`. `POST /api/conversations` refuses it as `unknown workspace`, so no new conversation can bind it. Nothing deletes a conversation here, so nothing prunes it, and re-adding the same directory mints a new workspace id: the host refuses a different root for an id it already holds, so a retained id cannot be re-pointed.
- **The retained record is what re-registers the root.** There is no unregister operation on a gateway, so a removal cannot stop a host serving a root it already knows, and a gateway that restarts serves nothing but its own seeded workspace again. The retained record names the host and profile, so the backend replays it on every start and before every request that uses it, exactly as it replays a project's folders.
- **Every recorded folder re-asserts its root.** A gateway keeps its registered roots in memory, so the backend
  registers all of a project's folders again, idempotently, whenever it builds that conversation's execution
  environment. An already-bound conversation therefore keeps running in its own folder after the gateway alone
  restarts, without a new conversation. Registration is the only thing replayed: a call whose outcome was unknown when
  the gateway went away fails normally and is never repeated.
- **The Project menu offers both operations, and says what they leave alone.** A project's own menu in the sidebar
  lists its folders — each named by its own path on its host — and offers the project's removal. Unlinking a
  non-default folder asks for confirmation first: the copy states that only hepi metadata is removed and that no
  directory on disk and no conversation is, and the folder then leaves the list, the sidebar and the picker without a
  page reload. Unlinking the default folder asks which of the project's other folders becomes the default before
  anything is sent, and its control stays unavailable until one is chosen; the last folder's removal says the project
  itself goes with it. A refusal — the replacement the backend now requires because the default moved elsewhere, an
  unknown folder, an unknown project — changes nothing and is shown in the backend's own words. Every window of one
  backend hears a removal from the poll it already runs (the registry's own revision on the catalogue read), so the
  other window's sidebar and picker drop the project too.
- **A bare load opens nothing.** A page whose URL names no conversation — a first visit, a bookmark, a new tab —
  adopts no project and opens no conversation: the sidebar lists the sessions under their groups, and the window is
  named by no folder until the user picks one. Only an explicit pick, a `?cwd=`/`?session=` URL, and the tab's own
  remembered pick open something. A deployment's configured workspace is reached like any other project — by being
  picked, or through `POST /api/default-cwd` when the user asks for the default directory — and never by landing on
  the page, which is what made a deployment come up titled by its own configured workspace.
- **One registry owns resolution, registration and publication.** `apps/server/src/project-registry.ts` composes the configured workspaces, the optional ProjectStore, the configured gateway connections and the live metadata a conversation resolves through. It states the one precedence order (configured, then retained, then Project folder), answers the catalogue row's workspace facts, re-asserts a recorded root on its own host — at boot through `registerAll`, before a request through `ensureBinding` — and owns `projectsRevision`, which advances once per accepted mutation and never for a read, a refusal or a failed store write. Routes decode a request, ask the registry and encode the answer; they no longer splice a project list, assemble a binding twice or increment a revision. The four project mutations are registry workflows rather than array edits: `create` resolves the host the calling origin named, validates the profile that host serves and registers every folder before anything is recorded; `setDefault`, `unlink` and `remove` first resolve the host the **Project records** (which a named host may only confirm) and then act. Each answers either the committed metadata or its own refusal — code, status and sentence — so a route states the answer it is given instead of translating a domain refusal into HTTP itself, and none of them touches the host to change a directory. A deployment without a ProjectStore still resolves, prepares and lists its configured workspaces, and every project mutation answers its existing unavailable outcome. The store's schema and transactions are unchanged: the registry borrows the store's lifetime and never closes it.
- **The catalogue states the binding, so a list is one read.** Every catalogue row carries its workspace's facts —
  `gatewayId`, the root the deployment recorded for it (`workspace.root`), whether a removal retained it
  (`workspace.retained`), and the Project it is a folder of (`workspace.project`: id, name, the default folder's
  workspace id and the group's display root). The Backend assembles that from the metadata it already holds, so
  `GET /api/conversations` answers a whole list without a host round trip and without reading any conversation's
  history, and the Web adapter projects the answer instead of reconciling the catalogue against a separate project
  read and a separate workspace read. What the row deliberately does not state is the root the *execution host*
  reported for a **configured** workspace: this deployment holds such a workspace as an id and a host, never as a path,
  so that one root comes from `GET /api/workspaces` — one read for the whole list, not one per row. See
  [Chat](chat.md) for the catalogue read itself.
- **One project, one group.** A project's conversations appear in the sidebar as one group named by the project
  whatever folder each one is bound to, instead of one group per folder. The runtime's own root conversation is no
  group at all: it is a framework record, so the catalogue never lists it and no surface shows it as a project named
  after the `/durable` sentinel (see [Chat](chat.md) for the catalogue).
- **An old database migrates in place.** A `projects.sqlite` written by the single-folder version — one `workspace_id`
  and one `root` column per project — is rebuilt in one transaction into a project plus one folder carrying that same
  workspace id and root as its default. The rebuild preserves every id and path and rolls back as a whole on failure.
- **An offline host is local to its projects.** Its projects report `hostError`; nothing is redirected to another
  host, and the rest of the backend keeps working.
- **A remote folder is on the profile it was registered with.** The gateway stores the profile beside the root, so the
  same lookup serves execution, files, installation and the workspace surface. A second configured profile of the same
  host has its own roots and never answers for the first one's folders.
- **Remote needs Python 3 on the host.** Directory listing, path confirmation and the file and installation helpers all
  run one standard-library program over the existing SSH runner; nothing is installed on the host and no service
  listens there. A host without Python 3 reports `not_supported` rather than a substituted local answer, and the
  remote workbench (files, changes, diff) is not served by an SSH gateway at all — `packages/gateway/src/main.ts`
  builds the workbench only for a local gateway. A remote conversation still reads and writes files and runs shell
  commands through the coding tools; what is missing is the browsable workbench subset (see docs/workbench.md).

## Verification

- `apps/server/src/project-registry.test.ts` — the registry as its own interface, over a real gateway and a real
  temp SQLite store: configured-then-retained-then-Project precedence with a non-default folder resolving to its own
  root and its group's display root, resolution and reads reaching no host, targets excluding retained ids while the
  listing still states them, `ensureBinding` registering a Project folder and a retained root on its own host,
  `registerAll` replaying every folder of a project, a deployment with no ProjectStore still resolving and preparing
  its configured workspaces while every mutation answers its unavailable outcome, a creation whose host or profile
  refuses recording nothing, a Project on another host refused as `wrong_host`, and the publication revision moving
  once per accepted mutation and never for a read or a refusal.
- `packages/gateway/test/workspaces.test.ts` — registry validation and idempotence, host browsing, and the RPC that
  makes one registration visible to execution, files and workbench at once.
- `apps/server/test/project.test.ts` — project creation (one folder and several), a project removal whose directory and file are byte-identical afterwards with its bound conversation still running a workspace tool and its retained id refused as a new target, a retained root re-registered after the gateway alone restarts, a removal of a project with several folders retaining every one of them, one folder unlinked from a project with its default unchanged and the unlinked folder still executing for its bound conversation while refused as a new target, the default folder's removal refused without a replacement and accepted with one, the last folder's removal taking the project with it and its retained record re-registering the root after a gateway restart, tool execution in the chosen folder,
  an extra folder refused as a tool root, the default-change contract with an existing conversation keeping its folder,
  an existing workspace conversation keeping its own root, a backend restart, a gateway restart with the backend still
  running and no new conversation, a restart resolving every folder, migration of a real single-folder database
  (fixture written with the old DDL, asserted through this API), an offline host, the configuration error, and two Web
  origins on one backend each using only the host they named.
- `packages/ui/src/lib/workspace-api.test.mjs` / `workspace-api.http.test.mjs` — the request side of the removal and
  the unlink against a stand-in ingress: an id encoded as a path segment and as a query value, the project list the
  backend's own answer produces, and a refusal reading as the reason the backend gave rather than as a silent success.
- `apps/server/test/` project and workspace suites — the rules the removal is built on: which folder's removal must
  name a replacement and which takes the project with it, and the replacement default riding the same unlink call.
- `packages/ui/src/lib/project-routing.test.mjs` — every folder of a project resolving to the project's group and default, the
  one parser of the browser's workspace vocabulary (a bare prefix, an empty id and the `/durable` sentinel are no workspace), a
  reported root resolving to its own workspace with a trailing separator and nothing else, and a conversation with no
  execution workspace never becoming a recent project.
- Browser journeys that used to cover the project menu, the New Project dialog, workspace routing and the default
  workspace (`ux-project-removal`, `ux-new-project`, `ux-workspace-routing`, `ux-default-workspace`) started the retired
  Next build and were deleted with it. The rules they read from the DOM are held above by the backend suites, the
  client-request suites and `project-routing.test.mjs`; a browser half for these journeys is a recorded coverage gap,
  not a passing claim.
- `packages/gateway/test/ssh-workspaces.test.ts` — the SSH workspace surface against a **real localhost `sshd`**
  (its own host key and key pair, pinned known-hosts, ephemeral port): the target list naming the account the host
  reports, a real remote directory listing, a registration that execution, files and installation all serve at once,
  the legacy `remote-<profile>` id still resolving, an unregistered prefix refused, and a host without Python 3
  reporting `not_supported`.
- `packages/ui/src/lib/workspace-api.test.mjs` — the client's own half: a removal reaching the backend's `DELETE` with the host the origin serves, a refusal forwarded with the backend's status and code, a retained binding passed through with its marker, `GET /api/home` and `POST /api/default-cwd` never answering with a retained folder, a conversation bound to one still listed with its display root and its marker, and a folder unlink reaching the backend's own folder route with the replacement default riding the same call.
- `packages/ui/src/lib/project-routing.test.mjs`, `packages/ui/src/lib/session-family.test.mjs`, `packages/ui/src/components/SessionSidebar.marker-effect.test.mjs` — the retained marker through the pure rules and the tree: a retained group reports itself as such and keeps its conversations and its rows, its group offers no new-session control, the sidebar's project list leaves it out, and a retained folder is no recent project.
- `apps/server/test/ssh-project.test.ts` — a remote project created through the public API over the same real `sshd`:
  the target list, the remote listing, the recorded profile, a conversation whose `bash` and `read` run on the remote
  host (the same relative name resolving to the remote copy while the local one is untouched), a local project beside
  it reading its own file, a bare SSH gateway restart with no new conversation, two profiles on one host each reading
  their own root, a removed remote project whose retained profile id is what puts its root back on that host after the SSH gateway alone restarts, an unlinked remote folder whose retained profile id is what keeps its bound conversation executing there after that same restart, and an unreachable host reported truthfully with no local fallback.
- `apps/web/e2e/workbench-files/ux-ssh-project.mjs` — the whole remote user path in a browser over the same real `sshd`, with two
  configured gateway connections: the dialog offering both remote targets, the account the chosen host reports, the
  remote picker, the recorded profile, `bash`/read running remotely, the group's own new session binding the remote
  default, a bare gateway restart still executing that conversation, the second profile reading its own file, and a
  reload plus backend restart keeping the project, its profile and its remote folder. The page's origin is the **client
  ingress** serving `apps/web/dist` (`HEPI_UX09_PAGE_DIST` overrides the directory), so it needs
  `pnpm --filter @hepi/web build` first and runs no Next server.
