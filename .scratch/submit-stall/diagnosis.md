# Submit stall: resource discovery transport (phase 1, measured)

Branch `diag/submit-stall`, base `44c485f` (product `f603a48`). Owned isolated local fixture; no paid call, no deploy,
no prod write. Live numbers are the parent's, at `18191656`.

## The loop (one command, already run, red-capable)

    pnpm --filter @hepi/web build
    node apps/web/e2e/submit-stall.mjs            # browser, exact reported path
    node apps/server/scripts/diag-rpc-count.ts --rtt=168 --flat --skills=130 --nodes=179
    node apps/server/scripts/diag-ssh-rpc-count.ts --flat --skills=65

`apps/web/e2e/submit-stall.mjs` drives the real composer, the real Next production build, the real backend and a
controlled local model endpoint, and records every layer on one clock (page and driver share epoch ms): click, staged
turn, status on screen, session creation, SSE acquire (request/open/connected), prompt dispatch, provider entry, first
busy frame, first token, answer, rAF gaps, and the per-conversation EventSource count. Holds are named barriers on real
in-flight requests, never sleeps.

## Red 1 (confirmed, deterministic): the surface is silent for the whole admission

Scenes 2, 5, 6, 7 hold one real step of the first-turn path and assert the user's exact symptom — no status while the
first turn's admission is in flight. The red set is identical over consecutive runs (4 failures, same names):

| Scene | Held | Staged turn | Status | Dispatch | Frames |
| --- | --- | --- | --- | --- | --- |
| 1 free-running | — | 21-25 ms | 82-98 ms | 31-38 ms | — |
| 2 | stream handshake | 14-15 ms | **never** | **never** | 60 |
| 5 | session creation | 13-15 ms | **never** | **never** | 90 |
| 7 | stream handshake, sustained | 14 ms | **never** (0 of 300 status frames) | **never** | 300 over 4997 ms |
| 6 | provider before first token | 14 ms | 50 ms | 27 ms | — |

The staged turn paints immediately; nothing else does. The status is gated by `ChatWindow.tsx:1296`
(`agentRunning && !hasStreamingContent && (agentPhase || isCompacting)`), `agentRunning` is `view.activity !== null`
(`useAgentSession.ts:408`) — the projection's **native run** — and `agentPhase` is set on `agent_start`, both of
which only arrive after admission. In scene 6 the live window between dispatch and the first status frame is **8 sampled
frames**, i.e. a real gap even when nothing is held.

Scene 4 (reload with a live run) shows status at 174 ms, so this is not a rendering fault: the second turn and the
reload both have a native run to render, the first turn does not.

## Red 2 (measured): the admission itself is a serialized host walk

Live: first admission **70,621.6 ms**, second **452.9 ms**, reload discovery **72,437.7 ms** (parent's trace).

The owning abstraction is `apps/server/src/workspace-resources.ts` `discover()`, called from
`apps/server/src/server.ts:888-890` `expandInput` → `ensureAdoptedResources` — **inside** the submit handler, before
`conversation.submit` at `:1611`. So nothing is committed and no frame is announced for the whole walk.

Counted over the real gateway RPC surface with a modelled 168 ms RTT (the measured live round trip):

| Shape | Skills | Round trips | Peak in flight | Modelled wall |
| --- | --- | --- | --- | --- |
| Nested (dir per skill) | 130 | 1,015 | **1** | 170.5 s |
| Flat (`.md` per skill) | 130 | 365 | **1** | 61.3 s |
| Flat | 65 | 175 | **1** | 29.4 s |
| Flat | 16 | ~70 | **1** | ~11.8 s |

Bytes moved for the 130-skill flat shape: **19,812 B total** (9,521 B content reads, 10,291 B canonical-path answers).
So the cost is essentially 100% latency, not data: **365 serial round trips to move 20 KB**.

Breakdown (flat, 130): `contentRead` 137, `canonical` 151, `ignoreProbe` 57, `dirListing` 19, `host` 1.
The live 72.4 s ÷ 168 ms ≈ 431 round trips is the same order as the flat shape, so the live tree is flat-ish and the
model reproduces the magnitude.

Peak in flight is **1 everywhere**: every call is awaited in sequence, so the walk's cost is N × RTT with no overlap.
Nothing in the loader or in `gatewayEnvironment` batches or parallelizes.

## Red 3 (measured, the real deployment shape): SSH multiplies every file RPC

Over the real SSH filesystem and the real remote Python helper (counting transport, real helper process):

| Skills | Helper runs | Of which host+discover | Wall (local transport) |
| --- | --- | --- | --- |
| 16 | 328 | **204 (62%)** | 5.2 s |
| 65 | 716 | **430 (60%)** | 11.6 s |

Two facts:

- `SshFilesystem.#readAuthorization` (`packages/gateway/src/ssh-filesystem.ts:177-181`) calls `#host()` for **every**
  request, and `#host` runs `host` **and** `discover` (`:154-160`) — two extra helper runs per file RPC. That is the
  60% above, paid again on every canonicalization, listing and read.
- `#readText`/`#readBinary`/`#info` each run `info` **then** the read (`:184-200`), so a content read is two runs.

So the SSH path costs roughly **11 helper runs per resource**, each a process spawn plus an SSH round trip, all serial.

## What each resource kind actually needs (the user's question)

Measured on the walk, per kind:

| Kind | Retrieved now | Kept now | Needed to render the prefix |
| --- | --- | --- | --- |
| Context file (`AGENTS.md`) | whole file | whole file | **whole file** |
| System / append prompt | whole file | whole file | **whole file** |
| Prompt template | whole file (body kept as the template) | whole body | **whole body** — the command expands it, so the body is genuinely needed |
| Skill `SKILL.md` | **whole file** | frontmatter + body | **frontmatter only** for the prefix; the body is read again by `expand()` at `/skill:<name>` time from the real path |
| Skill supporting files | **never read** | nothing | **never** — not discovered, not read |

So the answer to "does it need everything": no. The prefix needs context files and system/append prompts whole, prompt
templates whole, and **only the frontmatter of each skill**; skill bodies and supporting files are on-demand and stay
native (the model reads them through ordinary file tools). `readSkill` reads the whole file today only because
frontmatter parsing is local; `formatSkillsForPrompt` uses name/description/location only.

## What "directories are not constantly needed" already means

Adopted state is conversation-owned and durable: `WorkspaceResourcesDoc` (`adopted`/`candidate`/`deferredForRun`).
A conversation with an adopted catalog never walks again — that is the 452.9 ms second admission. Re-discovery happens
only on the explicit Reload (`reloadResources`) and on the first load of a conversation with no adopted state. There is
**no backend-global cache** today, so a new conversation always re-walks; nothing is stale-shared between conversations.

## Capability that already exists and is unused

`packages/gateway/src/ssh-filesystem.ts` already carries a host-side `discover` mode in the remote helper, used only to
answer `ExecutionHost` (roots/context/prompt file **names**). No path in the product performs a batched content
discovery, and `packages/gateway/src/filesystem.ts` (the local filesystem) has no equivalent. `ExecutionEnv` exposes
`listDir`/`fileInfo`/`readTextFile`/`canonicalPath` only — there is no batch or snapshot primitive to build on.

## Ranked hypotheses for the remaining mechanism

1. **Per-entry serialized round trips dominate and nothing overlaps them.** Confirmed by count and peak-in-flight 1
   (365-1,015 round trips, 20 KB, peak 1). Prediction: batching or bounded parallelism alone collapses the wall time
   without changing what is loaded.
2. **SSH re-resolves authorization per request (2 extra helper runs) and doubles content reads.** Confirmed: 60% of
   helper runs are `host`+`discover`, and each read is `info`+`read_text`. Prediction: resolving the host once per
   request batch, or once per connection, removes most helper runs.
3. **The walk reads far more than the prefix needs (whole skill bodies).** Confirmed by kind: bodies are needed only on
   `/skill:<name>`. Prediction: frontmatter-only reads cut content bytes and, for nested trees, canonicalizations.
4. **The pre-admission ordering is what makes it a stall rather than a slow answer.** Confirmed: `expandInput` runs
   inside the submit handler before `conversation.submit`, so no submission exists and no frame can be sent.
   Prediction: staging the submission before discovery (or admitting then discovering) turns the same work into a
   visible pending turn.
5. **Directory listings themselves are slow on the host (2.0-3.1 s per listing).** Not explained by this loop, which
   models uniform RTT; the live per-listing cost is far above 168 ms. Prediction: a single host-side walk that lists
   and reads in one helper run removes both the count and the per-listing cost.

## Design options (not implemented; for the checkpoint)

All preserve the existing seam (`WorkspaceResources.discover` over `ExecutionEnv`), the precedence and ignore rules,
the read-only escape rule, and the atomic prefix/reload semantics. No new loader authority.

- **A. Batch read primitive on the resource seam.** Add one method to the environment/gateway protocol — "given these
  roots, return the catalog" — implemented by the remote helper (which already has a `discover` mode and Python to do
  the walk in-process) and by the local filesystem. Turns N round trips into 1 per root. Largest cut, touches the
  gateway protocol.
- **B. Resolve the host once per request batch and reuse it.** `SshFilesystem.#readAuthorization` re-runs
  `host`+`discover` per request; caching that resolution for the lifetime of one discovery removes ~60% of helper runs
  with no protocol change. Cheap, and it composes with A.
- **C. Bounded concurrency in the loader.** The walk awaits everything serially (peak 1). Overlapping independent
  listings/reads at a small fixed bound cuts the wall time by that factor with no semantic change. Cheapest single cut.
- **D. Frontmatter-only reads for skills.** Read a bounded prefix of each `SKILL.md` (frontmatter plus the first
  description block) instead of the whole file; bodies stay on demand. Cuts bytes and canonicalizations in nested trees.
- **E. Stage the submission before discovery.** Let the submit be admitted and announced first, so the user sees the
  pending turn and a status for the whole walk. This is the UI half of the same defect and is independent of A-D.

A and B/C are complementary; D is independent; E is the separate UI red above and does not require the transport work.

## Not claimed

- No fix is implemented. No hypothesis is asserted as the single cause of every number.
- The per-listing 2.0-3.1 s cost on the live host is not reproduced locally and is not explained here.
- The ~300 s idle SSE `BodyTimeoutError` teardown is the parent's separate finding and is untouched.
- The exact live tree shape (flat vs nested) is inferred from the round-trip magnitude, not read from the host.
