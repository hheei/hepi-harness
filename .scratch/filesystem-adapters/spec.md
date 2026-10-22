# Filesystem adapter maintainability

Status: resolved; tickets 01–02 integrated into `impl/architecture-consolidation`, latest `ce8aa223`. Design baseline: `5ec7ffe6`, 2026-10-21. [Design index](../non-ui-architecture-design/README.md) · [Shared requirements](../non-ui-architecture-design/requirements.md).

## Problem and evidence

[filesystem.ts](../../packages/gateway/src/filesystem.ts) already defines FileRequest at 22 and FilesystemServer at 49. LocalFilesystem starts at 312; [ssh-filesystem.ts](../../packages/gateway/src/ssh-filesystem.ts) has SshFilesystem at 361 and an escaped Python program on line 33 containing 1,191 decoded lines. [runner.ts](../../packages/gateway/src/runner.ts) already owns the SSH seam. The Python helper implements actual host-side filesystem operations, resource discovery and the licensed node-ignore port.

Representative change: adding a supported resource-discovery behavior must have identifiable implementations and ordinary positive contract observations for local and SSH adapters. The two hosts necessarily validate locally; no security-parity defect is claimed from duplicated code alone.

## Chosen design

Preserve the actual interface:

```ts
type FilesystemServer = {
  execute(request: FileRequest): Promise<unknown>;
  close(): Promise<void>;
};
// Existing request vocabulary, not a new protocol:
await files.execute({ workspaceId, method: "readTextFile", path: "src/index.ts" });
```

LocalFilesystem and SshFilesystem remain real adapters at that seam. Keep bounded reader ownership and coarse operations such as resourceSnapshot and line scans. No new FilesystemFactory, VFS layer, generic POSIX protocol or policy interpreter.

Move the single authoritative Python program into one readable multiline TypeScript source constant in a dedicated internal module, imported by SshFilesystem. Use a lossless literal representation; verify the decoded program and syntax during migration, including backslash/interpolation escaping and licensed notice text. This is source organization, not semantic consolidation or net LOC reduction. The program remains statically embedded in the existing bundle and is sent over the current SSH transport. No runtime source-tree lookup, generated duplicate source, Python install or remote service.

Keep host-specific path/resource validation in each adapter. Consolidate only demonstrably identical gateway-side request normalization where it has a real second caller; list each proposed deletion before changing it. Preserve coarse host discovery and avoid replacing one snapshot with per-file requests. Remove existing compatibility-only `GatewayFiles` type/value aliases (filesystem.ts:55,433); migrate current type imports to FilesystemServer and constructor calls to LocalFilesystem directly. Coordinate those changes with Gateway transport.

## Ordering, errors, lifetime and packaging

- Use the registry’s actual workspace/profile/root. Preserve host-derived execution account/resource roots; caller-supplied paths never become authority.
- SSH uses the existing persistent session per profile/root. Missing runner.open returns its named limit; there is already no one-shot fallback to delete. Do not invent retry paths.
- Preserve reader TTL/capacity, request/session deadlines, explicit close and in-flight abort behavior.
- A dispatched mutation with lost response remains outcome-unknown and is not replayed. Atomic staged write completion and cleanup remain owned by the remote implementation.
- FileError codes and existing result envelope remain unchanged; the current interface returns Promise<unknown>, so a generic FileResult redesign is outside scope.
- [Client build](../../packages/client/scripts/build.mjs) bundles gateway imports into dist/chunks; release assembly uses [build-client-runtime.mjs](../../scripts/build-client-runtime.mjs). Static TypeScript import requires no new loader/assets. Verify an actual built package without a source checkout; preserve license notices in artifacts.

## Alternatives and dependency strategy

| Alternative | Assessment |
| --- | --- |
| Leave escaped one-line string | Lowest change cost, poor source locality/readability; reject for this explicitly prioritized cleanup. |
| Standalone .py plus copied runtime asset | Native Python tooling, but introduces asset placement for source runs and bundled chunks. Reject for this slice. |
| .py import + build-time text loader/generated TS | Requires additional source-run support or generation state; disproportionate complexity here. Reject. |
| Readable statically imported Python source constant | Improves navigation while preserving current runtime/deployment mechanism. Select. |

In-process: request normalization, reader registry and framing. Local-substitutable: actual temporary filesystem, fixture runner for transport plumbing. Remote-owned: Python helper over existing SSH runner. True-external: sshd/Python/OS; use existing normal loopback SSH fixtures. A mock runner alone cannot establish helper behavior.

## Acceptance and replacement testing

| ID | Observable completion | Existing evidence seam |
| --- | --- | --- |
| FA1 | Existing requests/results, limits and decoded helper behavior survive representation change. | Existing gateway file/SSH tests; compare old/new helper bytes or explicitly account for inert formatting changes, plus Python syntax compilation. |
| FA2 | Permitted text/binary reads, staged writes, rename, listing and reader scan/close agree across adapters. | Shared scenario definitions invoked through existing ordinary admitted local and loopback SSH workflows. |
| FA3 | Resource snapshot and permitted agent-definition read/write retain host account and scope semantics. | `apps/server/test/ssh-project.test.ts`, existing resources/SSH workbench integration cases. |
| FA4 | Ignore behavior and notices remain intact. | Existing `packages/gateway/test/ignore-parity.test.ts` plus actual built artifact notice check. |
| FA5 | Packed execution bundle works without repository files; alias imports are gone. | Client package build/pack and focused existing release acceptance; source reference review. |

Shared positive scenario data replaces duplicated setup/assertions only after equivalent observations exist. Retain tests for adapter-specific unknown outcomes and transport/session ownership. No new denial/bypass corpus or direct helper driver that skips shipped admission.

## Slices, dependencies and guides

1. Inventory current method/resource/result matrix and packaging callers.
2. Extract readable constant losslessly; migrate aliases, keeping the FilesystemServer seam.
3. Reuse positive contract scenarios; remove proven redundant normalization/tests, verify package execution and notices.
4. Update [workbench](../../docs/workbench.md), [execution-side skills](../../docs/execution-side-skills.md) and [developer guide](../../docs/developer-guide.md).

Can proceed independently of Backend and ingress work. Gateway transport only shares the FilesystemServer import/caller edits; designate one integration owner for those lines.
