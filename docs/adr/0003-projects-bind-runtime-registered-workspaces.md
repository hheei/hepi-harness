# Projects bind runtime-registered workspaces on a named Web host

A **Project** is metadata: a display name, one or more existing folders on one execution host, and exactly one of
those folders named the **default** — the single-root workspace its new conversations bind. Creating one never creates
or renames a directory. See [ADR 0004](0004-one-project-many-folders-one-default.md) for why a project holds several
folders and how the default is changed.

The host is **named by the Web origin**, never inferred. Each Web UI server states which of the backend's configured
gateways serves its own execution host (`HEPI_WEB_LOCAL_GATEWAY_ID`) and sends that name on every host-scoped
request; the backend resolves the name against its configured connections. Without a name the answer is an explicit
configuration error.

Scope: local (Web host) projects in this version. SSH projects were ticket 09 work and keep the existing
`remote-<profile>` identity; that extension was delivered afterwards and is recorded in
[ADR 0005](0005-ssh-project-one-profile-explicit-owner.md), which replaces the id's spelling with one explicit owner map.

Status: accepted (UX follow-up ticket 07; extended by tickets 08 and 09)

## Considered options

- **Have the backend infer the Web host from its own default workspace.** Rejected: one backend commonly serves more
  than one Web UI, each on a different computer (the Oracle and workstation origins of the real deployment), and the backend's
  configured workspace names the gateway the *backend* reaches — not the machine any given browser is on. A guessed
  host would list one computer's directories under another computer's account.
- **Have the backend read a single `HEPI_WEB_LOCAL_GATEWAY_ID` from its own environment.** Rejected for the same
  reason: with two Web origins there is no single answer, and the variable would silently answer for whichever origin
  did not have one of its own. It belongs to the Web process, where the mapping is one-to-one.
- **Infer the host from the backend container's directory or the Web process's cwd.** Rejected: neither process runs as
  the Web host's execution account, and a container path is not the host's.
- **Give the Web UI its own gateway URL and token.** Rejected: it duplicates a credential into a presentation client
  and lets the UI reach a gateway the operator never scoped for it. The Web origin asks the backend, which asks the
  named gateway; the browser holds an id at most, never a URL or token.
- **Keep workspace roots fixed at gateway boot.** Rejected: then a project could only use the folder the deployment
  already configured, which is not "choose any existing folder on this computer".
- **Derive the workspace id from the folder path.** Rejected: a later default-folder change (ticket 08) would then
  move a workspace that existing conversations are bound to. The id is opaque and stable.
- **Create the chosen directory when it does not exist.** Rejected: New Project records an existing folder. Directory
  creation is not a project operation, and a typo must not silently produce a new tree.

## Decision

- **The Web origin names its host.** The Web UI server holds `HEPI_WEB_LOCAL_GATEWAY_ID` and sends it as `hostId` on
  host browsing and project creation (and as a query parameter when listing projects). The backend resolves it against
  the gateways the deployment configured (`HEPI_GATEWAYS`, or the single `HEPI_GATEWAY_*` triple) and refuses an
  unnamed or unknown one with `configuration_required`. The account is always the one that gateway reports for itself,
  never the backend's, and a Web origin can only ever reach the host it named.
- **Runtime workspace registration.** A gateway serves workspace roots through one shared registry used by its
  execution, filesystem, installation and workbench surfaces, so a root registered at runtime is served by all of them
  at once. `POST /v1/workspaces` registers an existing directory under an id; the same id with a different root is
  refused (`workspace_conflict`) instead of moving a workspace another conversation may be bound to. Registering the
  same id and root again is idempotent, because the backend re-asserts its projects rather than remembering which
  gateway currently holds them.
- **Read-only host browsing.** `POST /v1/workspaces` also lists the directories of the gateway's own execution
  account. It is deliberately **not** confined to a workspace root — choosing a root is what it is for — so it is
  read-only (directory names and canonical paths, never file content) and it is the gateway's account that lists, not
  the backend's or the browser's. Everything else keeps its confinement: every file and execution request stays inside
  the workspace it names.
- **Project metadata is its own store.** A project lives in its own SQLite file next to the conversation database
  (the separation [ADR 0002](0002-skills-follow-execution-environment.md) already established) and records a display
  name, a host id, its folders — each with an opaque workspace id and a canonical path — and which of them is the
  default. It stores **no gateway token**: the connection stays in the deployment's environment, and a project can
  never be routed to a host the operator did not configure.
- **A bound conversation re-asserts its own folder's root.** A gateway keeps registered roots in memory, so the backend
  registers the folder a conversation is actually bound to — idempotently — whenever it builds that conversation's
  execution environment (every tool call, every run's prefix, and every installation target). A conversation that was
  already bound therefore keeps running in its own folder after a gateway restarts, with no new conversation and no
  user action, and a project's default can change without disturbing it. Registration is the **only** thing replayed:
  an execution, write, installation or other request whose outcome was unknown when the gateway went away is never
  repeated, and a gateway that restarts mid-call produces that call's ordinary failure.
- **Conversation binding is unchanged.** A conversation still stores one workspace id and never changes it. A changed
  default (ticket 08) selects a different workspace for new conversations; it does not retarget existing ones.
- **Failure isolation.** A recorded project whose host is unreachable is reported on that project
  (`hostError`) and never falls back to another host, and it never stops the backend: conversations without a
  workspace, the model catalog and the conversation list keep working.

## Consequences

- Registration is reachable by anything holding the gateway token, which is the same trust domain that can already run
  shell commands in the gateway's workspaces. The gateway still confines every file and execution request to a
  registered root; registration adds roots, not permissions beyond the account the gateway already runs as. The backend
  registers a project's folders as it records them, so a folder registered by a request that then fails at the
  metadata step is left registered: it is an existing directory on that host, not a grant, and a later request reusing
  the same folder is idempotent.
- The chosen folder is stored canonically. Two names for the same directory (a symlinked parent, a trailing slash) are
  the same project folder.
- Project metadata is listed for every origin, but the account is resolved only for the host the calling origin named:
  another host's project is reported as belonging to that host rather than showing a Web origin an account it does not
  serve.
