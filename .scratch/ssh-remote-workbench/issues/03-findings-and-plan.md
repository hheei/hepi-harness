# 03 — findings and plan (measured, not assumed)

Status: research/preparation, no contract change made yet
Base: `impl/ssh-workbench-03` from `impl/ssh-workbench-02` @ `6b9341e` (ticket 02 work, unmerged)

## Why this file exists

Ticket 03's text says "verify existing Web workbench adapter … **without protocol changes**". Measured at the
browser seam, that premise is false: three of the four operations answer the browser a *capability* refusal for
what are a lost transport, a failed host command and a plain missing file. The acceptance line "offline/error
states remain actionable" therefore cannot be met by verification alone. This file states what was measured, the
one decision that is not mine to make, and the plan that follows from the answer.

## How it was measured

`probe/ssh-ingress-journey.test.ts` (this directory) composes the **real client ingress + real Backend + two real
gateways**, one local and one SSH, where the SSH gateway **mounts** `sshWorkbench` over the in-process host of
`packages/gateway/test/ssh-fake.ts` plus real git on a temporary tree. `packages/gateway/test/ingress-files.test.ts`
has the same shape but deliberately mounts **no** workbench on its SSH gateway, so the remote workbench journey had
never been asked at that seam. Run with:

    cp .scratch/ssh-remote-workbench/probe/ssh-ingress-journey.test.ts packages/gateway/test/
    cd packages/gateway && timeout -k 5 200 node --test --test-timeout=20000 test/ssh-ingress-journey.test.ts

Its assertions are no longer only a probe: ticket 03 promoted the journey and the refusals into
`packages/gateway/test/ingress-ssh-workbench.test.ts`, which runs in the suite with the workbench mounted, so this file
is kept for the measurement it records rather than as the check itself.

(The copied file is a scratch probe, not part of the suite. Its "dead session" case blocks in `SshFilesystem.close`
afterwards, which is why the command needs a timeout; that teardown wait is worth a look during implementation.)

## Measured: the journey works where ticket 02 said it does

One tree, both hosts, through `/api/files/...`, `/api/file-index`, `/api/git/status`, `/api/git/diff` — identical:

| browser request | answer (local = remote) |
| --- | --- |
| `?type=list` | 200 `{entries:[{name,isDir},…]}` |
| `?type=read` text | 200 `{content,language,size,nextOffset,truncated,previewOnly}` |
| `?type=meta` | 200 `{size,language,mime,previewKind}` |
| `/api/file-index?q=app` | 200 `{matches:[{path,isDir}]}` |
| `/api/git/status` on a checkout | 200 `{isGitRepository:true, files:[{filePath,status:"modified",code:"M",…}]}` |
| `/api/git/diff` | 200 `{supported:true,status:"modified",patch:"diff --git …"}` |
| read/meta of a **missing** file | **501** `{code:"not_supported",error:"…composed without the workbench surface"}` |
| read of a directory | 404 `not a regular file in this workspace: /src` |
| meta of a directory | 200 `{size:4096,…}` |
| traversal `%2e%2e` | 400 `Not a file`; absolute `%2fetc%2fpasswd` → 403 `path_denied` |
| upload → read → conflict → overwrite | 200 `{uploaded:[…]}` / 409 `{conflicts:["fresh.txt"]}` / 200; file lands on the remote host and appears in the listing |
| `?type=download` | 200 the file's own bytes |
| `?type=watch`, `?type=preview` | 501 `{code:"unsupported",accepted:false}` — the truthful named absences |
| 21 MiB `?type=download` | 413 "a file may be at most 16777216 bytes" |

So: list, preview, changes, diff, upload and download all work on an SSH workspace with no adapter change and no new
protocol — ticket 03's headline journey is real, and ticket 02's parity work is what made `changes`/`diff` answer.

## Measured: three browser-visible defects, all at one seam

`packages/gateway/src/files-surface.ts` `workbenchRefusal()` has three branches and one catch-all:

    unknown_workspace → 404 · path_denied → 403 · everything else → 501 "this host cannot serve <what>:
    it is composed without the workbench surface"

Because of the catch-all, the browser is told *the capability does not exist* whenever the host merely failed:

1. **A host that could not answer is reported as a missing capability.** `operation_failed` (transport loss, the
   15 s host deadline, a killed git) arrives as the 501 above. The user reads "this host cannot serve a file
   listing" about a host that served it a second ago. Ticket 02 recorded exactly this ("a caller cannot tell host
   refused from host never answered"), and at the browser seam it is worse than a wording nuance: it is a false
   statement about the deployment.
2. **A lost connection is reported as a missing capability too.** `POST /api/workbench` answers
   503 `{ok:false,code:"gateway_offline"}`; `workbench()` reads the JSON body and returns
   `{ok:false,code:"gateway_offline"}`, which falls into the same catch-all. The 503's truth — offline — is replaced
   by "composed without the workbench surface". Spec risk table ("host unreachable: named `gateway_offline`/`unreachable`
   outcome, no retry loop in Web") is unmet here, not in the transport.
3. **A missing file is reported as a missing capability.** Both hosts, read *and* meta. `GatewayWorkbench` has no
   `not_found` code (`workbench/index.ts:77` maps every host error except a path escape to `operation_failed`), so
   `read notes.md` after the file was deleted says the host has no workbench. The tree keeps a listing cached 30 s
   after git plus 5 s at the surface, so a deleted file is *normal*, not exceptional — this is the common path into
   the wrong message. Confirmed with the gateway composed **with** the workbench (`PROBE missing read`) and again on
   the local host, so it is not an SSH artefact.

Corroboration from the dead-host probe: with the helper unable to start, `?type=list`/`read` answered the 501
mislabel while `?type=download` answered the honest 501 naming Python 3 — the byte route asks the filesystem, which
keeps its own reason, and only the workbench route loses it.

## One decision that is not mine

Fixing (1)–(3) needs the surface to be able to *tell the cases apart*, and today it cannot: they are one code.
Two ways out, and they differ in authority, not in effort.

- **A. Wording only (no contract change).** `operation_failed` → 500 with
  `{code:"operation_failed",error:"the host could not answer for this workspace"}`; a body carrying
  `gateway_offline` → passed through as 503. `not_supported` keeps 501 — but that requires the gateway's
  absent-surface fallback on `/v1/workbench` (`src/index.ts:646`, `?? { ok:false, code:"operation_failed" }`) to
  answer `not_supported` the way its siblings `/v1/worktrees` and `/v1/installs` already do, plus `not_supported` in
  `WORKBENCH_CODES`. That last part is already a vocabulary change, just a narrow one, and it is the only way the
  501 stays truthful.
- **B. Name the missing file (full parity of causes).** Add `not_found` to `WorkbenchResult` codes
  (`packages/protocol/src/gateway.ts:121`) and have `GatewayWorkbench` map the filesystem's `not_found` to it
  instead of `operation_failed`. Then read of a deleted file answers 404 on both hosts, which is what the byte route
  already does. Cost: it changes the public workbench DTO, which ticket 02 deliberately left alone, and it touches
  every caller that classifies the code (backend 409 mapping, surface, parity tests).

Ticket 02's own words are "keep the existing protocol; map the differences" and its recorded limit says the UI
question "belongs here with an actionable wording". So **A is inside ticket 03's text; B is not.** I have implemented
neither yet because B reopens a decision the parent already made once, and doing it silently would be the wrong kind
of initiative. Recommendation: **A now, B as its own ticket** — A removes both false statements (missing capability,
lost connection) and B only sharpens the third (missing file), which A can also phrase honestly
("the host could not answer for this workspace", which is true whether the file vanished or the session died).

## Plan for the rest of ticket 03 (implementation, once the decision above lands)

1. Surface: replace the catch-all (three-way: `not_supported` → 501, `gateway_offline` → 503, `operation_failed` →
   500), gateway absent-surface fallback → `not_supported`, `WORKBENCH_CODES` += `not_supported`. Tests at
   `packages/gateway/test/ingress-files.test.ts` + `files-surface` unit seam; extend the probe into a real
   acceptance matrix in `ssh-workbench.test.ts`'s composed-server style (the no-surface case moves from "501 for
   everything" to "501 named `not_supported` for the absent surface, 500 for a failed read").
2. Web/UI honesty: `FileExplorer.tsx:789` swallows a failed `/api/git/status` into `setGitFiles([])` — the changes
   panel says "no changes" for a host that failed. Needs the same treatment the listing already gets (`loadError`).
   `FileViewer` already surfaces `WorkbenchRequestError.message`, so step 1 makes the wording correct there for free.
3. DOCX: the spec's premise "existing browser rendering" is **not true** — `mammoth` is a declared dependency of
   `packages/ui` and `apps/web` that **no source file imports** (grepped: only package.json and the lockfile), and
   `FileViewer.tsx:733` hard-codes `files.docxPreviewUnavailable` for any non-PDF document. `?type=preview` answers
   501 and nothing calls it. The bytes route already serves a DOCX whole (`?type=download`, bounded 16 MiB,
   413 past it) and `byteServedMime` already gives the right MIME, so the renderer plus the `DOCX_PREVIEW_MAX_BYTES`
   (10 MiB) bound is *feature* work in `packages/ui`, not an SSH acceptance item. Per the review policy I am not
   doing it under "verify the adapter".
4. Browser journey: extend `apps/web/e2e/files-transfer.mjs` (or a sibling) with a remote workspace: list → preview
   → status → diff → upload → download → the offline state, asserting the *named* messages. No boundary-bypass probe;
   the traversal/absolute cases above are the existing refusals, asserted as the surface's answers.
5. Live watch stays the 501 it already answers, and `WatchState` already says so in the header — acceptance is
   "no UI implies it works", which holds today.

## Costs already paid / left

- The probe file's dead-session fixture hangs in `SshFilesystem.close()` after the run. Reproduced with
  `startup: { stderr: "python3: not found", exitCode: 255 }`. Whether a close on a session that never started
  should be bounded is a separate small question; do not add it to ticket 03's diff without a reason.
- `?type=download` on a missing file answers 404 with the host's raw message
  ("ENOENT: no such file or directory, lstat '/tmp/…/nope.txt'"), so the absolute host path reaches the browser.
  Same on both hosts. Out of ticket 03's scope, recorded here so it is not lost.

## Resolved by the delivered ticket, against this note written before it

- The host-path leak above **was** taken in: `hostFailure` (`packages/gateway/src/file-transfer.ts:246`) keeps the host's
  code and status and re-words the message about the path the caller named, and drops the `path` field, so a missing file
  answers `no such file in this workspace: /gone.md` on both hosts. `file-transfer.test.ts` compares answer **bodies**, not
  just statuses, so the two hosts cannot drift back apart. That was scope growth beyond "verify without protocol changes"
  and it was the right call — the note's "out of scope" was a measurement of the plan, not of the delivery.
- Ticket 02 was "unmerged" when this file was written; it integrated at `94e62b1` and this work at `7807c46`.
