# One project holds many folders of one computer, and exactly one is the default

Scope: local (Web host) projects. A project's identity is its own; its folders are *locations* of that one project, and
a new conversation binds the one location the user named the default. A remote project extends the same decision to a
configured SSH host ([ADR 0005](0005-ssh-project-one-profile-explicit-owner.md)); this ADR's rules — one default, folders
as locations, a default change being additive — hold there unchanged.

Status: accepted (UX follow-up ticket 08)

## Considered options

- **One folder per project, with the project's identity derived from that folder's path.** Rejected: it is what ticket
  07 shipped, and it makes a second folder indistinguishable from a second project, so a project cannot group the
  several folders a user actually keeps a repository in.
- **Give each folder its own project row and group the rows by a common name.** Rejected: a display name is not an
  identity, and two projects may legitimately share one.
- **Store the default as a boolean on each folder row plus a partial unique index.** Workable, and the schema does
  enforce "one default per project", but the project's own row then says nothing about its default: reading a project
  costs a join plus a search, and a folder could be deleted from under the flag. A `default_folder_id` on the project
  names the default in the same row that owns the project.
- **Drop the single-folder `workspace_id`/`root` columns with `ALTER TABLE ... DROP COLUMN`.** Rejected: SQLite
  refuses to drop a UNIQUE column (`cannot drop UNIQUE column: "workspace_id"`, checked on 3.53.3), which is exactly
  what the released schema has. The column cannot be dropped, and leaving it while adding a folder table would leave
  two sources of truth.
- **Move the default when the user picks a new folder, keeping one workspace per project.** Rejected: a conversation
  binds one workspace and never changes it, so moving the workspace would silently relocate the conversations already
  in it. The new default is a *new* workspace; the old ones stay registered.
- **Inject the other folders into the prompt or open them as extra tool roots.** Rejected: the accepted scope is one
  single-root workspace per conversation. A second folder is a location, not an execution context.
- **Add a default-editing UI now.** Rejected by the ticket: the metadata contract is what this phase delivers, and the
  dialog only has to choose the default at creation. Editing the default is a later UI decision.

## Decision

- **A project has folders; one of them is the default.** `projects` holds the project's identity, its host and
  `default_folder_id`; `project_folders` holds each folder's own opaque `workspace_id` and canonical `root`. A
  conversation still binds one folder's workspace id, and a folder's workspace id never changes.
- **The reference cycle is deferred, not unenforced.** `projects.default_folder_id` references `project_folders`, and
  `project_folders.project_id` references `projects`: neither row can be inserted first under an immediate foreign key,
  so the default reference is `DEFERRABLE INITIALLY DEFERRED` and the project and its folders are written in **one
  transaction**. The constraint is then checked at commit — an unknown or missing folder cannot be committed — without
  a convention to trust and without a general pragma toggle. Membership is validated in code, because a foreign key
  proves a folder exists, not that it belongs to the project whose default it is.
- **The default is a name, not a move.** `PATCH /api/projects/:id` with `{ defaultFolderId }` names one of *that
  project's own* folders. New conversations bind it from then on; the folders existing conversations are bound to stay
  registered and resolvable. There is no `ALTER` on a workspace and no rebinding of a conversation.
- **Creating a project registers every folder first, then records the project.** Each folder is canonicalized and
  registered by the host's gateway under its own opaque id, and the metadata is written only when every folder was
  accepted, in one transaction. The host is named once for the whole request, so a project cannot combine folders of
  two computers; an existing folder twice in one request is refused.
- **One project, one group in the UI.** A project's conversations are one group named by the project, whatever folder
  each is bound to, and **every** new-session affordance of a recorded project — the header's New, a group's own "+",
  the composer's bar — binds the default folder. Without that rule the group's "+" would bind whichever folder the
  sidebar showed and quietly create a conversation outside the user's chosen default.
- **The migration is a rebuild in one transaction.** A single-folder file is brought forward by renaming the old table,
  creating the two current tables, copying each project's own `workspace_id` and `root` into one folder row, pointing the
  project at it, and dropping the old table — all inside one `BEGIN IMMEDIATE`, with foreign keys off only around that
  transaction and restored afterward. A failure rolls the whole thing back, so a file is either the old shape or the
  new one and never a half-migrated one. Ids, workspace ids and roots are preserved exactly; no conversation is
  rebound.

## Consequences

- The card of a project is one metadata row plus its folders; the default is read from the project row and validated
  against the project's own folders, so a folder of another project can never become this project's default.
- A folder's workspace id may keep serving a conversation the project's default no longer names. That is the point: a
  default change is additive, and nothing about an existing conversation moves.
- Because the two tables reference each other, ordinary creates write both in one transaction; a caller that inserts a
  project without its folders fails at commit rather than being silently accepted.
- The single-folder file format is not kept. A file from that version is migrated on open; the migration is one-way and
  the new shape is the only one the store writes.
