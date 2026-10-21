# A remote project is one SSH profile, resolved by an explicit owner map

Scope: an SSH execution host. A project's folders are all on **one** configured SSH profile, and a workspace id names a
profile and a root through one explicit map rather than by parsing the id's spelling.

Status: accepted (UX follow-up ticket 09)

## Considered options

- **Parse the profile out of the workspace id.** It is what the released code did: `workspaceId.startsWith("remote-")
  ? slice("remote-".length) : ""`, then a profile lookup — repeated in the execution gateway, the SSH filesystem and
  the SSH installation server. It works for exactly the ids a CLI generates and breaks the moment a folder gets an
  opaque id of its own: either the id has to be spelled like a profile name (coupling an opaque id to a configured
  name, and making two profiles' folders collide), or every surface needs its own second lookup path.
- **Let each surface keep its own profile map and default to the first profile.** Rejected: a request for a workspace
  that names no profile would silently run on whichever profile happened to be first, which is one computer answering
  for another.
- **Give every folder its own SSH profile record.** Rejected: a project is one computer, and a folder's transport
  (host, port, key, known-hosts) is the same for all of them. Duplicating it per folder would let two folders of one
  project disagree about which machine they are on.
- **Register a remote folder by trusting the caller's path.** Rejected: the root would then be a string this machine
  cannot check, and a typo or a path that exists only locally would be recorded as a remote root. The host itself
  canonicalizes and confirms the path.
- **Run the remote workspace helper through the file helper's confinement.** Rejected: the file helper's whole purpose
  is to confine every path to the workspace root, and choosing a root is precisely the operation that may not be
  confined to one. A small separate program keeps that confinement untouched.
- **Add a remote workbench (files, changes, diff).** Out of scope: the ticket requires browsing, choosing and
  executing; the workbench stays local and says so instead of gaining a half-built remote path.

## Decision

- **One map, owned by the registry.** `WorkspaceConfig` gains an optional `profileId`. An SSH gateway seeds one entry
  per profile under the id the CLI contract already uses (`remote-<profile>`), and every runtime registration stores
  the profile it was validated on. One exported resolver, `workspaceOwner(registry, profiles, workspaceId)`, returns
  `{ profile, profileId, root }` or `undefined`; execution, files and installation all call it and none of them
  parses an id. An id that names no entry is `unknown_workspace`, exactly as before.
- **The host validates the root.** `SshWorkspaceServer` runs one small Python 3 program over the existing
  `SshRunner` — the pattern the installation helper already uses — for `host`, `browse` and `register`. `register`
  confirms the path is an existing directory on the host and answers its canonical form; the registry records that
  canonical root with `registerResolved`, which applies the same id rules and the same conflict rule as a local
  registration. Nothing creates, renames or writes anything, and no path is ever validated against this machine's
  filesystem.
- **The workspace surface is the same route.** `/v1/workspaces` gains the additive operations `profiles` (the target
  list: id, configured host, root, and the account the host itself reports), `browse` (a read-only directory listing)
  and `profileId` on `browse`/`register`. A local gateway answers `profiles` with an empty list — "no remote target
  here" is a fact, not an error — and refuses a `profileId` it could not serve.
- **A project records its profile.** `projects.profile_id` is nullable and added with `ALTER TABLE ADD COLUMN`: a
  local project has none, an SSH project has the one profile all of its folders are on, and the ticket-08 single-folder
  rebuild is untouched. The backend validates the profile against what the gateway actually serves before recording
  anything, and re-registers every folder with that profile after a restart.
- **A remote target is chosen, not guessed.** `GET /api/hosts` lists the configured gateways and, for a remote one,
  its profiles with the real account and host — ids and names only, never a URL or a token. The New Project dialog
  offers "this computer" or one of those profiles, and forwards the chosen gateway id and profile id on browse and
  create. `HEPI_WEB_LOCAL_GATEWAY_ID` keeps meaning *this origin's local* host only.
- **Python 3 stays a hard requirement.** The remote helper needs it, exactly as the file and installation helpers do. A
  host without it reports `not_supported`; an unreachable host reports `unreachable`. Neither falls back to a local
  directory, this process's account, or another profile.

## Consequences

- A workspace id is opaque everywhere: `remote-<profile>` still resolves (the CLI contract is unchanged, including the
  refusal of a custom SSH workspace id), and a registered folder resolves through the same lookup.
- A bare SSH gateway restart is recovered by the same re-registration the local path already uses: the backend replays
  a project's folders with their profile before building that conversation's environment, so an existing conversation
  executes on the remote host again without a new conversation.
- The remote surface needs an SSH connection per browse or registration. That is the same cost the file and
  installation surfaces already pay, and it is why the target list reports an offline host as offline rather than
  caching an account.
- No remote workbench exists. The workbench route answers as it does for any gateway without one.
