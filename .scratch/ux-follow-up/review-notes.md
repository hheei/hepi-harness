# UX follow-up review notes

Review policy: [docs/agents/review-policy.md](../../docs/agents/review-policy.md) (parent commit `7262f85`). Recorded findings are
non-blocking: no patch, no regression test, no new abstraction, no approval gate. Revisit only on a real incident, new evidence of
material impact, or explicit user prioritisation.

## Ticket 08

No `fix` finding. The primary normal flows were re-verified on `2aab405` (typechecks 6/6; protocol 15, session 3, gateway 62,
server 105, client 9; web lib 56; browser `ux-new-project` 49 checks plus `ux-visible-turns`, `ux-terminal-close`,
`ux-token-footer`).

| # | Finding | Trigger and impact | Disposition | Revisit if |
| --- | --- | --- | --- | --- |
| 1 | Duplicate-folder detection in `POST /api/projects` compares roots as exact strings (`new Set(requested.map(folder => folder.root))`). | Two spellings of one directory (trailing slash, a symlinked parent) would record two folders and two workspaces. Contrived today: the dialog only submits paths taken from the host's own browse listing, which the gateway canonicalizes. | `record` | A path can ever be typed by hand. |
| 2 | A folder registered before a later folder in the same request fails stays registered on the gateway (no project recorded). | It is an existing directory of that host, not a grant (ADR 0003), so there is no user-visible effect. | `record` | Folder registration ever becomes a permission rather than an address. |
| 3 | A project on a host the calling Web origin does not serve is listed with `hostError` rather than omitted from `GET /api/projects`. | A Web origin without `HEPI_WEB_LOCAL_GATEWAY_ID` therefore sees every project marked unserved. That is the agreed explicit-configuration behaviour (409 `configuration_required` on host-scoped routes), not a defect. | `record` | Operators report it as confusion rather than an error. |

## CWD routing (bug 514, `fix/workspace-routing-514`)

Reproduced against the live deployment read-only and in the deterministic browser fixture; the two reported messages are
gone and the workspace surfaces are no longer asked about a cwd that names none. Recorded, not patched:

| # | Finding | Trigger and impact | Disposition | Revisit if |
| --- | --- | --- | --- | --- |
| 1 | `/api/project-trust` is not implemented by the durable adapter for **any** cwd (`501 "This capability is not connected to the durable server yet"`), including a workspace cwd. | The shell probes it whenever a workspace cwd is selected and only `console.error`s the answer, so nothing is shown to the user; the trust dialog itself is unreachable because there is no project config to trust in this runtime. Confirmed on the live deployment for `/workspace/integration`. | `record` | Project trust is ever given a real answer, or the probe starts surfacing to the UI. |
| 2 | A conversation with **no execution workspace** cannot hold a turn when the deployment loads workspace resources: `POST /api/conversations/:id/messages` answers `500`. `resourceEnvironment` resolves no binding, `discoverOrFail` fails on an undefined environment, and the run is rejected. | The routing fix keeps such a conversation listed, openable and free of workspace-API noise, but its composer cannot submit. The live deployment has one such conversation (`id 1`, recorded before any workspace was bound). | `record` | The user needs to keep using a legacy unbound conversation, or an unbound conversation is created again. |
| 3 | `/api/app-update` and `POST /api/sessions/ui-state` answer `501` and are called on every page load. | Unimplemented capabilities that name no cwd; the UI treats a failed answer as "no update" / "no server state". Unrelated to cwd routing and unchanged by this fix. | `record` | Sidebar ordering or the update banner is expected to persist. |

Correction to finding 2 (recorded while diagnosing the sidebar's own report): the live conversation it names as
`id 1`, "recorded before any workspace was bound", is **not** a legacy unbound conversation. Id 1 is
`ROOT_CONVERSATION_ID`, the runtime's root conversation, which `harness.root()` creates at startup and which the
backend used to project into the catalogue like any other conversation — so it appeared in the sidebar as a group
named after the `/durable` sentinel, with the id as its row title. It is a framework record and is no longer
attached, so it is in no catalogue, no search result and no conversation route. The finding's substance still holds
for a conversation a client creates with no workspace (`apps/server/test/workspace-resources.test.ts` now creates
one instead of borrowing the framework record).

## Shown root (bug 514 follow-up, `fix/workspace-routing-514`)

The second report on the same branch: a Project whose folder is an ordinary home directory (the reported case) was shown
as `/workspace/<uuid>` in the sidebar and the shell. Fixed at the owner — a session, a validation answer and a project
folder now each carry the folder beside the routing address, `displayPathUnder` is the one place a shown path is
derived, and FileExplorer, FileViewer, TerminalPanel and the settings panels take the folder as `displayCwd` while
their requests keep the routing cwd. Verified with `ux-workspace-routing` (project group titled by its folder, no
surface showing the routing id, a file tooltip naming the folder, the file surface still asked the routing path) and the
four other browser suites. Recorded, not patched:

| # | Finding | Trigger and impact | Disposition | Revisit if |
| --- | --- | --- | --- | --- |
| 1 | A terminal tab's name comes from `activeDisplayCwd`, the folder of the project that is *currently* selected, not of the tab. | Switching projects relabels an open terminal tab. `/api/terminal` is unimplemented in this runtime (`501`), so no terminal has ever been opened here. | `record` | Terminals become usable, or the tab label is seen to be wrong. |
| 2 | The settings panels' `displayCwd` is the selected project's folder, while their `cwd` is `projectTrustCwd`; the two are the same project in the normal flow but are not proved equal. | Only reachable when the trusted cwd and the selected project diverge, which the shell does not do today. | `record` | A cwd can differ from the shown project while Settings is open. |