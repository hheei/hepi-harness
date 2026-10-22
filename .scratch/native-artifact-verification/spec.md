# Native artifact verification ownership

Status: implemented — callable operation integrated at `631c954e`; private packaged-run lifetime integrated at `8a44daa9`. Design baseline: `5ec7ffe6`, 2026-10-21. [Delivery evidence](issues/02-owned-run-lifetime.md#delivery-and-verification--2026-10-21) · [Design index](../non-ui-architecture-design/README.md) · [Shared requirements](../non-ui-architecture-design/requirements.md).

## Problem and evidence

[verify-artifacts.mjs](../../apps/app/scripts/verify-artifacts.mjs) is a 657-line concrete artifact check. Top-level code selects artifacts/logs and samples the login keyring; the implementation inspects packages, coordinates X display and keyboard input, runs an ingress fixture and packaged processes, tests credentials across cold starts, cleans resources and writes report.json. `process.exit` at the CLI tail is explicit because App process groups can outlive assertions.

[credential-sandbox.mjs](../../scripts/lib/credential-sandbox.mjs) already owns private D-Bus/Secret Service isolation. [offline-install.mjs](../../apps/app/scripts/offline-install.mjs) owns installation support and cleanup. These are useful existing modules, not code to collapse into a generic runner. This audit did not measure CI duration or prove a process leak.

Representative change: adding a packaged App assertion should require understanding that journey and its evidence, without recreating display startup, credential-isolation ordering or process-group cleanup.

## Chosen module and interface

Keep the current CLI path, flags, default artifact selection, output summary, report schema and success/failure exit semantics. The CLI resolves options and invokes one concrete `runArtifactVerification({ artifactDir, logDir })` operation. Proposed function name is illustrative; it returns the actual completed report/summary after cleanup. Importing the implementation itself does no artifact lookup, mkdir, subprocess spawn or process.exit. CLI alone owns final process exit.

Within this implementation, keep artifact inspection/assertions and a cohesive packaged-run environment as internal modules where that separation removes actual lifecycle knowledge. The environment reuses existing credential-sandbox and offline-install functions, owns its display, fixture listener, launched process groups and temporary extraction/install resources, and releases only those it acquired. Its internal lifetime brackets the concrete artifact journey; do not export a general scenario-runner interface or create classes per subprocess.

Keep the scenario readable as sequential product operations: inspect the prebuilt artifact → cold start unconfigured → configure connection in this run’s private credential store → restart and observe the configured fixture → forget connection → cold start unconfigured → dispose → publish evidence. Preserve the existing installation and namespace observations actually performed by the script. No source-only stand-in counts as packaged execution.

## Interface facts

- All packaged process launches use the existing packagedEnvironment/private Secret Service result. Start no packaged credential operation before isolation is ready. Preserve before/after developer-login-keyring evidence and report whether the run’s store was retained or removed.
- Existing raw logs/screenshots/assertion names and artifact identity remain attributable to the tested artifact. Teardown completes before report finalization and final exit; a recorded report alone is not proof the run finished.
- Process cleanup addresses owned PIDs/groups, not global process names or another display. Preserve bounded waits and existing platform-specific fallback/limit semantics when they are current product checks.
- Extraction and packaged execution are distinguished from a system dpkg install in evidence. Reuse runOfflineInstall for the installation observations it already owns.
- This is a Linux packaged-verification effort. No new macOS/Windows automation abstraction, VM/container runner or credential-store implementation. Build only on workstation/CI; verification consumes prebuilt artifacts.
- Operational .mjs entry paths may remain. New unit/integration tests follow the repository TypeScript convention; this task does not migrate every operational script.

## Alternatives and dependencies

| Alternative | Assessment |
| --- | --- |
| Leave all logic at module top level | No new structure, but environment lifetime and assertions remain inseparable. Reject for this prioritized cleanup. |
| Generic ArtifactVerifier plus Display/Probe/Runner classes | Adds unused variation and a large injected interface. Reject. |
| Merge offline install and credential sandbox into one helper | Erases existing coherent owners, makes reuse harder. Reject. |
| Concrete verification operation with private environment lifetime | Hides setup/cleanup while retaining explicit journey and evidence. Select. |

In-process: option/result assembly and assertions. Local-substitutable: temp filesystem and local fixture ingress; use existing fixtures. Remote-owned: no new production remote dependency; test ingress is a local owned module. True-external: dpkg tools, Xvfb/X11, Secret Service tooling, packaged native binary and OS namespaces. Do not substitute fake binaries/credentials for artifact acceptance.

## Deletion and acceptance

Remove implementation-owned top-level setup/exit, dispersed environment teardown from assertions, and duplicated process lifecycle code only where its semantics match the existing owner. Keep credential-sandbox and offline-install interfaces. Deleting the concrete environment owner would return acquisition ordering and cleanup facts to every artifact journey; a shallow wrapper around those helpers would fail this spec.

| ID | Observable completion | Evidence seam / planned check |
| --- | --- | --- |
| NV1 | Current CLI invocation selects requested/default artifacts and produces compatible summary/report/exit. | Existing `pnpm --filter @hepi/app verify:artifacts` against a named prebuilt artifact. |
| NV2 | Real cold-start/configure/restart/forget journey and fixture observations retain their existing outcomes. | Same packaged binary and existing artifact journey; do not replace with source UI tests. |
| NV3 | Every packaged credential operation addresses the private run store; login-keyring evidence remains. | Existing private sandbox and report assertions, ordinary admitted workflow. |
| NV4 | Run completes with its processes/listener/display stopped and evidence finalized. | Actual command completion plus owned-resource teardown observations. |
| NV5 | Implementation import is inert; pure report assembly tests cross its actual interface. | Small TypeScript interface test only if needed; no VM source extraction or mirrored private-helper tests. |

Keep packaged artifact checks as acceptance. Do not reproduce every assertion as a unit test. Remove redundant setup tests only after replacement at the concrete environment/interface seam exists. Future implementation must record actual artifact revision/hash, command, exit and logs; no current native run is claimed.

## Slices, dependencies and guides

1. Inventory assertion/report fields, subprocess ownership and acquisition order from the current script.
2. Introduce callable concrete verification operation and thin CLI; migrate lifetime management using existing helpers.
3. Exercise the actual packaged journey, inspect cleanup/evidence and remove redundant setup code.
4. Update [releases](../../docs/releases.md), [CI](../../docs/ci.md) and affected App verification documentation.

Independent of Backend/Gateway refactors and UI implementation. A future UI native acceptance run may reuse this environment only when its real requirements match; no speculative reuse requirement blocks this work.
