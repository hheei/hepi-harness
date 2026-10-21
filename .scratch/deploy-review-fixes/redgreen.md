# Review fixes on f3652d2 — red/green record

Both axes of the review of `f3652d2` found real defects; this records the evidence that each one was reproduced
against the fixed revision and is now fixed on this branch. **Old** is `/tmp/hepi-redcheck` checked out at
`f3652d2`; **new** is this branch's working tree. Every case below is the same fixture run against both, at the
public seam, not a helper in isolation.

Re-run with `sh /tmp/redgreen.sh`, `sh /tmp/redgreen2.sh`, `sh /tmp/redgreen3.sh` (kept outside the repository, as
they reference the review worktree); raw output is in `/tmp/redgreen*.log`. Measurements are of one run on one
machine.

## 1. Probe write/read format mismatch (`deploy:inspect --probe`)

| | old | new |
| --- | --- | --- |
| producer output | `docker image ls --format ... \| sort` etc. — plain text | one plain-text output per field, keyed |
| parser input contract | `JSON.parse(text)` | the producer's own lines |
| result on the producer's text | `{ ok: false, warnings: ["probe output was not JSON"] }`, **exit 0** | `{ commit, images: [{tag, id, arch}], containers: [...] }`, exit 0 |
| image architecture source | `docker inspect` of a running container | `docker image inspect` of the image |
| failure | not distinguishable from success | exit 3, `probe FAILED field=<name> exit=<n>`, raw text to `.dev/deploy-inspect/<ts>/probe-raw.log` |

Reproduced producer-and-consumer together in `scripts/deploy-inspect.test.mjs` through a fixture `ssh`
(`SSH_COMMAND` seam) that logs what it was asked; the test also asserts the probe asks for no `up`, `buildx`,
`docker build`, `systemctl` or `rm`.

## 2. `deploy:plan` emitted commands that would damage a live host

| | old | new |
| --- | --- | --- |
| occurrences of `docker compose` in the plan | 2 | 0 |
| line 268 (`verify-artifact`) | `docker compose -f deploy/compose.yaml up -d --no-build` | deleted; verification reads the image |
| line 285 (`switch`) | same bare `up -d --no-build` | no command; stage prints `incomplete` + manual prerequisites |
| default image / volume risk | falls back to `hepi-backend:local` and a fresh named volume | impossible: no compose command is emitted |
| gates before switch | none in the plan | `single-writer` and `backup-verified`, both required for the run |
| platforms | one `--platform` for both images | backend `linux/<runtime-arch>`, web `linux/<build-arch>` |

## 3. Baseline comparison could report a false pass

| | old | new |
| --- | --- | --- |
| logs | both sides write `<log-dir>/web-unit.log` — one overwrites the other | `<log-dir>/base/...` and `<log-dir>/tip/...` |
| tip runs in | the caller's working tree | its own detached worktree at HEAD |
| dirty caller tree | measured into the tip | never reaches the measured tip (`tipDir !== repoRoot`) |
| reusable dirty baseline | accepted if the SHA matched | refused: `stage: worktree` |
| two unloadable suites | `ok=true identical=true` — **false pass** | `ok=false stage=infra comparable=false`, sides named |
| silent runner, no TAP | `identical=true` | `stage: infra`, `produced no TAP output` |

Real run on this branch, `pnpm compare:tests --base=edef2c0`: `comparable: true`, base `edef2c0a15e1` 2084 tests /
23 fail, tip `f3652d269697` 2092 tests / 23 fail, `newOnTip: 0`, `onlyOnBase: 0`, logs `/tmp/real-compare/base/`,
`/tmp/real-compare/tip/`.

## 4. Discovery read only the first file argument

| script | old | new |
| --- | --- | --- |
| `test:upstream` | `lib/normalize.test.mjs` only | all four, including `lib/file-fuzzy.test.mjs` |
| `test:skills` | first test file only | all six test files plus the two drivers and the smoke |

The defect this surfaced is real: `test:upstream` named `lib/git-types.test.mjs`, which does not exist. `node
--test a.mjs b.mjs missing.mjs` exits **0** and silently drops the missing file (verified), so the script had been
running three of its four files with no failure to show it. Repaired to name `lib/git-changes.test.mjs`, the suite
that actually covers `git-types.ts`; `pnpm --filter @hepi/web test:upstream` now runs 17 tests, 0 failures, and
`pnpm check:entrypoints` reports 0 newly missing.

## 5. Documentation links: fragments and index coverage

| | old | new |
| --- | --- | --- |
| `guide.md#no-such-heading` | not checked | `broken=1`, fragment named |
| guide under `docs/` not linked from the index | not checked | `uncovered=[docs/orphan.md]` |

On this branch the new check found two stale fragments in `.scratch/ux-follow-up/` (`validation.md` headings that
no longer exist as written); both are fixed, and `pnpm check:docs` reports 106 files, 0 broken, 0 uncovered.

## 6. Host facts in public output

`pnpm deploy:inspect` prints `host=unset`/`host=set` and `arch`, never a host; affected services print
`<registry>/<owner>/<repo>/...`; an incomplete role prints `(incomplete: DEPLOY_RUNTIME_HOST, ...)`. A grep of the
JSON report and the printed plan for a registry, a tailnet name, a `100.x` address or `/home/<user>` finds nothing
but the placeholder wording. Raw probe output is written to the git-ignored `.dev/deploy-inspect/`, never to the
report.

## Checks on this branch

| Command | Result |
| --- | --- |
| `pnpm test:scripts` | 77/77 pass |
| `pnpm check:docs` | 106 files, 0 broken, 0 uncovered |
| `pnpm check:entrypoints` | 48 present, 2 recorded known-missing, 0 newly missing (`--strict` exits 1 by design) |
| `pnpm verify --profile=fast` | `workspace-typecheck` and `workspace-tests` PASS |
| `pnpm compare:tests --base=edef2c0` | comparable, identical 23-failure set, 0 new on tip |

No deployment, no remote connection and no secret was involved in any of the above.
