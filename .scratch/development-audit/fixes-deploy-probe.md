# Fix — `deploy:inspect --probe` on a host with a container that has no health check

Date: 2026-10-14. Base revision: `1758c1fb4479e9d4637a957857246c5998619d73`. Owner: deploy-probe worker
(`scripts/deploy-inspect.mjs`, `scripts/deploy-inspect.test.mjs`, `scripts/lib/deploy.mjs`,
`scripts/testing/docker-fixture.mjs`, `docs/deployment-runbook.md`, this note).

## Symptom

`pnpm deploy:inspect --probe` exited **3** with `probe FAILED field=containerDetail exit=1 (the read-only probe
command exited non-zero)`, so the report never reached the release-marker read and the running revision was unknown.
Raw output was kept (private, git-ignored) at `.dev/deploy-inspect/2026-10-14T07-21-57-674/probe-raw.log`.

## Cause

`probePlan()` read the container detail with
`docker inspect --format '... {{.State.StartedAt}} {{.State.Health.Status}}' $(docker ps -q)`. Docker renders
`--format` as a Go template with `missingkey=error`, and a container with no `HEALTHCHECK` has **no**
`State.Health` key. Naming it therefore failed the whole `docker inspect` call — for every container, not just the
one without a health check — and the command exited 1. On the runtime host 5 of 12 running containers have no health
status, so the read failed on every run.

The tolerance is a property of the format, not of the caller: `{{if .State.Health}}` fails the same way under
`missingkey=error` (verified with `text/template` `Option("missingkey=error")`), while the `index` function
returns the map's zero value for a key that is absent and is not subject to that option.

## Fix

- `scripts/lib/deploy.mjs` — the container detail template now reads health through
  `{{with index .State "Health"}}{{.Status}}{{else}}none{{end}}`. A container with no health check reports
  `none`; containers that have one are unchanged. `parseProbeOutput` documents the value. No other field, verb or
  failure path changed: a genuinely unreachable host, a non-zero read, or a missing/absent private configuration
  still reports `skipped` (no probe requested or nothing configured) or `failed` with exit 3, and the raw output
  still goes only to the git-ignored diagnostics file.
- `scripts/testing/docker-fixture.mjs` — the fixture `--format` evaluator now covers the subset the probe uses
  (`.Path` under `missingkey=error`, `index` as the zero value, `if`/`with`/`else`/`end`) and refuses
  anything else, so a template the fixture cannot evaluate fails loudly instead of printing a wrong line. Its default
  state now includes one running container with no `State.Health`, the state a real host is in.
- `scripts/deploy-inspect.test.mjs` — new test: a container without `HEALTHCHECK` reports `health=none`, the
  healthy container still reports `healthy`, and the release marker is read (the read that used to be hidden behind
  the failure).
- `docs/deployment-runbook.md` — the stage-1 "Known limit" paragraph is replaced by the fixed behaviour and a pointer
  here.

## Verification

| Check | Revision / tree | Result | Log |
| --- | --- | --- | --- |
| `node --test scripts/deploy-inspect.test.mjs` with the new fixture + test, old `deploy.mjs` (detached worktree at HEAD) | `1758c1f` + copied fixture/test | **exit 1**, 2 failing: the first probe test and the new one, both `probe FAILED field=containerDetail exit=1` / actual 3 vs expected 0 — the regression is real, not asserted by construction | `.dev/verify/2026-10-14-deploy-probe/red-old-template.log` |
| `node --test scripts/deploy-inspect.test.mjs scripts/cli-usage.test.mjs` | `1758c1f`, dirty tree | **exit 0**, 11 tests, 11 pass, 0 fail | `.dev/verify/2026-10-14-deploy-probe/green-focused.log` |
| `pnpm check:docs` | `1758c1f`, dirty tree | exit 0, 186 files, 0 broken relative links | `.dev/verify/2026-10-14-deploy-probe/check-docs-before.log` |

### Live read-only probe (authorized; no deployment, restart, build or install)

`pnpm deploy:inspect --probe`, exit **0**, `.dev/verify/2026-10-14-deploy-probe/live-probe.log`:

- backend release marker `56ff08f9a3b7bb24839b91c5f9a3a099219e6bbc`, resolved from the running backend image tag
  `hepi-backend:56ff08f` (image id `b34b7d4c…`, arm64), `restart=0`, `health=healthy`,
  started `2026-10-14T06:49:53Z`;
- Web image `hepi-web:df24b7c` (image id `624043a1…`, arm64), `restart=0`, `health=healthy`,
  started `2026-10-12T02:45:38Z`;
- the containers without a health check now report `health=none` (5 of 12), which is what used to fail the read.

Read-only smoke (`.dev/verify/2026-10-14-deploy-probe/live-smoke.log`): unauthenticated
`GET http://127.0.0.1:8787/api/models` on the runtime host loopback returned **401**, the runbook stage-7
expectation.

### Live authenticated smoke (authorized follow-up, still read-only)

Taken 2026-10-14, `.dev/verify/2026-10-14-deploy-probe/live-authenticated-smoke.log`, using the shape the
repository's own `deploy/docker/smoke.sh` uses (host `curl` + bearer token against `/api/models`), but against
the running deployment and with **no** build, container start, restart, install or file write:

| Read | Result |
| --- | --- |
| authenticated `GET /api/models` | **200**, 3266 bytes |
| catalogue aggregate (body discarded, counts only) | 7 `"id"` keys, 7 distinct id values, one line mentions the offline `faux` provider |
| unauthenticated `GET /api/models` (control) | **401** |

Method and secret handling: the backend and Web containers carry **no** `curl` and no `wget` (checked with
`command -v` inside each; both run on the host network), so no container-resident client could take the call. The
runtime host has `curl`, and the token was read from the running backend container's own environment
(`docker exec <backend> printenv HEPI_AUTH_TOKEN`) into a shell variable, then delivered to `curl` through its
config-on-stdin (`-K -`) so the token never enters `argv`, any log or any output. Only status codes and counts were
printed; a leak check for a bearer-looking string in the log returns 0 matches. The port came from the container's own
`PORT` and matches the documented default. `docker exec` ran read-only commands (`printenv`, and the two shells
that could not find a client) — no process was restarted, nothing was installed and nothing was written.

## Remaining limits

- The probe itself still reads no secret, by design: the authenticated smoke above is a separate, explicitly
  authorized read-only step, not something `deploy:inspect --probe` does or should do. Before that step the
  authenticated path was only indirectly attested by the backend's own `HEALTHCHECK` (which fetches
  `/api/models` with the token and is what `health=healthy` reports).
- No container-resident HTTP client exists to run the call from inside a container: the backend and Web images ship
  neither `curl` nor `wget`, and both run on the host network. A future in-container check would need a client added
  to the image, or the image's `node` runtime, which the read-only constraint excluded.
- On this workstation the documented local forward (`127.0.0.1:8787`) was not up (`curl` exit 7), and the backend
  container publishes no host port on the shared runtime host, so the authenticated smoke is taken from the runtime
  host itself.
- The probe still exits 3 on a genuine failure (ssh unreachable, a read that exits non-zero, a missing marker for a
  named release is a warning). Only the false failure is removed.
- Dated records that mention the old limit (`docs/records/0628888e5a85-deployment.md`, `docs/records/96297fe-deployment.md`,
  `docs/verification.md`) are historical for their own revisions and were left as written; the owning guide
  (`docs/deployment-runbook.md`) now states the fixed behaviour.
