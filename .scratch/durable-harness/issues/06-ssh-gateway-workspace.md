# 06: Execute an explicitly configured SSH workspace through the gateway

**What to build:** A workstation gateway can execute the same approved workspace operations against at least one SSH host without Pi or an inbound service on that host.

**Blocked by:** 04: Execute one workspace through a local gateway

**Status:** done (SSH shell/filesystem and the real transport interruption matrix verified)

- [x] Reuse SSH config, ProxyJump, and existing authenticated routes where available.
- [x] Verify actual configured localhost SSH routing and durable bash tool RPC; credentials remain gateway-local. Connection reuse remains deferred.
- [x] Remote Python3 filesystem and canonical/temp/symlink confinement verified on actual localhost SSH. No remote Pi/daemon. Partial ExecutionEnv limits documented.
- [x] Verify production runner quoting, exit 255, cancellation, reconnect and outcome-unknown semantics on a real transport. Injected runner tests do not verify these behaviors; the real localhost SSH smoke in docs/ssh-interruption-verification.md does.
- [x] Verify no SSH secret is persisted in cloud SQLite, logs, protocol snapshots, or browser state.

## Comments

`SshGateway` now enforces explicit `remote-<profile>` workspace bindings, remote-root confinement, command allowlists, and durable call IDs. The default system runner invokes `ssh` through argv and relies on the workstation user's existing SSH configuration, agent, ProxyJump, and host verification. Tests inject a runner to cover output, unreachable hosts, timeout, cancellation, and outcome-unknown results without requiring a live host. Secrets remain outside the protocol and persistence packages.

Evidence: `packages/gateway/src/index.ts`, `packages/gateway/test/ssh.test.ts`, and manual actual localhost SSH + durable agent bash smoke in docs/local-integration.md. Runner now safely quotes arguments and maps SSH exit 255/timeout/abort conservatively to outcome-unknown. No automatic replay; remote process termination is not guaranteed.

Real transport interruption matrix: docs/ssh-interruption-verification.md (harness `/tmp/hepi-ssh-interruption-smoke.mts`). 10/10 on three consecutive runs against a temporary localhost sshd: argv quoting round trip with no injection, a command's own exit 255, a transport-failure exit 255, cancellation after FIFO readiness, a short timeout gated on readiness, mid-call connection termination, same call ID refused after a persistent-journal reopen, a lost response while the call still ran, reconnect with a new call, and a spill request streamed in full with no readable spill path claimed. Measured limits: the remote pid stayed alive after cancellation and timeout, so no remote termination is claimed; only a spawn failure yields `ssh_unreachable`; the journal prevents repeats but is not recovery.
