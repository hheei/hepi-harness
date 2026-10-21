# 04: Execute one workspace through a local gateway

**What to build:** The durable server can route agent filesystem and shell operations through a separately running workstation gateway against an explicitly configured local workspace.

**Blocked by:** 02: Define the versioned protocol and workspace model; 03: Run one durable conversation through the server

**Status:** complete (selected coding-tool slice; limits documented)

- [x] Implement gateway authentication/identity and server-to-gateway execution RPC.
- [x] Wire upstream read/write/edit/bash via partial gateway ExecutionEnv, persisted logical workspace IDs and authenticated file/execute/abort RPC. Live shell output is verified in React; full environment conformance remains outside this selected slice.
- [x] Enforce workspace root/path confinement and explicit command authorization.
- [x] Preserve stdout, stderr, exit code, cancellation, timeout, cwd, environment boundaries, and durable call IDs.
- [x] Verify lost response, gateway restart, abort-before-admission, spent-ID protection and streamed output at public RPC seams. No automatic replay; tombstones outlive retained payloads.

## Comments

Implemented `@hepi/gateway` as a separately runnable local gateway boundary. `LocalGateway` delegates shell execution to the unchanged upstream `NodeExecutionEnv`, confines cwd to configured workspace roots, requires an explicit basename allowlist, disables inherited environment by default, tracks durable call IDs for cancellation, and returns timeout/aborted/offline outcomes without converting them into success. `GatewayRpcServer` authenticates Bearer tokens; `GatewayRpcClient` maps transport failure to `gateway_offline`.

Evidence: `packages/gateway/src/index.ts` and `packages/gateway/test/gateway.test.ts`. Server-side ExecutionEnv wiring and SQLite call journaling are integrated; SSH filesystem is implemented in ticket 06; this ticket deliberately keeps secrets and reachability in the gateway process.
