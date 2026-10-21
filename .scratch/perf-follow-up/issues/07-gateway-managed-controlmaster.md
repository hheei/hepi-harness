# 07: Gateway-managed ControlMaster for install and execution

**What to build:** installing a skill directory or running a series of commands over SSH stops paying a handshake per step, while the user's own SSH configuration and masters keep working.

**Blocked by:** None (can start immediately); independent of 6 and deliberately **not** applied to the filesystem path.

**Status:** complete — merged into `integration/perf-follow-up` as `779a449c613fe3d064b0fed02d4e7fffcb26ce7d`.
Implemented on `impl/perf-07-controlmaster` (`9a3ff2d`, the commit that follows `244ab26`); review 1's material finding
(a spaced state directory) is fixed there, and reviewer101 approved `9a3ff2d` with 0 material findings.

Context pointers: [`spec.md`](../spec.md) (approved), [`design-history.md`](../design-history.md),
[`design-ssh.md`](../design-ssh.md), [`decisions.md`](../decisions.md), [`ticket-proposal.md`](../ticket-proposal.md).
Integration branch `integration/perf-follow-up` at `b9b28dd`.

- [x] Install and execution use one gateway-managed master keyed on the **full** connection profile (identity file and known-hosts file included), not on a host/port hash alone.
      `managedControlMaster` (`packages/gateway/src/runner.ts`) names the socket from
      `sha256([profileId, host, port ?? 22, identityFile ?? "", knownHostsFile ?? ""])[0:16]` plus this process's pid;
      `createSystemSshRunner(master)` is composed for `SshGateway` and `SshInstallServer` only
      (`packages/gateway/src/main.ts`, `packages/client/src/gateway.ts`), and the socket is handed to ssh as its own
      argv word (`-S <socket>`), so a state directory containing a space is not re-parsed as a configuration line.
      Measured on a real localhost sshd: one real publication plus one execution call, 7 authentications → **1**, with
      the same one authentication for a state directory named `hepi controlmaster …`.
- [x] The explicit options override SSH config for **gateway-spawned install/exec processes only**: an interactive `ssh` on the same host still reports the `ControlPath` its own config gives it, and the user's own master still works.
      Asserted by driving a real `ssh -G` and opening a real user-owned master: the gateway's call opens its **own**
      connection (authentication count 2, not 1), and the user's master still answers `ssh -O check` and `-O exit`
      after the gateway's teardown.
- [x] The socket directory is gateway-owned, created before first use and mode-checked; a failure to create it or a wrong mode is a reported failure, not a silent fallback.
      `prepare()` creates `<HEPI_GATEWAY_DATA>/ssh-control` at 0700 and rejects any other mode; the entrypoints await it
      before the first spawn, and a runner whose directory is missing fails the call as `outcome-unknown` after exactly
      one attempt rather than connecting without the master.
- [x] Gateway shutdown reaps the masters this gateway instance created and removes only its own sockets; there is no startup sweep, nothing is removed because a name or a pid looks dead, and no path outside the gateway's own directory is touched.
      `close()` runs `ssh -O exit` (bounded) per socket it handed out, removes those sockets, and removes the directory
      only when this instance created it and nothing else is left. A pre-existing foreign socket survives both
      `prepare` and `close`.
- [x] The gateway never passes a disable-master option and never edits or deletes anything under the user's SSH configuration; a user's own master may still exist and be used by the user's own `ssh`.
      No `ControlMaster=no` is ever built, and no path under `~/.ssh` is read, written or removed.
- [x] No gateway-managed master is applied to the filesystem path or to the terminal, and no capability ends up with two gateway-managed reuse mechanisms.
      `SshFilesystem`, `SshWorkspaceServer`, `SshWorktreeServer` and `sshTerminalLauncher` keep the plain runner, so a
      runner composed without a master still opens its own connection (asserted).
- [x] Crash residue (a stale socket after an abnormal exit) is recorded as a limit in the owning guide, not cleaned up speculatively.
      Recorded in [Gateway integration](../../../docs/local-integration.md#ssh-prerequisites),
      [Deployment](../../../docs/deployment.md), [Execution-side installation](../../../docs/execution-side-installation.md#the-ssh-transport)
      and [Migration status](../../../docs/migration-status.md), with the check and its raw log in
      [Verification](../../../docs/verification.md#gateway-managed-controlmaster-for-install-and-execution-ticket-07).

**Evidence.** `node --test packages/gateway/test/controlmaster.test.ts` → 0 (9 pass, 0 fail, 0 skipped);
`pnpm --filter @hepi/gateway test` → 0 (149 pass); `pnpm --filter @hepi/gateway typecheck` → 0;
`pnpm --filter @hepi/client typecheck` → 0; `pnpm verify --profile=fast` → 0 (PASS/PASS); logs under
`.dev/verify/ticket-07/`. Baseline probe in the detached worktree `.dev/worktrees/perf-07-red` at `52b0131`:
6 authentications for the publication, 7 after the execution call.

## Review notes

**Review 1 (independent probe, `244ab26`) — material, fixed on this branch.** A public probe of `startGateway`,
`/v1/installs` and `/v1/execute` against a real sshd (`.dev/verify/ticket-07-review/public-probe.log`) found that with a
space anywhere in `HEPI_GATEWAY_DATA` both install and execution failed as `outcome_unknown` after ssh exited 255 before
authenticating, while the same probe on base `52b0131` succeeded. Cause was the owning transport: the socket went out
as `-o ControlPath=<path>`, and ssh re-parses an `-o` value as a configuration line, where the space ends the path
("keyword controlpath extra arguments at end of line"). Fixed in `packages/gateway/src/runner.ts` by passing the socket
as its own argv word, `-S <socket>`, consistently for the execution spawn and for the bounded `ssh -O exit` reap. New
case "a state directory with a space still carries install and execution through one master" run red against the
pre-fix runner (`.dev/verify/ticket-07/red-spaced-directory.log`, exit 1) and green after; the ordinary-directory case
still measures one authentication. The reviewer's public shape was re-run against the fix
(`.dev/verify/ticket-07-review/spaced-probe.ts` → `public-probe-after-fix.log`): `startGateway` with a state directory
named `hepi gateway data …`, `POST /v1/installs` and `POST /v1/execute` both `ok`, **1** authentication for both calls.

**Advisory, recorded not implemented.**

- *Same-account writers.* The 0700 directory excludes other accounts, not processes running as the gateway's own
  account: a same-UID process could in principle connect to or replace the socket. No defence is implemented; impact on
  a single-account workstation is unverified. Recorded in
  [Migration status](../../../docs/migration-status.md#performance-follow-up-ssh-reuse-tickets-06-and-07-delivered).
- *Pid suffix reuse.* The socket name carries the creating pid, which separates concurrent gateways; a pid is not a
  nonce, so a restarted process with a recycled pid could name a socket an earlier crash left behind. `ControlMaster=auto`
  was observed to replace such a stale socket file rather than fail, but the name is not claimed as a restart-isolation
  guarantee. The guides say so plainly; no new naming subsystem was added.
