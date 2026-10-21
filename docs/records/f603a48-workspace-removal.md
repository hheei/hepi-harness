# Removing the deployment-configured default workspace and its six sessions

**Tested revision and date:** `f603a48` (`f603a4853345728e72d8418fd6c79df2c7bb03ba`), **2026-10-13**, on the running
split deployment. No new revision was built or deployed: this is a configuration change plus six conversation
removals through the existing API. Hosts are named by role (`runtime host`, `client host`) and roots by placeholder
(`<runtime-root>`, `<client-root>`, `<client-home>`); the real mapping lives in the operator's git-ignored private
config. This record names roles, ids, tags, hashes and counts only — no host name or address, no login account, no
credential value or credential-file path, and no personal filesystem path.

The operator authorized this removal: the six conversations and the `/workspace/integration` grouping were not
wanted. The previous record ([the f603a48 deployment](f603a48-deployment.md)) left that grouping in place and asked
for a decision; this is the decision, and it makes that section a point-in-time record.

## What was targeted, re-inspected before any write

| Conversation | Bound workspace | Bound gateway | Busy |
| --- | --- | --- | --- |
| `8`, `60`, `77`, `90`, `159`, `3140` | `integration` | `workstation` | no |

Re-inspected immediately before the mutation, read-only: the catalogue listed eleven conversations
`[8, 60, 77, 90, 159, 172, 197, 249, 655, 3140, 3154]`, each of the six named above answered
`GET /api/conversations/<id>/state` with `workspaceId: "integration"`, and the five keepers
(`172`, `197`, `249`, `655`, `3154`) were bound to project folders. Nothing else was bound to `integration`.
`GET /api/workspaces` listed `integration` with root `<client-root>/.local/share/hepi/workspace` and the four
project folders.

## Backups taken first (online, writer never stopped)

Every copy is read back, not merely written.

Runtime host, `<runtime-root>/backups/20261013T070807Z-online-f603a48-workspace-removal/`:

| File | sha256 | Verified |
| --- | --- | --- |
| `hepi.sqlite` | `47ea56d623da37bb9bce6737ac1c9a15608f6f4e45d4c5da707db12fae1a8cf0` | `integrity_check ok`; 12 conversations, 1,541 entries, 3,164 record ids, 83 documents, 89 document revisions, 23 submissions, 1,505 tasks |
| `projects.sqlite` | `62d0e09ef4c8f25d3990288babffd2c1eb5b3de461c168e3ff51b3032c0f02b8` | `integrity_check ok`; 4 projects, 4 folders, 0 retained bindings |
| `skill-repository.sqlite` | `b6594c204705c6d85922a6adc56a0e7bf9b4a9d483ebd28875dfe4402fb34ead` | `integrity_check ok`; 0 bundles, 0 bundle files |
| `env/backend.env.bak` | private copy, mode 0600 | the pre-change environment, kept in the same mode-700 tree |

Client host, `<client-root>/.local/share/hepi/backups/20261013T070815Z-online-f603a48-workspace-removal/` (mode 700):

| File | sha256 | Verified |
| --- | --- | --- |
| `calls.sqlite` | `f643ac09311e5dfa501467b4ee83ff223e59f9495f4d78d60a23b70fc66bd764` | `integrity_check ok`; 783 `gateway_call` rows |
| `env/gateway.env.bak`, `env/web.env.bak`, `env/hepi-gateway.service.bak` | private copies, mode 0600 | the pre-change environment and unit |

The three databases are byte-identical to the previous deployment's backups, so nothing had changed since that
deployment before this action.

## The six removals, through the existing API

Each removal is the backend's own `DELETE /api/conversations/<id>` — the hepi tombstone route the sidebar's
`DELETE /api/sessions/<id>` already forwards. pi-durable 1.1.0 has no conversation deletion, so the removal is
**logical**: it writes a conversation-scoped `hepi.deleted` document through the durable document path and clears
that family's own pin, archive and unread entries in the same commit. Nothing is deleted from any store.

    DELETE /api/conversations/8     -> 200 {"removed":true}
    DELETE /api/conversations/60    -> 200 {"removed":true}
    DELETE /api/conversations/77    -> 200 {"removed":true}
    DELETE /api/conversations/90    -> 200 {"removed":true}
    DELETE /api/conversations/159   -> 200 {"removed":true}
    DELETE /api/conversations/3140  -> 200 {"removed":true}

Nothing physical was removed, and the numbers say so — before → after:

| Table | Before | After |
| --- | --- | --- |
| `conversations` | 12 | 12 |
| `entries` | 1,541 | 1,541 |
| `tasks` | 1,505 | 1,505 |
| `submissions` | 23 | 23 |
| `record_ids` | 3,164 | 3,170 |
| `documents` | 83 | 89 |
| `document_revisions` | 89 | 95 |

The growth is exactly the six tombstones (`kind "hepi.deleted"`, owners `8, 60, 77, 90, 159, 3140`) plus the record
ids that commit wrote. `pragma integrity_check` is `ok`. The conversation rows are all still there
(`[1, 8, 60, 77, 90, 159, 172, 197, 249, 655, 3140, 3154]`), each removed conversation's own state still reads back
(`GET /api/conversations/8/state` → 200), and a new turn on one is refused with
`409 session_deleted`. Conversation `1` — the runtime's own root record, outside the catalogue since `96297fe` —
was not touched and was not addressed; its state route answers `404` as it did before, and its records are in the
backup.

## The deployment-configured default workspace, removed from configuration

The grouping was never Project metadata: `projects.sqlite` held 4 projects, 4 folders and 0 retained bindings, and no
project or folder named the workspace id `integration`. It came from the deployment's own environment, and it was
removed there — the owning guides are [the local split guide](../local-tailscale-deployment.md) (client host) and
[the runtime guide](../oracle-tailscale-deployment.md) (runtime host).

| Process | File | Change | Kept |
| --- | --- | --- | --- |
| backend (runtime host) | `<runtime-root>/env/backend.env` | the `HEPI_WORKSPACE_ID` line removed (12 → 11 keys, mode 0600 preserved) | auth token, bind host, port, database path, gateway id/url/token, provider, model, provider base URL and credential |
| gateway (client host) | `<client-root>/.config/hepi/gateway.env` | the `HEPI_WORKSPACE_ID` line removed (mode 0600 preserved) | gateway token, `HEPI_WORKSPACE_ROOT`, gateway id, allowed commands, port, journal path |
| Web UI (client host) | `<client-root>/.config/hepi/web.env` | **unchanged** | auth token, backend URL, `HEPI_WEB_LOCAL_GATEWAY_ID` (the host mapping projects need), gateway URL and token |

No replacement default was configured, and none is implied: the backend builds its configured-workspace list from
`HEPI_WORKSPACE_ID` and answers an **empty** list when it is absent (`apps/server/src/main.ts`), so the deployment
now serves only the four recorded project folders. The gateway's own boot seed keeps its required
`HEPI_WORKSPACE_ROOT` and falls back to its documented default id `local` for that root
(`packages/gateway/src/main.ts`), which is a registry entry the backend cannot address — no configured workspace, no
project folder and no retained binding has that id — so it is no picker entry, no default and no group.

## Restarts and the in-memory registry

Two restarts were needed, both for the configuration change, and both without a build:

- **gateway** (`hepi-gateway.service`) — restarted so the environment change takes effect. Its workspace registry is
  in memory, so a restart forgets every project folder; the service came back listening on its loopback port with the
  same root and gateway id.
- **backend** — the container was recreated from the same image (`hepi-backend:f603a48`, digest unchanged) through the
  release's own compose wrapper, `--no-build`, no compilation on the runtime host. It came back healthy with
  `RestartCount=0`.

The Web UI and the tunnel were **not** restarted.

**Dynamic projects re-registered (the prior incident checked deliberately).** The backend replays every recorded
folder's registration at its own start, and the documented repair path
(`POST /api/worktrees { operation: "list" }` per folder, which registers the binding before answering
`not_supported`) was exercised for one of them. After that:

| Check | Result |
| --- | --- |
| `GET /api/workspaces` | the four project folders, **0** `hostError`, each with the host's own account and root |
| `integration` in that list | absent |
| `POST /api/workbench { operation: "files" }` for two folders | `200`, real directory listings |
| `GET /api/projects` | the same 4 projects with the same 4 folders |

## Verification against the requested checks

| Check | Result |
| --- | --- |
| The six absent from the catalogue | `GET /api/conversations` → `[172, 197, 249, 655, 3154]` (11 → 5) |
| The six absent from the UI | `GET /api/sessions` (Web, authenticated) → the same five; the payload contains no `integration` |
| No `integration` group or fallback picker | `GET /api/workspaces` and the Web workspace list hold only the four folders; `POST /api/cwd/validate { "path": "/workspace/integration" }` → `501 unsupported` ("Only configured workspaces are available") |
| No implicit replacement default | `POST /api/default-cwd` → `{"cwd":"/durable"}`, the unbound sentinel; `/durable` validates as the chat-only cwd; each of the four project folders validates with its own `projectKey` |
| Other projects and conversations unchanged | 4 projects / 4 folders unchanged; keepers `172, 197, 249, 655, 3154` keep their own workspace ids; conversation `172` state still reads its `eb9e65c0…` binding |
| Physical root still exists | `<client-root>/.local/share/hepi/workspace` present, its contents untouched (README, `src/`, `test/`, `tsconfig.json` and the three earlier proof files) — no directory or file was deleted |
| No paid model call | the gateway journal still holds **783** rows, `integrity_check ok` |
| Durable state intact | `hepi.sqlite` `integrity_check ok`; `projects.sqlite` unchanged at 4 / 4 / 0 |

## What was deliberately not done

- **No direct SQLite write.** Every state change went through the backend's own API (the tombstones) or through the
  documented environment files and unit restart.
- **No directory or file deleted**, and no project, folder or retained-binding record written or removed.
- **No retained binding created.** It was not needed: the point of a retained binding is to keep a conversation that
  is still bound executing, and no conversation remains bound to `integration` after the six removals.
- **No code change and no guard added.** The configuration change alone produced the wanted behaviour; a code path that
  silently suppressed a configured workspace would be a hidden rule, so none was added.
- **No new deployment.** The runtime and Web artifacts are still `f603a48`.

## Failures and residual limits

Two checks from the f603a48 record still fail, and are unchanged by this action — recorded here so this result is not
read as all-green:

- `bin/verify-oracle.sh` on the runtime host: **9 passed, 1 failed** (exit 1). The failing assertion still expects
  conversation `1` in the catalogue; that expectation is stale since `96297fe`.
- `deploy:inspect --probe`: **exit 3**, failing at `field=commit` because it reads `<runtime-root>/SOURCE_COMMIT`,
  which has never existed at the deploy root (the marker lives in each `releases/<id>/`).

Residual limits of this action:

- `GET /api/home` now answers `{"home":""}`, because the Web adapter derives the home folder from the *configured*
  workspace and this deployment no longer configures one. The sidebar's `~` display therefore has no home to
  abbreviate against; nothing else consumes it.
- `POST /api/default-cwd` answers `/durable`, so a session started from "use default directory" is chat-only until a
  project folder is picked. That is the documented answer for a deployment with no configured workspace and no
  implicit default; it is the intended consequence, not a fallback.
- The gateway's boot seed now carries its own default id `local` for the workspace root. It is unreachable from the
  backend (nothing configures it, records it or retains it) and appears in no listing, picker or group.
- The shared sidebar state keeps the stale `projectOrder` key `/workspace/integration`. It only ranks keys that are
  already shown, so no group renders; the shared rules deliberately keep entries for projects that are no longer
  shown so a returning project takes its old place, and no supported request removes such a key.
- The removal is **not reversible through a supported API**: a tombstoned conversation is refused for new turns
  (`409 session_deleted`) and no route clears the tombstone. Recovering one would need a future supported operation,
  with the pre-change backup as the fallback source of truth.
- The Web unit suite was not re-run (it is outside the fast profile), and no browser session was driven against the
  sidebar for this action: the UI evidence above is the authenticated adapter payload the sidebar renders from.

## Outstanding capability gap (unchanged by this action)

A deployment-configured workspace still cannot be converted into a retained binding through any supported route: the
only writer of a retained binding is a Project or folder removal, and a configured workspace is not a Project. This
action removed the unwanted grouping because the deployment also dropped its configuration, and because the six
conversations bound to it were removed as well — so nothing needed to keep executing there. A deployment that wanted
to stop configuring a workspace while keeping its bound conversations running would still have no supported path, and
that gap is now the only blocker recorded for this area.

## Rollback

- **Configuration.** Restore `env/backend.env.bak` and `env/gateway.env.bak` from the private backups above (both
  mode 0600), then restart `hepi-gateway.service` and recreate the backend container with the release's compose
  wrapper. The configured workspace returns, and with it the `/workspace/integration` listing.
- **Conversations.** Not restorable through the API (see above); the six conversations' records are intact in
  `hepi.sqlite` and in the pre-change backup, so a future supported tombstone-retirement operation could bring them
  back.
- **Gateway.** No image or bundle changed; the service restarts from the same release.

## Guide versions left current

- `docs/local-tailscale-deployment.md` — the workspace row and the gateway environment description.
- `docs/oracle-tailscale-deployment.md` — the backend environment description and the last-recorded state.
- `docs/deployment.md` — the last-recorded-state pointer.
- `docs/README.md` — the current-deployment paragraph.
- `docs/records/f603a48-deployment.md` — the "NOT REMOVED" section now points here as superseded.
