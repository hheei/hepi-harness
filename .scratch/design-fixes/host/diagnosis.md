# design-fixes/host — diagnosis: MCP reaches the wrong Execution Host

> **Evidence location.** Every path written as `.dev/verify/...` below is a local, git-ignored run log from this
> diagnosis rather than a tracked file, so on a fresh checkout it resolves to nothing. The measurements are stated inline
> (command, exit, test counts, failing assertion), so the record does not depend on the log surviving. Dated 2026-10-14 against
> `1758c1f`; the current contract is [Chat](../../../docs/chat.md).
Scope: the P1 finding of [`design-web-review.md`](../../development-audit/design-web-review.md) §1 (also
[`design-review.md`](../../development-audit/design-review.md) P1). Owner: `hostCwdOf()` in
`apps/web/adapters/durable-api.ts`. Revision: `1758c1fb4479e9d4637a957857246c5998619d73` plus the authorized audit
dirty tree; the dirty files that matter here are `apps/web/app/api/[...path]/route.ts` (MCP dispatch) and the
untracked capability files. No commit, no stash, no reset, no deploy, no remote build, no paid inference.

## 1. The symptom, reproduced at the real seam

Reused basis: `design-web-review.md` appendix B (real `hostCwdOf` + real `mcpSurfaceApi` + controlled `fetch`).
Tightened here into a red-capable, deterministic, seconds-long loop that asserts the **ownership** symptom:

```
cd apps/web && node --test --test-reporter=tap adapters/host-cwd-ownership.test.mjs
```

`exit=1`; raw log `design-fixes/host/red-loop-baseline.log`. Exact assert symptom, first failing case:

```
not ok 1 - a folder of another gateway is refused, and this Web origin's MCP host is never asked about it
  actual:   { kind: 'folder', path: '/home/operator/project' }
  expected: { kind: 'refused' }
```

`# tests 6 / # pass 1 / # fail 5`. The five red cases are: another gateway's folder; the same absolute path on two
hosts; a gateway this origin names that reaches its folders through SSH profiles; a workspace whose host reported no
root; an origin that names no local host. The one green case is the control: remote worktrees and `cwd/validate`
still address the folder's own host.

The failure mode is the user's: selecting a conversation on another gateway/SSH profile and opening Settings › MCP
(or the project-trust read) sends **that remote root** to the fixed Web-local MCP service
(`HEPI_WEB_GATEWAY_URL`, `mcp-host.ts:36`), which reads and writes this machine's `mcp.json` and `trust.json`.
Reviewed evidence already recorded the wrong dispatch; this loop additionally pins the `refused` answer and the
"zero local host calls" assertion that a fix must produce.

## 2. One-variable probes against the ranked hypotheses

Raw log: `design-fixes/host/probe-resolver-dispatch.log`, probe
`design-fixes/host/probe-resolver-dispatch.mjs` (real `mcpSurfaceApi`, controlled `fetch`; the only
variable is the resolver handed in).

| Ranked hypothesis | Prediction | Observed | Verdict |
| --- | --- | --- | --- |
| **H1 — the resolver loses the Execution Host identity** | A `refused` answer is honoured but the resolver never produces one for a foreign folder; the remote root is passed to the local host. | Real `hostCwdOf` answers `{kind:"folder",path:"/home/operator/project"}` for `/workspace/remote` (owned by `ssh-gateway`); the local host receives `read` + `trust` with that root. | **Confirmed** |
| **H2 — the resolver is right and dispatch ignores it** | A resolver that answers `refused` still reaches the host. | `resolver=refused -> status 403 {"reason":"cwd-denied"} host calls: 0` | **Falsified** |
| **H3 — the wrong cwd is sent by the UI / the surface maps the path** | The surface maps or substitutes the host path itself, so a faithful resolver would still be bypassed. | `resolver=folder -> status 200 project.cwd: {"cwd":"/workspace/remote",...}`; the surface passes the resolver's answer through unchanged and reports back the address the browser sent. | **Falsified** |

So the defect is one place: the resolution that decides a folder's host. Dispatch (`route.ts:40`) and the surface
(`mcp-surface.ts` `folderOf`) already carry and honour the three-valued answer.

## 3. Classification: logic defect at an existing owner (Interface was sufficient)

**Interface obligations.** `hostCwdOf`'s own documented contract is *"The folder on its own host that a browser cwd
names"* and its only two callers hand the answer to the **Web-local** MCP service. The Interface already includes the
third answer: `refused` ("a path this deployment serves nothing for"). Nothing about ownership policy is missing from
the Interface a caller must know: `mcp-surface.ts`'s `folderOf` already turns `refused` into the panel's
`cwd-denied` refusal, and `route.ts` already passes the resolver in. No caller has to learn an ordering, recovery or
ownership rule.

**Owner.** The single owner is the resolution inside `durable-api.ts` — `WorkspaceEntry` (`:269`) drops the
`gatewayId` the backend sends (`apps/server/src/server.ts:1216`/`:1222`), `resolveLocation` (`:301`) keeps only
`{identity, root}`, and `hostCwdOf` (`:332`) therefore cannot tell a foreign folder from its own. The
`Location`/`HostCwd` types are internal to this adapter, so the fix is local to the owner.

**Deletion test.** Delete `hostCwdOf`/`resolveLocation` and routing-path → host-root resolution plus the
"is this root on *my* host" question reappears at every host-facing caller (MCP read/write/test/sign-in,
project-trust, and whatever reaches a host path next). The complexity does not vanish, so the module earns its keep;
the fix deepens it rather than adding a layer.

**Dependency category.** The workspace list and `GET /api/hosts` are **Remote but owned** (the backend's own reads,
with a controlled-`fetch` adapter already used by the existing suites); the ownership decision over their answers is
**In-process**. No new port is justified: there is one production adapter and one test adapter per dependency already.

**Verdict.** The existing Interface is sufficient and the Implementation violates it by discarding the ownership fact
its own dependency already reports ⇒ **logic defect at the existing owner**, fixed there. It is *not* classified as
design: no caller gains an obligation, no new seam, port, registry or host router is introduced, and the returned
answer shape stays the same three-valued union. Two facts make it slightly more than a one-field restore, and both are
still owner-internal:

- **The gateway id alone is not proof of locality.** A configured gateway may be an SSH gateway
  (`packages/gateway/src/main.ts:47`), whose folders are on a remote host; one such gateway can carry several
  profiles (`ADR 0005`). The existing capability that states this is `GET /api/hosts` → `profiles`
  (`WorkspaceServer` answers `[]`, `SshWorkspaceServer` answers its profiles). Reading that existing fact is the
  smallest way to answer "is this gateway this machine's own?", and it needs no new backend route.
- **A workspace whose host reported no root** (unreachable host ⇒ `hostError`, no `workspaceRoot`) has no path on
  any machine; sending the routing address `/workspace/<id>` would be a fabricated path.

**Recorded limit (not fixed here).** A misconfigured/unknown local binding and a genuinely foreign folder produce the
same public answer (`refused` ⇒ the surface's `cwd-denied`). Distinguishing them would need a fourth `HostCwd`
variant, which is declared in `durable-api.ts` but consumed by `mcp-surface.ts`'s `FolderResolver` — a file this
task does not own. Both answers are truthful ("this origin serves no folder it can prove is its own") and safe (no
wrong-host read or write); the distinct named failure for an unnamed/unknown host remains the backend's
`configuration_required` on the host-scoped routes. Recorded, not silently widened.

## 4. Fix at the owner

`resolveLocation` keeps the owning gateway with the folder it resolves (from the workspace entry's `gatewayId`, or
the project's `hostId` for a project folder, or `null` when the host reported no root), and `hostCwdOf` answers
`refused` unless that owner is this origin's own local gateway **and** that gateway serves no remote profiles. The
worktree, file and `cwd/validate` surfaces keep using `resolveLocation` and are unaffected: ownership is the MCP
surface's requirement, not the deployment's.

Prediction (verified in §5): the five red cases go green, the control case stays green, and
`mcp-surface.test.mjs` — whose stand-in deployment must now state the gateway ids and host profile fact a real
backend states — stays green.

## 5. Evidence after the fix

All commands run in `apps/web` at `1758c1f` **plus the authorized dirty tree** (the same revision the red loop ran
against). Node `v26.5.1`. Raw logs are beside this file.

| Command | Exit | Raw log | What it says |
| --- | --- | --- | --- |
| `node --test --test-reporter=tap adapters/host-cwd-ownership.test.mjs` | **0** | `design-fixes/host/green.log` | `# tests 8 / # pass 8 / # fail 0` — all five red cases are green; the two fail-closed cases added after the fix (a local gateway whose execution targets could not be read, and a listing that names no such gateway) are green; the retained-binding case added in review is green; and the remote-worktree/`cwd/validate` control is still green. |
| the same file with the retained marker read only where a root arrived (the pre-review order, restored afterwards) | **1** | `design-fixes/host/retained-red.log` | `not ok 7 - a retained binding stays marked when the host that owns it cannot answer`, `# pass 7 / # fail 1` — the new case fails for exactly the regression it names and passes with the fix, so it guards a real behavior rather than restating the code. |
| `node --test --test-reporter=tap $(find adapters -name '*.test.mjs' | sort)` | **0** | `design-fixes/host/adapters-all.log` | `# tests 114 / # pass 114 / # fail 0` — every existing adapter suite, including the touched `mcp-surface.test.mjs`, `durable-api.test.mjs`, `project-removal.test.mjs`, `remote-project-removal.test.mjs`, `worktree-picker.test.mjs`. |
| `npx tsc --noEmit` | **0** | `design-fixes/host/typecheck.log` | The adapter typechecks; the log is empty because the compiler printed nothing. |
| `bash .dev/verify/design-fixes/host/original-repro.sh` | **0** | `design-fixes/host/original-repro.log` | The parent's appendix B probe re-run against the fixed adapter: `resolved remote: {"kind":"refused"}`, `MCP status: 403`, `Web host calls: []`. |

Before the fix the same regression file was `# tests 6 / # pass 1 / # fail 5` (`design-fixes/host/red-loop-baseline.log`),
and `original-repro` answered `{"kind":"folder","path":"/home/operator/project"}` with two host calls (the parent's
appendix B). Nothing above is reported as passing that its log does not say.

Not run, and not claimed: the browser suites (`e2e/ux-mcp-surface.mjs`, `e2e/ux-workspace-routing.mjs`) and the
16 known Web unit failures, which stay recorded and untouched.

### Test-harness changes and why they are not weakened assertions

- `adapters/mcp-surface.test.mjs` (owned): the stand-in deployment now states the two facts a real backend states —
  each workspace's `gatewayId`, and `/api/hosts` with this origin's gateway serving no profiles — and sets
  `HEPI_WEB_LOCAL_GATEWAY_ID`; the routing adapter is loaded **after** the stand-in that states it. No assertion was
  relaxed; the same cases assert the same host calls as before.
- The parent's appendix B probe is a shell script (`bash`, then `node --input-type=module` over a heredoc), not a
  module: it is kept as `original-repro.sh` so the command in the table above is the command that was run.
- `adapters/durable-api.test.mjs` was **not** modified: its source-shape assertions pin
  `sessionWorkspace(path, projects, workspaceRoots.roots)`, so `catalogueRow`'s parameter keeps that name. This is
  the P3 recorded cost in the review, met by naming rather than by editing a test this task does not own.

## 6. Residual limits, recorded

- **A refused folder and a misconfigured origin answer the same thing.** Both reach the panel as `cwd-denied`. The
  distinction needs a fourth `HostCwd` variant consumed by `mcp-surface.ts`'s `FolderResolver` — a file this task
  does not own. Revisit if the panel must name which of the two it was; until then the backend's
  `configuration_required` on host-scoped routes remains the named failure for an unnamed/unknown host.
- **The retained marker is read for every listed workspace, including one whose host cannot answer.** The marker is
  the workspace's own fact and a conversation already bound there still resolves its display root through it, so it is
  recorded before the "no root" case is skipped — an offline host must not turn a retained binding back into an
  ordinary workspace. The exclusion of retained bindings from new-session targets never went through this set:
  `configuredWorkspaces()` filters on the entry's own `retained` marker, so that path is unaffected either way.
- **Ownership is decided per host-facing call, and the proof costs gateway round trips.** `hostCwdOf` makes one
  extra `GET /api/hosts` read, and that read is **not** backend-local metadata: the backend answers it by asking every
  configured gateway for its targets (`hostProfiles` → `hostRequest({ operation: "profiles" })`,
  `apps/server/src/server.ts:946`, fanned out over `gateways` at `:1232`). So one ownership question is one round
  trip per configured gateway, and it is the same read the New Project dialog already makes. Recorded here as a real
  cost, not as a free lookup: no scope was added to change it, and a process-lifetime memo would be the obvious next
  step if a measurement ever shows it, since `HEPI_WEB_LOCAL_GATEWAY_ID` and the configured gateways are boot-time
  facts — but that cache would be a second owner of the same fact, so it is not done here.

  The claim this change *does* assert is narrower and is the one the regression suite pins: **zero calls to the local
  MCP service** for a refused folder. A foreign folder may cost a `profiles` probe; it must never reach
  `HEPI_WEB_GATEWAY_URL`.
- **A deployment whose local gateway is an SSH gateway serves no MCP folder at all.** That is correct — an SSH
  gateway serves no MCP capability (`packages/gateway/src/main.ts:74`) — but it means such an origin reads only its
  global configuration through the (unavailable) local service. Nothing to fix here; recorded so the next reader does
  not read the refusal as a bug.
