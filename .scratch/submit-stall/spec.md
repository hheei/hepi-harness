# Submit stall: one resource snapshot, and a turn that shows itself

Agreed with the user. Two slices, one root cause. Root cause of the stall: **the first admission walks the execution
host one serialized round trip per file** (365-1,015 round trips, 19.8 KB, peak in flight 1 at a measured 168 ms RTT),
**before** the submission is committed, so nothing is announced and the surface shows nothing. Not the model.

## The contract

**One discovery call returns the whole resource scope set.** Context files, system and append prompts, prompt
templates, skills and every ignore file of every root — project, ancestor and account — arrive in **one**
request/response. Not one per root, not one per kind, not one per resource. One discovery is one round trip.

### Wire: one new filesystem method, `resourceSnapshot`

`packages/gateway/src/filesystem.ts`

```ts
// FileRequest.method === "resourceSnapshot"; it names no path and reads no caller-supplied location.
export type SnapshotEntry = {
  readonly name: string;
  /** Logical path the walk reached: what ignore rules are matched against. */
  readonly path: string;
  /** Canonical target of `path`, so a link is followed by its target. */
  readonly real: string;
  /** lstat kind of `path`. */
  readonly kind: string;
  /** stat kind of `real`, or "missing" for a broken link. Answers fileInfo for a symlink target. */
  readonly realKind: string;
};
export type SnapshotDirectory = { readonly path: string; readonly real: string; readonly entries: readonly SnapshotEntry[] };
export type SnapshotFile = {
  readonly path: string;
  readonly real: string;
  readonly text: string;
  /** `whole` for a file whose body matters; `frontmatter` for a `.md` under a skills root. */
  readonly read: "whole" | "frontmatter";
};
export type ResourceSnapshot = {
  readonly user: string; readonly home: string; readonly workspaceRoot: string;
  readonly roots: readonly ResourceRoot[];
  readonly contextFiles: readonly string[];
  readonly systemPromptFiles: readonly ResourceFile[];
  readonly appendSystemPromptFiles: readonly ResourceFile[];
  readonly shadowedContextFile?: string;
  readonly directories: readonly SnapshotDirectory[];
  readonly files: readonly SnapshotFile[];
};
```

`MAX_SNAPSHOT_BYTES = 16 MiB` and `MAX_SNAPSHOT_ENTRIES` bound the response. Over either bound is a clear
`FileError("invalid", ...)`; never a silent truncation, never a chunked second call. Per-file bound stays
`MAX_FILE_BYTES`, so the existing context and prompt limits are unchanged.

### Seam: the loader reads one snapshot, then walks it in memory

`ExecutionHostEnv` (`packages/gateway/src/environment.ts`, already the loader's extension of `ExecutionEnv`) gains:

```ts
resourceSnapshot(context: Context): Promise<Result<ResourceSnapshot, FileError>>;
```

`gatewayEnvironment` maps it to the single `/v1/files` request. The native pi-durable `ExecutionEnv` is untouched.
There is **no fallback**: an environment that cannot produce a snapshot is refused, exactly as one that cannot
resolve `executionHost` is refused today — an unreachable host is an error, never harness-local content (ADR 0002).

`apps/server/src/workspace-resources.ts` keeps the **one loader authority**. `discover()` becomes:

```ts
const snapshot = await snapshotOf(env, context);   // exactly one call, the only host round trip
const view = snapshotEnvironment(snapshot);        // in-memory ExecutionHostEnv over the snapshot
// the existing walk runs unchanged against `view`
```
```

`snapshotEnvironment` answers `executionHost`, `listDir`, `canonicalPath`, `readTextFile` and `fileInfo` from the
snapshot (looked up by logical **or** canonical path) and `not_supported` for everything else. So every existing
rule — `walkSkills`, `discoverPrompts`, `IgnoreRules`, `resolveEntry`, `uniqueByName`, `readSkill`, `readPrompt`,
`renderPrefix` — runs **unmodified**, and there is no second walk and no second parser. The backend issues **zero**
per-file `canonicalPath`, `listDir` or `readTextFile` calls after the snapshot.

### What each file's snapshot text is

| File | Snapshot read | Why |
| --- | --- | --- |
| Context file, system prompt, append prompt | whole | rendered into the prefix |
| Prompt template `.md` (prompts root) | whole | the body is the template `expand()` substitutes |
| Skill `.md` (skills root) | frontmatter block, or a bounded head when the file has none | the loader advertises name/description only; the body is read at `/skill:<name>` |
| `.gitignore` / `.ignore` / `.fdignore` | whole | the loader's ignore rules need the lines |

A skill body is **never** carried by the snapshot and **never** uploaded. `expand()` keeps reading it from its real
host path at command time, one read, unchanged. Supporting files are not discovered and not read, unchanged.

### Host side: the walk happens on the host, once

- **SSH** (`packages/gateway/src/ssh-filesystem.ts`): a `snapshot` mode in the existing remote helper composes the
  primitives that are already there — `resource_roots`, `context_files`, `prompt_files`,
  `find_shadowed_context_file`, `info_of`, `real_within` — into one in-process walk, and emits one JSON result. The
  account and the read authorization are resolved **inside that one run**: `#readAuthorization` and `#host` are not
  called per file any more, so the 60% of helper runs that were `host`+`discover` disappear, as does the
  `info`+`read` doubling on every content read.
- **Local** (`packages/gateway/src/filesystem.ts`): the same shape, produced in process from `executionHost`,
  `readdir`, `realpath`, `readFile`. Both producers are mechanical (list, canonicalize, read); every decision stays
  in the loader, so the two producers cannot diverge on resource semantics.

### Preserved, explicitly

Precedence and collision resolution (`uniqueByName`, upstream rank order); ignore rules including negation and
per-directory prefixes; the canonical-escape rule (a link out of its root is skipped and reported); the read-only
rule for resource locations; the atomic prefix freeze and Reload semantics (`adopted`/`candidate`/`deferredForRun`);
conversation-owned durable adoption with restart replay; failure isolation (a first-load failure is committed as
failed, blocks only that run, retries); and no shared or stale global cache — no cache is added at all.

## Slice B: the turn shows itself before the work starts

The status is gated on `view.activity !== null` — the projection's **native run** — which cannot exist before
admission. Contract:

- The moment the composer is submitted, the staged turn and a status are on screen, **before** session creation, the
  stream handshake, and discovery. The phase is `preparation` while the turn is staged and not yet dispatched.
- No early durable submit and no early generation start: nothing is sent to the backend until the existing dispatch
  point. No new run loop; the projection stays the one source of truth.
- `preparation` becomes `waiting_model` when the run actually starts, and a failure of session creation or the
  handshake states the truth instead of hanging.
- The draft is restored exactly once on a failure, and is not restored after a successful dispatch.

## TDD: the reds, before the fix

1. **Count (local gateway, `apps/server/test/workspace-resources.test.ts` or a focused sibling).** A walk over a
   fixture with 130 skills and a nested layout issues **365-1,015** gateway calls today; the test asserts **one**
   `resourceSnapshot` call and **zero** `listDir`/`canonicalPath`/`readTextFile`/`fileInfo` calls. Same adopted
   catalog, same prefix bytes, same diagnostics.
2. **SSH (real sshd, `packages/gateway/test/sshd-fixture.ts`).** Over the real transport, one discovery runs the
   helper **once** and reads the same catalog; today it is 328-716 runs, 60% of them authorization.
3. **Bounds.** A snapshot over the byte or entry bound fails with a clear error and commits a failed state; nothing
   is truncated.
4. **Behaviour preserved.** The existing `apps/server/test/workspace-resources.test.ts` and
   `apps/server/test/ssh-resources.test.ts` suites pass unchanged: precedence, duplicates, ignore rules, escaping
   links, linked-worktree shadow, trust gating, Reload, frontmatter failure.
5. **Browser (`apps/web/e2e/submit-stall.mjs`).** Four reds today: no status while the stream handshake is held, no
   status while session creation is held, frames with a live run and no status, and no status during a sustained
   hold. After slice B a status is on screen from the click, and the free-running window closes.

No sleeps, no paid calls, no network beyond localhost.

## Slices

**Slice 1 — batch discovery.** Gateway `resourceSnapshot` (local + SSH), `ExecutionHostEnv` method,
`snapshotEnvironment`, loader one-call discovery. Reds 1-4.
**Slice 2 — visible turn.** Staged turn and `preparation` status before the async steps, truthful failure, single
draft restore. Red 5.

## Limits

- No deploy, no production configuration, no restart, no paid model call.
- Concurrency in the loader is explicitly **not** the first move; the count is removed by batching, not by fan-out.
- The live per-listing cost (2.0-3.1 s) is not reproduced locally; a host-side single-process walk removes the count
  and the per-listing overhead that came from it, but this work does not claim to explain that number.
- The ~300 s idle SSE `BodyTimeoutError` teardown is separate and untouched.

---

## Slice 1 progress — delivered

Branch `impl/submit-stall-snapshot`, from the contract commit `56c9358`; the diagnosis branch `diag/submit-stall` is
preserved at the same commit. No file under `apps/web` is touched here: slice 2 belongs to the UI worker.

Commits: `e35bf9f` the seam, then the parity and scope tests below.

**Interface, as delivered.** `FileRequest.method === "resourceSnapshot"` on `/v1/files`; `ExecutionHostEnv.resourceSnapshot`
in `packages/gateway/src/environment.ts`; `ResourceSnapshot` and the producer in `packages/gateway/src/filesystem.ts`;
the remote helper's `snapshot` mode in `packages/gateway/src/ssh-filesystem.ts`; `snapshotEnvironment` and the
one-call `discover` in `apps/server/src/workspace-resources.ts`.

**Scope.** The snapshot walks the host's resource roots and reads the host's own context, system and append prompt
files. It does not walk the project: `apps/server/test/resource-snapshot.test.ts` puts an unrelated `src/deep` tree
and a `README.md` in the workspace and requires neither to appear, and requires every directory and file it does
carry to be below a root or to be one of the host's own resource files.

**Bounds.** `MAX_SNAPSHOT_BYTES` 16 MiB, `MAX_SNAPSHOT_ENTRIES` 20,000, per-file `MAX_FILE_BYTES` unchanged. Over a
bound is a clear `FileError`; no truncation, no second call, no chunking.

**Parity.** The loader's walk is unchanged and runs over the snapshot, so parity is asserted two ways. Against the
filesystem: the snapshot must hold exactly the directories, entries and file texts that a direct per-file walk of the
same roots reads. Across producers: the local gateway's snapshot and the SSH helper's snapshot of the same host must be
deep-equal, field by field, except `mtimeMs` — Node and Python round the same nanosecond timestamp differently in the
last bits of the double, and no loader decision reads it.

**No remote per-file read after the snapshot.** Two tests require it: the counting test asserts one
`resourceSnapshot` and zero `listDir`/`canonicalPath`/`readTextFile`/`fileInfo`/`exists` calls over the real gateway
HTTP and the real adapter, at 40 skills and at 200; and a walk over a host with a nested skill, a loose skill, an
ignore file, an in-root link and an escaping link asserts the same zero.

**A producer bug the parity test found.** Keying the emitted files by canonical target as well as logical path let an
alias overwrite the direct name, so the payload lost a path the walk had reached. Files are now keyed by the logical
path the walk reached, one entry per name, which is what the loader reads.

**Counts.** Local gateway: 292 per-file requests to 1 snapshot request (40 nested skills); 365 round trips and 61.3 s
serialized to 1 round trip and 168 ms at the modelled 168 ms RTT (130 flat skills). SSH: 716 helper runs, 430 of them
authorization, to 1 helper run and 0 authorization runs.

**Review fixes at the reviewed revision.** Four findings, each with a deterministic test:

- *Unreadable directory or file inside an ignored or supporting tree must not fail a discovery.* The producer prunes
  before it opens: `apps/server/test/resource-snapshot.test.ts` gives a skills root an ignore rule naming a subtree and
  a `chmod 0o000` directory and requires both to be absent from the snapshot and the discovery to stay `loaded`. A path
  the walk does reach and cannot read is still carried as a `SnapshotFailure` and still raised by the loader where a
  per-file walk would have raised it.
- *A declared skill directory is terminal.* The producer reads `SKILL.md` and nothing beside or below it; the same test
  file puts `reference.md`, a sibling `examples.md` and an `assets/deep.md` in one and requires none to appear, and
  the gateway suite asserts the same tree prunes identically on both producers.
- *The per-file limit covers a frontmatter read.* A `SKILL.md` over `MAX_FILE_BYTES` is carried as a failure, and the
  discovery fails where a per-file read fails, instead of being advertised from a truncated head.
- *The byte bound is measured on the serialized response.* The producer counts each value as the JSON it becomes,
  including metadata and escaping, and measures the whole response once before returning it. The test bisects the
  boundary with two prompt templates and requires the largest accepted response to be a serialized reply within 4 KiB
  under the bound, so a check measuring something smaller or reserving headroom fails.
- *Pruning happens before a read, on both producers alike.* An ignored file or subtree is never read, transmitted or
  counted, and a directory declaring `SKILL.md` contributes that declaration alone.
- *Both producers read one gitignore grammar.* The SSH helper matches with a Python port of the `node-ignore` 7.0.5
  engine the loader and the local producer already use, so there is no pattern shape the helper reads differently and
  no fallback that turns pruning off: `packages/gateway/test/ignore-parity.test.ts` requires every decision the two
  engines make over a generated corpus to agree, and the real-sshd suite requires the two producers to return the same
  snapshot. The earlier fallback was rejected because it made an ordinary `!keep.md` or `**/generated/**` turn a valid
  catalog into a failed discovery, and let the hosts disagree about which files exist.

**Checks at the delivered revision.** `pnpm -r test` all green: `apps/server` 244/244, `packages/gateway`
140/140, and the smaller packages 9/9, 47/47, 3/3. `apps/server/test/resource-snapshot.test.ts` 12/12,
`packages/gateway/test/resource-snapshot.test.ts` 9/9 (including the real-sshd fixture),
`packages/gateway/test/ignore-parity.test.ts` 1/1 over 35,882 decisions, `pnpm -r typecheck` clean,
`pnpm verify --profile=fast` PASS/PASS at revision `abc5981` on a clean tree (`ok: true` in the run's
`verify.json`). The reds are reproducible with `bash .scratch/submit-stall/red-proofs.sh`, one log per fix under
`.scratch/submit-stall/red/`; `.scratch/submit-stall/ignore-engine-reds.mjs` degrades the helper's ignore engine one
capability at a time and reports that the parity test catches all five mutations.

---

## Integrated record

Both slices are merged into `integration/chat-lifecycle`. The reviewed revision of the resources slice is
`9060e17` (review 92, both axes clear, no material finding); the branch tip `a715a0a` carries that revision plus
the license attribution and documentation the same review asked for, and it is what was merged. The UI slice is
`7a71932` (review 91 clear).

| Step | Revision |
| --- | --- |
| Base | `44c485f` |
| `merge(resources)` | `3a571cb` — `44c485f` + `a715a0a` |
| `merge(web)` | `0f9f5ab` — `3a571cb` + `7a71932` |
| Documentation and spec record | this commit |

Both merges were conflict-free; the probe merge before them (`probe/submit-stall-merge` = `a658916`) had already
shown the same, and no unrelated change was taken.

### Validation at the integrated revision

| Command | Exit | Result | Log |
| --- | --- | --- | --- |
| `pnpm verify --profile=fast` | 0 | typecheck PASS, workspace tests PASS, `sha 0f9f5ab`, clean tree, `ok: true` | `.dev/verify/2026-10-13T12-06-56-855-verify-fast/` |
| `pnpm verify --profile=fast`, re-run at the documentation revision `db8f2d5` | 0 | PASS/PASS, clean tree, `ok: true` | `.dev/verify/2026-10-13T12-14-16-593-verify-fast/` |
| `pnpm --filter @hepi/web build` | 0 | `Compiled successfully`, 3 static pages | `/tmp/int-web-build.log` |
| `node apps/web/e2e/submit-stall.mjs` | 0 | **55 checks, 0 failures** — the reported symptom's own scenes, real Next build, real backend, held barriers, no sleeps, no paid call | `/tmp/int-submit-stall.log` |
| `node apps/web/e2e/ux-submission-recovery.mjs` | 0 | **31 checks, 0 failures** | `/tmp/int-recovery.log` |
| `node --test` on the four resource suites | 0 | 45/45 — server snapshot 12, server workspace resources, gateway snapshot 9 (real sshd), ignore parity 1 | targeted rerun |
| `pnpm --filter @hepi/client build` + `smoke:pack` | 0 | 6 checks; the packed bundle carries the ported engine's copyright. Not rerun here: `packages/client`, `packages/gateway/src/ssh-filesystem.ts` and `node-ignore.LICENSE` are byte-identical to `abc5981`, where it was run | `abc5981` |

The fast profile already runs the real-sshd snapshot case, the ignore parity case and the prune-before-read cases —
they are in the workspace test run the profile logs — so they were rerun only as a targeted set, not through a
separate suite.

`~/.local/bin/graphify update .` rebuilt the graph at `0f9f5ab` (9,868 nodes, 19,781 edges, 448 communities).
`graphify-out/` is git-ignored by this project (.gitignore:17), so the generated graph is a local artifact and is
deliberately not committed.

### What is not claimed

- **No deployment.** Nothing was built for a host, published or restarted, and no production latency was measured
  after the fix. The reported sustained multi-second stall is neither reproduced nor claimed fixed.
- **The ~300 s idle SSE `BodyTimeoutError` teardown is untouched.** It is a separate finding recorded in
  `diagnosis.md`; neither slice changes the stream's idle behaviour.
- **No paid model call.** Every browser scene holds a local endpoint at a named barrier, so a held state is a real
  in-flight request rather than a sleep.

