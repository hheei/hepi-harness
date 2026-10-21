# 08: Remove replaced legacy runtime paths after regression proof

**What to build:** Obsolete local session/runtime paths are removed only after the durable server, gateway, and adapted UI behavior have passed regression checks and the remaining source mapping is documented.

**Blocked by:** 03: Run one durable conversation through the server; 05: Control one conversation from multiple Web UIs; 06: Execute an explicitly configured SSH workspace through the gateway; 07: Add selected workbench capabilities through the gateway boundary

**Status:** complete (selected cleanup and ticket 06 real interruption verification passed; full upstream parity remains out of scope)

- [x] Compare demo behaviours with backend/SSE/browser restart, dedup, reconnect and live state evidence.
- [x] Run selected public-seam regression and typecheck (49 fast tests), copied React build/live UI/workbench smoke, unsafe recovery and dependency-complete relevant upstream baselines. External whole-desktop gates and real-model coverage limits remain documented; DeepSeek text/SSE smoke has passed.
- [x] Remove standalone unauthenticated demo and three dormant pi-web runtime entry implementations; preserve original source/license snapshot and historical evidence.
- [x] Update provenance and migration documentation to identify retained, adapted, and removed sources.

## Audit result

See docs/migration-status.md and docs/archive/README.md. Backend/browser tests plus manual live-output and SIGKILL recovery establish demo replacement; dormant pi-web runtime entrypoints were independently absent from entry graph/production traces. Removed only those proven-obsolete paths, preserving upstream lib/license with bash cp. Relevant dependency-complete upstream subsets pass, while pi-gui Electron/Node guard checks remain external verification limits. DeepSeek text/SSE smoke has passed; real-model tool coverage is recorded separately. Final execution review corrections and regression pass, including post-eviction identity tombstones. Ticket 06 real SSH interruption matrix now passes 10/10 cases, including conservative unknown outcomes and journal no-replay. This closes the selected cleanup ticket, not a claim of full upstream feature parity or completed cross-machine deployment.
- [x] Verify production app entry graph has one durable backend runtime; archived source is not executed; gateway routes require token.
