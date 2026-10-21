# Recorded, not fixed — `deploy:inspect --probe` on a real host

## The probe still cannot complete against the runtime host

Found while running the merged probe fix (`c22f7da`) against the live runtime role, 2026-10-12. **Recorded, not
fixed**: the task that merged the probe layout fix was scoped to the release-marker path, and the user kept this
one out of a fix loop unless it is prioritized later.

| | |
| --- | --- |
| Symptom | `pnpm deploy:inspect --probe` exits **3**, `probe FAILED field=containerDetail exit=1 (the read-only probe command exited non-zero)` |
| Where | `scripts/lib/deploy.mjs` `probePlan()` — `docker inspect --format '{{.Name}} {{.Config.Image}} {{.RestartCount}} {{.State.StartedAt}} {{.State.Health.Status}}' $(docker ps -q)` |
| Cause | `docker inspect` fails the whole call when **any** running container has no `HEALTHCHECK`: `template parsing error: template: :1:75: executing "" at <.State.Health.Status>: map has no entry for key "Health"`. One such container makes the command exit 1. |
| Blast radius on the live host | 5 of 12 running containers have no health status (`mihomo`, `WeKnora-mcp`, `WeKnora-frontend`, `WeKnora-redis`, `jp-desktop`), so the command exits 1 on every run. |
| Provenance | Pre-existing: the line was introduced with the original probe (`59d9913`, "scripts: add read-only deploy:inspect and offline deploy:plan") and is unchanged at the base `576a49e`. `c22f7da` does not touch it. |
| Consequence for the merged fix | The probe aborts on `containerDetail`, which is planned **before** the release-marker read, so `c22f7da`'s `releases/<artifact-id>/SOURCE_COMMIT` resolution is **not exercised end-to-end on a real host** — only by its fixture (`scripts/deploy-inspect.test.mjs`, 8 tests, green). The marker read is correct as written and unproven live. |
| Revisit if | `deploy:inspect --probe` is used as a real pre-deployment gate, or the probe is asked to report health. The remedy is one `docker inspect` per container (or a format that tolerates a missing health map), so a container without a health check reports its absence instead of failing the read. |

Evidence: `.dev/verify/p1/2026-10-12T18-30-58-p1-probe.log` (probe run, exit 3) and the raw diagnostic the probe
kept at `.dev/deploy-inspect/2026-10-12T10-30-58-233/probe-raw.log` (the five `map has no entry for key "Health"`
stderr lines and the partial `containerDetail` stdout).
