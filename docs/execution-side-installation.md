# Execution-side installation (ticket 06)

A Skill Bundle is published onto an execution host explicitly, at an explicit scope, from the conversation that asked
for it. The repository supplies content; the gateway publishes it. Nothing here executes bundle content, and installed
skills load without any repository connectivity (ADR 0002).

## Where installation lives

| Concern | Module | What it owns |
| --- | --- | --- |
| Narrow host capability | `packages/gateway/src/install.ts` | Staged publication of one whole directory into one installation scope, inspection of an installed directory against a digest set, and the scope's lock document. Local and SSH hosts implement the same shape. |
| Orchestration | `apps/server/src/skill-install.ts` | Reading the bundle from the repository, the install-time baseline, provenance, the update state, and reporting publication and adoption as two outcomes. |
| Routes | `apps/server/src/server.ts` | Authenticated entry points: `GET /api/skill-market/search`, `POST /api/skill-market/install`, `GET /api/skill-market/installed`, `POST /api/skill-market/update`, `GET /api/skill-market/inventory`. An installation names its execution target — an explicit `workspaceId`, or the initiating conversation, or both when they agree. |
| UI | `packages/ui/src/components/SkillsConfig.tsx` | The retained builtin Skills panel: an execution-host selector, the host's own skills with their provenance, the harness library and the skills.sh public catalog as two labelled sources inside the same global/project destinations, each with its own loading/empty/failure state, and one outcome region rendered outside every installed/status switch. The standalone Market panel and the Web-host skill helpers it shared (`lib/skill-market.ts`, `lib/skill-updates.ts`, `lib/skill-lock.ts`, `lib/skills-service.ts`, `lib/skill-frontmatter.ts`) were removed in ticket 14; the frontmatter edit now lives in `packages/gateway/src/skill-frontmatter.ts`, on the host that owns the file. |

A workspace a Project removal retained is not an installation target. Its binding stays resolvable for the
conversations already bound to it, and it is no folder new work may be sent to, so the panel's execution-host selector
leaves it out (`selectableWorkspaces`, `packages/ui/src/lib/skill-inventory.ts`) — the same rule the new-session pickers
apply. The backend's install target list is built from the configured workspaces and the recorded Project folders, so a
retained binding is never offered there either.

The capability is **not** the general file RPC. `/v1/installs` accepts no caller-chosen destination path: the scope
selects a root, and the directory is a slug under it. Ordinary resource mutations keep their existing boundaries — the
file RPC refuses mutations naming resource paths. This is path discipline within a trusted-agent environment,
not a sandbox: shell commands and workspace-internal symlink aliases can modify resources. Installation publishes
bundles through its explicit scope-based capability.

## Scopes and destination

- **Global**: `<execution account home>/.agents/skills/<name>`. Shared by every workspace reached through the same
  execution host and login; the account is resolved on the host, never guessed from the gateway process.
- **Workspace**: `<bound workspace root>/.agents/skills/<name>`. The workspace is the initiating conversation's bound
  workspace, so a conversation cannot install into a host it is not bound to.

The lock document lives beside the skills directory it describes: `<scope parent>/.skill-lock.json`.

## Atomic publication

Files are written into a fresh sibling directory named `.hepi-install-<random>` inside the scope root, so the staging
directory is on the same filesystem as the destination and one rename publishes it. A failed or interrupted
publication removes the staging directory and leaves the destination untouched; no partial skill directory is ever
visible. The published directory is re-checked to be inside the scope root and not a symlink.

An existing destination — including a dangling link, or a link to somewhere else — is refused with `conflict`. A
confirmed overwrite reuses this staging seam and adds the backup step, not a different publication path.

## The lock document

```json
{
  "version": 1,
  "skills": {
    "pdf": {
      "source": "repository:pdf@1.0.0",
      "sourceType": "repository",
      "ref": "1.0.0",
      "version": "1.0.0",
      "skillPath": "/home/operator/.agents/skills/pdf",
      "scope": "global",
      "installedAtMs": 1700000000000,
      "files": { "SKILL.md": "<sha256>", "scripts/fill.py": "<sha256>" },
      "contentHash": "<sha256 over sorted path\0hash pairs>"
    }
  }
}
```

The entry shape is borrowed from pi-web's `.skill-lock.json` (`apps/web/vendor/pi-web/lib/skill-lock.ts`: source,
sourceType, skillPath, ref, folder hash) with the install-time baseline spelled out per file. The per-file hashes and
the directory hash are adapted from cc-switch `services/skill.rs` `compute_dir_hash` / `collect_files_for_hash`
(see `apps/server/vendor/cc-switch/README.md`).

An **absent entry or absent baseline is unknown provenance**, never proof that content was locally modified. Ticket 07
compares a host directory against this baseline to distinguish unchanged from locally modified content.

A lock that exists but cannot be parsed, or whose entries this gateway cannot extend, is refused with `invalid` and is
never overwritten. The lock is rewritten through a temporary file in the same directory and one rename.

## Updating an installed skill

An installation already at the chosen scope is **updated**, not installed over. Before anything is written the host is
asked what it actually holds, and that is compared with the install-time baseline recorded at installation:

| State | Meaning | Replaced |
| --- | --- | --- |
| \`unchanged\` | Every entry matches the baseline, by path and by digest, and the directory hash matches. | Without a confirmation: nothing would be discarded. |
| \`locally-modified\` | A file was added, removed, changed or turned into a link since installation. | Only after an explicit confirmation. |
| \`unmanaged\` | No baseline, or no directory: unknown provenance. | Only after an explicit confirmation. |

The comparison is over the host's **real** entries, so an added file, a deleted file, a replaced file and a new
symlink all read as a modification — a symlink is hashed as \`link:<sha256 of its target>\` and can never collide with
file content. A missing baseline is unknown, never proof of modification, and it is never silently treated as
unchanged.

A replacement is **pinned to the digest set the caller actually saw**, and the request carries it: the status answer
reports `skill.files`, and the update sends that same set back. The host re-reads the directory at the mutation boundary
and refuses the replacement (`conflict`) if it no longer matches, so an edit that arrived after the user looked is never
discarded on the strength of a stale inspection — and a fresh read taken at publication time is never accepted in place of
the confirmation the user actually gave. A request that carries no digest set is pinned to the state the update reads for
itself, which is the same guarantee one step later. The UI reports the refusal, re-reads the state and asks again.

### Retained backups

A confirmed replacement moves the directory it is about to replace to a unique `<name>.bak` path beside the skills
directory — never inside it, so a backup is never scanned as an installation — before publishing the new one. It is a
rename, so the replaced content is never copied and never partially written. A name already in use is stepped over
(`<name>.1.bak`, `<name>.2.bak`, …) rather than overwritten, so a later replacement never destroys an earlier
backup. If the publish rename then fails, the backup is moved back, so a failed replacement never leaves the
destination missing.

**Replacing one directory is one serialized section.** The destination is re-read, moved aside and published while a
lock is held for that canonical destination: in-process for the local host (shared across every server instance in the
process, so two workspaces of one host and account cannot race), and an exclusive `fcntl.flock` on a sidecar guard for
the SSH helper, so two helper processes cannot. Staging happens outside the lock, so a large upload never blocks another
replacement, and a second replacement of the same directory finds the first one already published and is refused with
`conflict` rather than moving it aside a second time. That is what keeps the outcome deterministic: one winner, no
orphaned or stepped-over backup, and no destination left missing.

There is no pruning, restore or delete: the retained directories belong to the operator, and the update response names
the one it kept. A confirmed overwrite is the only thing that creates one.

## The execution target

An installation names where it belongs. `workspaceId` selects a configured execution workspace directly, which is how
the builtin Skills panel installs without an active conversation; `conversationId` selects the workspace that
conversation is bound to, which is how an installation still asks exactly one conversation to adopt the result. When
both are given they must name the same workspace, and a mismatch is refused with `conflict` (409) before anything
is published rather than reloading a conversation bound somewhere else. A conversation bound to no workspace at all
is such a mismatch: it has nothing to adopt into, so pairing it with a named workspace is refused instead of
installing and then asking it to adopt. The builtin panel names the session's conversation only for the workspace
that conversation runs on; any other target is an independent installation and names none. `GET /api/skill-market/inventory?workspaceId=` answers what one execution
workspace holds: every skill its own resource discovery finds, joined with the scope lock entry recorded for its
directory and with the repository's newest version of that bundle. Repository revision and install-time baseline are
reported as two separate questions, so "a newer version exists" and "the user edited this" are never conflated, and a
skill with no recorded provenance is neither "up to date" nor "missing". An unreachable host answers
`unreachable_host` instead of an empty list, with its message bounded to one line before it is rendered, and a skill
is reported by its real install directory — the frontmatter `name` is a display name that need not match it. The
repository's own version list is the only ordering source, ordered by the `semver` library and only when every
listed version passes it — a prerelease such as `1.0.0-beta.10` is newer than `1.0.0-beta.2`, which a string
comparison gets backwards. A version the library rejects, or an installation whose provenance is a curated GitHub
source rather than this repository, is "not compared with the repository", never a revision named without
justification: a repository bundle that merely shares a directory name is a different artifact from a GitHub
installation of that name.

## The two sources: the harness library and the skills.sh catalog

The Add pane offers two sources in one flow, and neither is an installation destination. The **harness library** is the
repository's own content: `GET /api/skill-market/skills` lists curated GitHub sources and stored bundles, and a
rectangular card is installed directly. The **skills.sh public catalog** is queried with `GET
/api/skill-market/search?q=`; the query goes through the repository's own injectable fetch, so a controlled transport
covers it and no download ever runs in the Web or backend process.

A catalog row names a repository and a skill id, never content. **Field mapping is from the reference implementations,
not assumed**: `owner/repo` comes from the row's `source`, the skill id from `skillId` (falling back to `name`), and
the listing metadata (`query`, `searchType`, `count`, `duration_ms`) is not read at all — see cc-switch
`services/skill.rs` `SkillsShApiResponse` / `SkillsShApiSkill` in the vendor snapshot. A row whose `source` is not a
GitHub coordinate is not offered.

Each row is resolved before it is offered: the repository's **own default branch** is read (`master` is a default
branch too, so it is never assumed to be `main`), the commit that branch points at is resolved (`commit.sha` is a
commit, not a tree; GitHub's `git/trees` endpoint accepts it), and the repo tree at that commit is searched for the
hit's SKILL.md. Path resolution is *authoritative first*: the directory whose last segment is the skill id and which
holds its own SKILL.md wins. **A repository that cannot say which branch is its default is reported as unreadable, and
`main` is never read on its behalf** — that would be a guess about the user's selection. Two matching documents are
**ambiguous and resolve to nothing**: this module never picks one by tree order.

**No fallback may manufacture a result.** When no directory is named for the hit, every skill document in the
repository is read — the root one on equal footing, never privileged — and exactly one document declaring the
requested name is the hit. Two declarations are `ambiguous` and resolve to nothing rather than the root being picked
for coming first; a repository whose documents declare something else is `no-document`, so an unrelated root skill is
never handed over under the requested name. The repository's own name is a fact about the catalog row, not about any
document, and is not treated as evidence for the root (the skills.sh API exposes no path, so a repository name is all
it could be). When the repository holds more documents than one query may read (25) a unique match among the ones it
read proves nothing about the ones it did not — that hit is reported as `unbounded`, never offered. A document is a file called exactly `SKILL.md`
(`MYSKILL.md` merely ends in the same letters), and the reason words stay distinct because each is a different fact.

The offered id carries that repository, commit and exact document path —
`skills-sh:<owner>/<repo>@<commit>:<path>`. **The pin lives in the selection, not in a cache**: `preview` parses a
pinned id and reads it without calling `list()` at all, so a list refresh, the five-minute catalog/TTL expiry, a branch
that has since moved or a **backend restart** cannot invalidate or retarget a commit the user was shown. (The legacy
curated id `<source>:<directory>` still resolves through the curated listing for compatibility, and its preview
reports the commit that listing read — which is the commit an installation records, so the *installation* is still
pinned; what a legacy id cannot promise is that two previews minutes apart name the same commit, which is exactly what
a pinned search id exists for.) Installation then runs through the ordinary path (both sources' complete content goes
through the connected execution-side install/feedback route), and the lock records `sourceType: "github"`,
`source: "github:<name>@<commit>"` and `ref: <commit>` — an immutable revision, never a floating branch. Because a
catalog installation is pinned to a commit rather than to this repository's version list, its revision state stays
"not compared with the repository", and an existing curated/GitHub installation is still recognised by its provenance
instead of being read as uninstalled. An installation's directory remains the slug derived from the bundle/document
name; the frontmatter display name is shown separately and never decides the destination (ticket 04's annotation).

**Failure isolation and misses.** `unavailable` is structured data — `{ source, reason }` with `reason` one of
`unreadable` | `no-document` | `ambiguous` | `unbounded` | `not-github` — so the UI localizes a reason word instead of parsing
prose, and an unknown reason is dropped rather than rendered as a sentence that may be untrue. Misses are keyed per
hit/repository, so **one unreadable repository, one ambiguous directory, one over-large repository and one
non-installable row never empty the
answer**: the readable hits beside them are still offered. Only a query that returned nothing *and* has a miss is that
source's failure; a query with hits is ready even when rows were dropped, and an idle box is not an empty catalog. A
catalog that cannot be read at all answers `unavailable: [{ source: "skills.sh", reason: "unreadable" }]`. The two
sources are rendered as separate labelled blocks with independent idle / loading / empty / ready / failed states, so a
failing catalog leaves the harness library usable. Browsing either source needs no active conversation, and the
installation still names an explicit execution target. The harness remains a **source**, not a third installation
target and not model-invoked content. No `npx` or script execution is involved anywhere: a catalog row is fetched with
plain HTTPS through the injected `MarketFetch`.

## Installation and adoption are separate outcomes

`POST /api/skill-market/install` answers with both:

```json
{
  "installed": { "name": "pdf", "version": "1.0.0", "scope": "global", "path": "…", "files": ["SKILL.md", "…"], "contentHash": "…" },
  "reload": { "ok": false, "error": "execution-side resource … has malformed frontmatter" }
}
```

The Reload is the existing `reloadResources` path for the **initiating conversation only**. A failed adoption retains
the previous prefix and catalog, reports its error, and never rolls back the published files. Other conversations are
not touched. A published installation with a failed Reload answers HTTP 200 with `reload.ok === false`. When no
conversation was named there is nothing to reload, so `reload` is absent: the response never fabricates a success or
a failure for an adoption that was never asked for.

The panels keep that distinction. Settings › Skills reports an installation's own outcome beside the `reload` the
Backend answered, and a skill switch that adopted nothing still reports the document change it made. Settings › Agents
and Settings › General do not send a reload at all: they ask the conversation they were opened for to re-read its
resources through the connection's `refreshes` (`hold`/`release`/`refresh`), and report what that read established.
A definition saved while no chat holds that conversation answers `not_open` — the document is stored, and no reload is
claimed. A read that failed, or one the chat reported as `superseded` because another conversation came on screen, is
never shown as a successful reload.

## The SSH transport

An SSH-host installation is many helper calls for one publication — one per 32 KiB chunk of the bundle plus the
begin/commit/inspect/lock steps — so the gateway runs them over **one gateway-managed ControlMaster** instead of one
handshake per call. The master is keyed on the full connection profile (profile id, host, port, identity file and
known-hosts file) and lives in `<HEPI_GATEWAY_DATA>/ssh-control`, created at startup with mode 0700; execution
(`/v1/execute`) uses the same master, because both are the same kind of short step over the same host. The user's own
SSH configuration and masters are untouched: the explicit `-o` values and the socket passed as `-S` apply to the
gateway's own install and execution processes only, no disable option is ever passed, and nothing under `~/.ssh` is read, written or deleted. Files,
workspace management, worktrees and terminal sessions keep the plain transport. Measured on a real localhost sshd
against the same publication: **6 authentications before, 1 after**, with an execution call riding the same master
(7 → 1). See [Gateway integration](local-integration.md#ssh-prerequisites) for the directory, the key and the
shutdown behaviour, including the crash residue this feature deliberately does not sweep.

## Safety

- **No traversal.** A bundle file path is relative, contains no `..`/`.`/empty segment, no backslash, no trailing
  slash, and no nested `SKILL.md`. The repository already refuses these at publication, and the installation
  capability refuses them again before writing.
- **No escaping symlinks.** Both scope roots are resolved and confined **before** anything is written: the resolved
  `.agents/skills` must stay inside the execution account's canonical home (global) or the bound workspace's canonical
  root (workspace). A link that stays inside that root is followed; a link that leaves it is refused with
  `permission_denied`, on the local host and on the SSH host alike, so a symlinked `.agents` directory cannot redirect a
  publication, an inspection or the scope lock. The scope lock itself must be a regular file: a linked lock is refused
  rather than read or written through. A destination that exists in any form is a conflict unless the request confirmed
  replacing it; staging writes refuse to write through a symlink; the published directory is verified to be inside the
  resolved scope root and not a link. The SSH helper verifies the staged file's real path is inside the staging
  directory.
- **No arbitrary path.** The capability accepts a scope and a slug, never a destination path. A remote staging
  directory must be named `.hepi-install-*` and be a direct child of one of the two scope roots.
- **No execution.** Bundle content is written as bytes and never run. A script in a bundle is installed, not executed.
- **No replay.** A lost response, a dropped SSH connection and a timeout are reported as an unknown outcome. The
  request is never sent again, so an uncertain publication cannot become a second one. This is the existing gateway
  side-effect rule, not a new one.

## Verification

- `packages/gateway/test/install.test.ts` (23 cases) — local and controlled-SSH publication: exact bytes for a script,
  a binary and **zero-byte files**, no staging residue, global/workspace placement, conflict and symlink refusal, scope
  confinement through a linked `.agents` (refused outside, followed inside) on both hosts, five concurrent lock records
  retained per scope and across workspaces, host failures returned as results rather than rejections, inspection of
  added/deleted/linked entries, a confirmed replacement pinned to the inspected content and refused when that content
  changed, a unique retained backup per replacement, two simultaneous replacements of one destination — including across
  two server instances over one account home — settling with one winner, one retained backup and no orphaned or
  stepped-over backup, a replacement that cannot be published leaving the installed directory intact, lock round trip,
  malformed lock refusal, unreachable host and unknown outcome.
- `apps/server/test/skill-install.test.ts` (30 cases) — authenticated HTTP/SSE through the real backend, gateway and
  repository: global sharing across two workspaces, workspace placement, repository-offline discovery, install-success /
  reload-failure, traversal refusal, SSH publication and an unreachable SSH host, a bundle with **zero-byte files**
  installed byte for byte on a local and an SSH host with matching digests and no false local modification afterwards,
  an update that refuses to discard an edit made **after the status was read** — pinned to the digest set the caller saw
  — until it is confirmed against what the host actually holds, then keeps a backup of exactly what it replaced, an
  installation whose lock could not be written reported as published with a warning, a hand-made directory with no
  baseline reported as unknown and not replaced on one press, an added/deleted/linked entry each reported as a local
  modification, an update that adopts in the initiating conversation only, an update whose Reload failed reported
  separately from the replacement, and a full repository-bundle install and update against real files on a controlled
  SSH host.
- Ticket 10, dual sources: `apps/server/test/skill-market.test.ts` covers a skills.sh query offering only the hits
  that could be pinned, with each miss carrying its own reason (ambiguous directory, no document, unreadable repository,
  non-GitHub row) while the readable hits survive beside them; a `master` default branch; **a repository whose metadata
  answers 403 while `main` exists** (reported `unreadable`, never read through); **a requested name that matches only
  the repository's root, which declares something else** (reported `no-document`, never offered as the root skill); a
  root that *is* the requested skill (still offered, on a repository whose default branch is `trunk`); **a root that
  declares the requested name while a nested document declares it too** (reported `ambiguous` — the root is not
  preferred for being first); **a repository named for the requested skill whose root declares another name while a
  nested document declares the hit** (the nested document is offered and the root is not treated as proof); **a repository of
  30 documents where the second match sits past the 25-document bound** (reported `unbounded`, never offered);
  `MYSKILL.md`/`NOTSKILL.md` (not documents at all, so the requested name is `no-document`); and the readable hit
  surviving beside every one of those; the pin carried in the offered
  id; the whole subtree a pinned id previews at its commit; a path that would leave the repository refused; the query
  cache; a pinned selection resolving at the **moved branch's old commit** and again after a **backend restart** while a
  fresh query pins the new commit (proving the movement is real); a **legacy curated id** resolving through the listing
  with its stated limit; a pinned id previewing even when branch resolution fails; and an unreadable catalog reported as
  `{ source: "skills.sh", reason: "unreadable" }` rather than as an empty result. `apps/server/test/skill-install.test.ts` installs a pinned hit onto a real local gateway: the bundle
  bytes land in the execution account, the lock records the commit as `ref`/`source` with no bundle version, and two
  consecutive inventories are identical with the baseline unchanged, and the same pinned id installed again after a
  list refresh, a branch movement and a restart keeps the commit, the bytes and the lock `ref`. `packages/ui/src/lib/skill-inventory.test.mjs` pins the
  per-source `sourceState`/`catalogState` decisions (loading / empty / ready / failed, never an empty source reported as
  a failure, and hits surviving dropped rows) plus the `searchMisses` parsing (unknown reasons dropped, never rendered),
  and `SkillsConfig.dormancy.test.mjs` pins that both source keys and all state words come from the locale files.
- `apps/server/scripts/skills-ui-smoke.ts` covers the browser path on both transports with a controlled catalog: two
  labelled source blocks, the un-queried catalog saying so instead of claiming no match, an unreadable catalog named as
  that source's failure while the library still lists its own bundle, an empty catalog answer as no match, a mixed query
  where a readable hit survives beside an unreadable repository and a non-GitHub row each named with its own localized
  reason, a catalog hit naming its pinned commit, and that hit installed through the execution-side path with the commit
  recorded as provenance.
- `packages/ui/src/components/SkillsRetirement.test.mjs` (ticket 14) — the retired modules are absent, nothing mounts or imports them, the one entry point is the built-in panel, and the market namespace plus the execution-side lock and stored bundles are untouched. The update-confirmation behaviour the removed `components/SkillMarketPanel.test.mjs` asserted (one press for an unchanged installation, a named state and a second confirmation for a locally modified or unmanaged one) is still covered by `apps/server/test/skill-install.test.ts` and the built-in smoke's `Replace anyway` step.

## Limitations

- No live SSH host was authorized; SSH verification uses the controlled transport fixture
  (`packages/gateway/test/ssh-transport.ts`), which runs the real Python helper locally with a generated
  `sitecustomize` account. A real-host smoke test remains unrun.
- A retained backup is kept on the host but is not listed, restored or deleted anywhere: cc-switch's
  `SkillBackupEntry` / `restore_skill_backup` API has no counterpart here, and no pruning or GC is implemented. What
  exists is the retained `<name>.bak` directory and its path in the update response.
- The update is driven from the bundle preview, not from a list of installed skills: the state check happens when the
  user opens the bundle they intend to install. A per-skill management list is not part of this work. (Ticket 04's
  retained panel does manage installed skills; that list is the execution host's own discovery, not this one.)
- A catalog hit is pinned by resolving the repository's default branch and one commit; the hit is then read at that
  commit. A repository whose default branch moves between the query and a later installation is not re-pinned — the
  offered id keeps the commit the user was shown, so the installation is the content that was previewed, not the
  branch's latest state. The catalog's own "latest version" concept is not used: the commit is the revision, and a
  catalog installation is never compared with this repository's version list.
- Enumeration of a pinned bundle's *files* still reads the tree at the pinned commit (that is what "the whole subtree"
  requires), so an unreachable GitHub still fails a pinned preview with a source error; what cannot happen is the
  *commit* being re-decided. A pinned preview therefore survives a branch resolution that fails, which is asserted.
- A legacy curated id's revision is stable within one listing's cache window, not beyond it; only a pinned search id
  carries its commit. Both are supported, and the distinction is deliberate rather than incidental.
- A catalog hit's repository must name its own default branch. Repositories that do not (or whose metadata is hidden
  from an unauthenticated request) are reported `unreadable` rather than read at `main`, so they are not searchable
  until skills.sh supplies a resolvable source or a curated `MarketSource` with an explicit branch is configured.
- Catalog search requires the skills.sh API to be reachable from the backend process. There is no bundled catalog
  snapshot and no fallback to `npx skills find`; a catalog that cannot be read is reported as a failed source.
- A catalog hit in a repository with more than 25 documents is offered only when it matched authoritatively (a
  directory named for it, or a root document that is it). One that would need a frontmatter lookup is reported
  `unbounded` rather than offered, and there is no way to raise that bound from the UI: correctness was chosen over
  reach here, because the alternative is offering a skill that a document the query never read could contradict.
- The local host's per-destination lock is in-process and shared across every server instance in one gateway process.
  Two separate gateway processes writing the same scope are not coordinated by a lock: the rename still refuses the
  loser, which reads as `conflict` with no backup taken. The SSH host does take a cross-process `fcntl.flock`, because
  every helper invocation is its own process.
- Ticket 04's follow-up (context shadow computed in `filesystem.ts` / `ssh-filesystem.ts`) is untouched here: this
  ticket adds a separate module and narrow dispatch hooks rather than changing the loader's shadow handling.
- The multiplexing master is **not** applied to the filesystem, workspace, worktree or terminal transports, so a remote
  file read still pays a handshake per helper run until the persistent-session work lands; the master is also not
  layered under that session, because one capability gets one reuse mechanism.
