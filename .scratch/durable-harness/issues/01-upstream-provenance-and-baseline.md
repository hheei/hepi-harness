# 01: Preserve upstream provenance and establish baselines

**What to build:** The project has reproducible references to the selected upstream repositories and recorded baseline commands/results, so later adaptations can be compared against known source and behavior.

**Blocked by:** None (can start immediately)

**Status:** complete

- [x] Record repository URLs, exact revisions, licenses, package versions, relevant entrypoints, and the copy/adapt/defer/do-not-import matrix.
- [x] Preserve upstream source snapshots or reproducible source references without importing application runtime into the project.
- [x] Run the feasible `pi-durable`, `pi-web`, and `pi-gui` baseline checks and record actual outcomes and blockers.
- [x] Document the baseline and provenance paths for future tickets.

Evidence: [docs/upstream-sources.md](../../../docs/upstream-sources.md).
