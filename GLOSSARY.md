# Durable Harness

One authoritative agent runtime serving several workspaces, where each workspace's work happens on a machine the operator controls.

## Language

**Project**:
A named grouping of one or more existing folders with one designated default folder. Its name is display metadata, rather than a filesystem directory name.
_Avoid_: workspace, directory

**Default Project Folder**:
The Project folder designated as the working directory for new conversations. Existing conversations retain the folder selected at creation; other Project folders do not automatically become their working roots.
_Avoid_: project root, current folder

**Execution Environment**:
The environment in which an agent's file and shell tools actually run, backed by a single execution host. It is the runtime source of execution-side resources.
_Avoid_: sandbox, container

**Execution Host**:
The machine and logged-in identity behind an execution environment. Global installation scope is defined by this pair, not by the workspace.
_Avoid_: server, node

**Execution-Side Resource**:
A skill, prompt, or context file present on the selected execution host. They share a resource category while retaining their distinct roles in agent context.
_Avoid_: asset, artifact

**Skill Bundle**:
A versioned, distributable unit of skill content together with its metadata. It is stored and distributed, never executed in place.
_Avoid_: package, plugin

**Skill Repository**:
The harness-owned store that keeps, versions, and distributes skill bundles. It answers management requests and holds no execution role.
_Avoid_: skill registry, marketplace

**Skill Metadata**:
The descriptive part of a skill that names it and advertises it to the model. It is separate from the skill's executable content.
_Avoid_: manifest, frontmatter

**Installed Skill**:
A skill whose files are present on an execution host, however they got there — repository install, hand-written, git, or a Pi install. It is usable without any connection to the repository.
_Avoid_: deployed skill, cached skill

**Provenance**:
What is recorded about where an installed skill came from and which version it is. Unknown provenance means unrecorded, not absent.
_Avoid_: origin, source

**Installation Scope**:
Whether an installed skill belongs to an execution host and login (global) or to a project directory on that host (workspace).
_Avoid_: level, target

**Global Installation**:
An installed skill shared by every workspace reached through the same execution host and login. It is not private to one workspace.
_Avoid_: user install, system install

**Workspace Installation**:
An installed skill belonging to one project directory on an execution host. Other entry points may reach it through ancestor discovery; it is not bound to a single UI view.
_Avoid_: local install, project install

**Skill Discovery**:
The act of finding the skills installed on the active execution environment. It reports what is installed and fails explicitly when that environment is unreachable.
_Avoid_: scan, sync

**Workspace Resource Loader**:
The runtime component that discovers and reads execution-side resources through the active execution environment. It supplies the conversation's adopted resource loading result.
_Avoid_: resource loader, skill service

**Locally Modified**:
Describes an installed skill whose content no longer matches the content hash recorded when it was installed. It is a reported state, not an error, and it is not a comparison against the repository's latest version.
_Avoid_: dirty, diverged

**Routing Path**:
The opaque `/workspace/<id>` address a browser uses when it calls a workspace-scoped API. It names a workspace, not a location a person can read.
_Avoid_: workspace path, URL cwd, workspace alias

**Project Display Root**:
The folder path the execution host itself reported for a project's default folder, which is what a surface shows in place of the routing path.
_Avoid_: project root, shown path, real path

**Conversation**:
The runtime's own durable record of one agent conversation — its committed history, its runs and its control — which the
Backend owns and is the only authority on. A surface holds a projection of it, never a second copy. The catalogue line
about one is a **Session Row** and the client library that reads one is the **Session Transport**, so neither is a
conversation of its own.
_Avoid_: chat, thread, transcript, session

**Session Row**:
One conversation's line in the catalogue a surface lists: its identity, workspace, run status and relations as the
Backend states them, plus the listing fields a sidebar orders it by. It describes a conversation and carries none of its
history, so a change to a row's listing fields is not a change to the conversation.
_Avoid_: session record, session info, catalogue entry

**Session Transport**:
The client library (`@hepi/session`) a surface uses to read and submit one conversation: it folds the Backend's frames
into the state one attachment holds and sends that conversation's input. The Web page and the App each assemble it with
their own source, and it holds nothing durable.
_Avoid_: session store, session service, agent client

**Unbound Conversation**:
A conversation recorded before any execution workspace was bound. It carries no workspace, no project identity and no project display root, and no workspace-scoped surface is asked about it.
_Avoid_: legacy chat, sentinel workspace

**Agent Definition**:
A reusable description of a role, its starting instructions, context preparation choices and selected capabilities, from which conversations can be created. It is configuration, not a running conversation.
_Avoid_: agent instance, worker session

**Main Conversation**:
A conversation with no parent in the main/child hierarchy. It may have been created by a user or another conversation.
_Avoid_: user-created conversation

**Child Conversation**:
A conversation explicitly placed under a parent conversation, with its own identity and history. Other conversations can reference it without changing its parent.
_Avoid_: nested message, delegated run

**Conversation Reference**:
A stored pointer from one conversation to another, optionally to one entry of it, used to locate content or supply context. It does not change the referenced conversation's parent, grants no control over its target, and copies none of its content.
_Avoid_: fork, ownership edge, copied transcript

**Reference Outcome**:
The named reason a stored Conversation Reference cannot be followed now — `target-missing`, `target-unavailable` (the
target was removed), `entry-missing`, `entry-out-of-scope` (the entry is not in that target's visible committed
fork-aware history), `stale` (it resolved and no longer does) or `error` (the read failed, so nothing was
established). It is the Backend's answer, not a message a caller parses, and it never stands in for a nearest surviving
entry.
_Avoid_: broken link, dangling reference, unavailable session

**Reference Follow**:
The user action that opens a stored Conversation Reference's target: the conversation itself, or — when the reference
names an entry — that entry, through the same bounded target coordinator a history jump uses (one target read, exact
block placement, presentation-only scroll). It is never a history walk and never a substitute: a reference with a
Reference Outcome opens nothing and shows that outcome, with the offers it can support (retry only for `error`; the
surviving conversation and its raw history for an entry-level outcome; nothing for a target that is gone).
_Avoid_: opening a link, resolving to the nearest message

**Folder Unlink**:
The removal of one folder from a Project's folder list, leaving the Project and its other folders in place. It is the
folder's own operation rather than a default change: a non-default folder goes on its own, the default folder's removal
names its replacement in the same call, and the last folder's unlink removes the Project.
_Avoid_: folder delete, folder removal from disk

**Retained Binding**:
What a folder's workspace address keeps after the folder is unlinked from its Project, so a conversation already bound to
that folder still resolves its execution host, its root and its execution environment. It is never offered as a target
and never pruned.
_Avoid_: orphaned folder, dangling workspace

**Terminal Session**:
A long-lived interactive shell the execution host runs for one user, in a registered workspace root. It has its own
lifecycle — output, input, resize, and an exit that reports the process's own status — and it belongs to no
conversation, so nothing about it enters a transcript.
_Avoid_: shell command, exec call, terminal tab

**Hidden Session**:
A conversation the user has removed from the catalogue. Its records are retained because the runtime has no deletion
primitive, and the surface presents the removal as an ordinary one rather than as a state of its own.
_Avoid_: deleted session, archived session

**Pending Submission**:
A submission the user has sent that the conversation has not yet committed. It is shown from the moment it is sent until it is committed or its outcome is known, and it is not yet part of conversation history.
_Avoid_: optimistic message, in-flight message, draft

**Committed Message**:
A message the conversation has recorded as part of its history. It is authoritative about itself: a report of the conversation that does not yet include it does not mean it was never sent.
_Avoid_: admitted message, server message, persisted message

**Submission Outcome Unknown**:
The state of a pending submission whose result the surface can no longer establish, because the connection carrying the submission or its events ended before commitment. It is not rejection and not commitment, and it is resolved by asking the conversation rather than by assuming either.
_Avoid_: failed submission, lost message, dropped submission

**Reload**:
An explicit refresh of the resources adopted by a conversation from its execution environment. It changes the adopted loading result, not the installed files.
_Avoid_: refresh, hot reload

**Execution Gateway**:
The process on an execution host that owns that host's capabilities — execution, files, terminal, SSH sessions,
MCP servers and provider credentials. It is reached by the Backend with an execution token and by its own client
ingress; it owns no conversation, task or model decision.
_Avoid_: server, host agent, worker

**Client Ingress**:
The one listener a Web page or an App reaches for the client API. It admits a Web session cookie or a device bearer, checks that identity on every request, and reaches the Backend with its own service credential. It serves no internal execution route.
_Avoid_: gateway, proxy, BFF

**Workbench**:
The one React surface tree (`packages/ui`) that both a Web page and the desktop App mount. A host supplies only what
makes it that host — history, ingress origin and credential — so no surface below knows which one it is in.
_Avoid_: UI layer, front end package, Web app

**Retired Diagnostic Page**:
The two HTML pages the Backend used to serve itself — `/diagnostics` and `/workbench` — for an operator to inspect one
conversation or browse files with a token they typed in. Their assets, the `diagnostics.js` bundle and the `build:ui`
step are removed, so the backend serves no page and every route it answers passes admission first. The name survives
only in history; a surface that reads conversations or files is the Workbench.
_Avoid_: admin UI, debug app, second front end, operator page

**Web Session**:
The identity a browser holds after exchanging the Web login material for the ingress's own HttpOnly cookie. It is same-origin, script-invisible, and ended by a logout that clears the same cookie.
_Avoid_: login token, bearer, session token

**Device Credential**:
A revocable identity one App install holds as a bearer token. The Backend keeps the record and its revocation, and stores only the token's digest, so the record cannot be replayed as the credential.
_Avoid_: API key, master token, app password

**Service Credential**:
The material the client ingress presents to the Backend on its own behalf. It authenticates the ingress, never a client, and is refused when a client presents it.
_Avoid_: shared token, backend token

**Execution Token**:
The material that authenticates a caller of the execution gateway's internal listener. No client surface accepts it, and the client ingress does not serve that path at all.
_Avoid_: gateway token, internal key

**Revocation Bound**:
The stated maximum time between a device credential being revoked and every access it carried ending, including a response that was already open. It is one revocation re-check interval for an attached stream.
_Avoid_: expiry, timeout, TTL

**Tool Listing**:
What one configured MCP server answers about its own tools when the host connects it on purpose: names, first-line descriptions, read-only claims, the host's exposure of each, and the server's argument schemas. It is a snapshot taken at a stated moment, never a subscription and never a side effect of reading settings.
_Avoid_: tool discovery, tool catalog, live tool list

**Tool Descriptor**:
One entry of a tool listing, as a surface shows it to a person. A tool the server did not name has no descriptor, and a listing that could not carry every tool it read says so rather than reading as a server with fewer tools.
_Avoid_: tool schema, tool info

**MCP Exposure**:
What the execution host's own `mcp.json` states about a server or one of its tools (`codemode`, `deferred`, `direct`, `hidden`). It is the host's claim, read by exact tool name, and it is not a conversation's selection: an exposed tool is still callable only by a conversation granted it.
_Avoid_: enabled, available, selected

**MCP Grant**:
One conversation's own durable allowlist of MCP tools, written only by a person's act: the identity of each tool plus the host's descriptor as it stood when the grant was made. It is the level inside the extension selection, and the only route an MCP tool has to a conversation's offer on this backend. A grant is never the host's answer about its server, and nothing it states is a ceiling over what another conversation may be granted.
_Avoid_: selection, permission, enabled tool, subscription

**Operator Fallback**:
The MCP tools one deployment declares (`HEPI_MCP_TOOLS`): identities and presentation this backend states without asking a host. It grants nothing, permits nothing and offers nothing by itself — a conversation is offered an MCP tool only through its own grant. Unset, it declares no fallback and disables no server.
_Avoid_: grant ceiling, allowlist, default grants, deployment offer

**Navigation Anchor**:
One committed user message as the history rail shows it: the entry's own identity, a short preview of its committed
text, and the opaque coordinate a jump is addressed by. An assistant answer, a tool result, a compaction summary and a
reset handoff are not anchors, and an anchor's ordinal position orders pages without ever becoming its identity.
_Avoid_: minimap node, turn marker, message index

**Rail Node**:
One entry of the history rail: a committed user anchor's identity, its ordering cursor and its bounded preview, joined
with the measured turn when the transcript carries it. A **loaded** node has measured geometry, so every local
user/assistant/heading jump works on it; an **unloaded** node is listed by identity, order and preview alone, with no
pixel position invented for it. A turn the transcript measures but the outline does not enumerate — an assistant-only
prefix, a compaction marker — is not a node once a page exists, and a measured turn newer than the newest listed anchor
is one, because the reader's window sits at the tail.
_Avoid_: minimap turn, virtual node, estimated height

**History Scope**:
The identity a navigation page was read under, carried by every anchor coordinate it issues: the conversation plus the
newest head marker of its committed history. An append leaves the scope alone, so anchors keep their coordinates; a
compaction or a reset moves the head marker, and a coordinate stamped with the scope before it is refused by name rather
than landed nearby.
_Avoid_: revision counter, offset, snapshot hash

**Outline Prefix**:
What the committed history holds before its first anchor, stated as a fact of the page that scanned it: `none` when
nothing precedes it, `non-user` with the count of entries when the conversation opens with content the user never wrote.
A leading segment is never turned into a fabricated anchor.
_Avoid_: synthetic anchor, first-turn padding, preamble

**Navigation Outcome**:
The one state a jump or a deep locate settles to: `held` (landed), or a named failure — `missing`, `stale-snapshot`,
`wrong-scope`, `malformed`, `cancelled`, `deferred-busy`, `error`. Every request settles exactly once and every failure
is rendered with its own sentence, a retry and a dismissal; a locate that did not land is never reported as handled,
and a failure does not retire the request either — the banner offers to retry it, so only a landing or the reader's
dismissal ends it. `cancelled` and `deferred-busy` are the client's own names, the rest the Backend's.
_Avoid_: silent handled, generic error, toast

**Viewport Hold**:
The span in which a navigation, rather than the reader, owns the transcript's scroll: from a target the shell hands
over until that target is on screen or its navigation is decided. Older-history paging stays silent for exactly that
span, so a window moving toward a deep entry cannot load the pages it passes.
_Avoid_: scroll lock, animation guard, suppress loading

**Target Window**:
The bounded slice of committed history one navigation coordinate addresses: a number of mountable messages either side of the anchored entry, in the shape the transcript already renders, with the entries it could not carry named by a boundary cursor. It is read from the conversation's own fork-aware history and pinned to the snapshot the caller names, so a turn committed afterwards does not move it. Placement inside it is stated by identity: the entry and, for a search hit, its native block index.
_Avoid_: around page, neighbour entries, scroll offset
