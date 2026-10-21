# Scratch coverage manifest (2026-10-20)

Census taken for this manifest: **448 tracked files under `.scratch` — 352 Markdown, 96 non-Markdown evidence**
(JSON, logs, scenes, timelines, probes, fixtures); `git ls-files .scratch` remains the source of truth for the
inventory. This manifest is the one file added on top of that census — it makes the total 449 — and
`.scratch/README.md` already existed, so it was rewritten to link these rows rather than added.

Classification rule: **current** = a spec or ticket that still owns behavior someone is building, accepting or gating; **historical** = a dated record of what was measured or decided at a named revision, preserved as evidence rather than maintained as a promise. Historical records keep their original paths, counts and file names; only their current-pointer prose was reconciled.

Reviewed per effort, not symbol by symbol: every current spec/ticket status below was checked against branch history and source; historical efforts are classified and preserved, and are not claimed to have exhaustive source verification of every dated assertion.

| Effort | Files | Class | State checked against this line |
| --- | ---: | --- | --- |
| `README.md` | 1 | index | rewritten and reconciled to the rows below |
| `architecture-consolidation/` | 13 | current spec+tickets (delivered) | delivered effort; dated evidence preserved |
| `architecture-consolidation-research/` | 8 | historical research/evidence | research preserved as evidence |
| `architecture-routes/` | 9 | historical research/evidence | research preserved as evidence |
| `architecture-unification/` | 22 | current spec+tickets (delivered) | delivered effort; dated evidence preserved |
| `capability-integration/` | 23 | current spec+tickets (delivered) | delivered effort; dated evidence preserved |
| `chat-lifecycle/` | 33 | current spec+tickets (delivered) | delivered effort; dated evidence preserved |
| `child-task-recovery/` | 8 | current spec+tickets (G2/G6 approved-pending) | 01-04 resolved; G2/G6 approved-pending, unbuilt |
| `client-app/` | 28 | current spec+tickets (in progress) | 16 closeout + 17 lanes integrated; 18/19/21 complete, 20 implemented, 22 and 23-25 open |
| `cross-session-references/` | 6 | current spec+tickets (03 open) | 01 and 02 on line; 03 blocked on three unrun journeys |
| `deploy-review-fixes/` | 2 | historical research/evidence | recorded-not-fixed evidence |
| `design-fixes/` | 15 | historical research/evidence | dated diagnoses; fixes recorded in results |
| `development-audit/` | 28 | historical research/evidence | dated 2026-10-14 audit |
| `distribution/` | 2 | current spec (delivered) | delivered; publication still unexecuted by design |
| `durable-harness/` | 9 | current spec+tickets (delivered) | delivered effort; dated evidence preserved |
| `durable-subagents/` | 23 | current spec+tickets (delivered) | delivered effort; dated evidence preserved |
| `execution-resources/` | 10 | current spec+tickets (delivered) | delivered effort; dated evidence preserved |
| `files-and-export/` | 2 | current spec (delivered) | delivered; export out of scope |
| `graphify-alignment/` | 2 | historical research/evidence | workflow record |
| `history-navigation-research/` | 10 | current spec+tickets (complete) | 01-05 integrated; 05 accepted on this line (`a0caf5d`), 13-row matrix and 82 browser checks |
| `image-history/` | 1 | historical research/evidence | dated driver correction; no active gap |
| `mcp-conversation-tools/` | 11 | current spec+tickets (complete) | 01-05 integrated (05 as f2d9268, 58/58) |
| `perf-follow-up/` | 23 | current spec+tickets (delivered) | delivered effort; dated evidence preserved |
| `provider-connection/` | 9 | current spec+tickets (complete) | 01-05 complete; two limits recorded |
| `ssh-remote-workbench/` | 17 | current spec+tickets (09 delivered) | 01-08 integrated; 07 deferred; 09 delivered, reviewed and rebased onto \`70d9a6d\`, pending integration |
| `subagent-subtree-control/` | 7 | current spec+tickets (delivered) | 01-04 resolved and integrated |
| `submit-stall/` | 25 | current spec+tickets (delivered) | delivered; raw scene/timeline evidence preserved |
| `tailscale-demo/` | 2 | current spec (delivered) | historical deployment, current guide linked |
| `ux-closeout-research/` | 14 | historical research (scheduling spec owns state) | research preserved; per-row state in owners |
| `ux-follow-up/` | 32 | current spec+tickets (delivered) | 14 tickets merged; review and retro complete |
| `web-test-consolidation/` | 14 | historical research/evidence | test-inventory evidence at its revision |
| `web-test-lean3/` | 1 | historical research/evidence | single reduction result |
| `web-test-value/` | 11 | historical research/evidence | test-inventory evidence at its revision |
| `webui-next-exploration/` | 27 | historical research/evidence | exploratory reports; no implementation claim |

The rows add up to the census exactly: 33 efforts plus the index make 448 files, split **315 current spec/ticket
files, 132 dated research/evidence files and this index**.

## Evidence kinds

The 96 non-Markdown files need no per-file list here: `git ls-files .scratch` enumerates them, and there are nine
kinds. Captured run output is scenes, timelines, logs and reports; the probe and driver scripts are one-off, and a
JSON dump is a test inventory at its own revision.

| Kind | Count | Examples |
| --- | ---: | --- |
| `.json` captured scenes, reports, inventories | 33 | `chat-lifecycle/*/scene*.json`, `web-test-value/*.json` |
| `.mjs` probes, drivers, fixtures | 35 | `development-audit/perf-probes/`, `webui-next-exploration/probes/` |
| `.log` captured run output | 13 | `durable-subagents/logs/`, `submit-stall/red/` |
| `.txt` summaries and captured listings | 5 | `chat-lifecycle/*/summary.txt`, `ux-follow-up/issues/ux14-*failnames-*.txt` |
| `.jsonl` timelines | 3 | `chat-lifecycle/*/timeline.jsonl`, `submit-stall/timeline.jsonl` |
| `.ts` typed fixtures and probes | 3 | `perf-follow-up/evidence/backend-fixture.ts` |
| `.png` observation screenshots | 2 | `ux-closeout-research/evidence/` |
| `.sh` red-proof driver | 1 | `submit-stall/red-proofs.sh` |
| `.cjs` one-off script | 1 | `development-audit/reach.cjs` |

`packages/gateway/vendor/pi-gui/ipc-contracts.txt` is upstream provenance outside this ownership and stays untouched.

## Deletions

None. Every tracked scratch file is either a current spec/ticket or unique dated evidence; duplicated prose was trimmed inside files instead of deleting records, and no file's only copy of a decision or measurement was removed.
