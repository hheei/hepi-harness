# Real localhost SSH interruption matrix

**Historical record — one finite dated smoke for ticket 06, not a current check.** Its harness lives outside the
repository (`/tmp/hepi-ssh-interruption-smoke.mts`), so this document is the evidence, not a re-runnable CI test. The
measured limits below still describe the runner's contract. Current entrypoints: [docs/verification.md](verification.md).

Finite manual smoke for ticket 06: the production `SshGateway` runner over a real `ssh` process against a temporary
`sshd` on 127.0.0.1. No injected runner, no sleeps or polling: every wait is an output-readiness signal or a FIFO
the remote command blocks on.

- Harness: `/tmp/hepi-ssh-interruption-smoke.mts` (outside the repository, run with `node`).
- Host: OpenSSH_9.6p1, `ssh` and `sshd` from PATH, throwaway ed25519 host/client keys under a temp dir.
- Isolation: temporary `sshd` on port 30422, temp remote root, temp SQLite journal. `~/.ssh` untouched, no remote-host
  or other remote host involved. Cleanup kills the temp `sshd`, the `ssh` children, and removes both temp trees.

Run:

```bash
node /tmp/hepi-ssh-interruption-smoke.mts
```

Observed 10/10 on three consecutive runs.

| # | Case | Observed outcome |
|---|------|------------------|
| 1 | Production runner argv quoting | `printf '%s\n' <10 hostile argv values>` (quotes, `$( )`, backticks, `*`, `~`, newline, tab, backslash, unicode, `--`) round-tripped byte-for-byte, exit 0, and the injected `$(touch …)` file was never created. |
| 2 | Remote command exits 255 | `bash -c 'printf ran > marker; exit 255'` wrote the marker (the command really ran) and was reported `outcome-unknown` with `ssh outcome unknown`. A command's own 255 is indistinguishable from an ssh failure, so it is not reported as a command exit code. |
| 3 | SSH transport failure | A connection to a closed port fails with ssh's own exit 255 and is reported `outcome-unknown`, not `ssh_unreachable`. |
| 4 | Cancellation after readiness | `/v1/abort` after the remote command printed `ready` (FIFO-gated): result `outcome-unknown` (`ssh aborted; remote outcome unknown`), no local `ssh` child left, and the remote pid was still alive when next checked. |
| 5 | Short timeout gated on readiness | `timeoutMs: 800` with readiness observed first: `outcome-unknown` (`ssh timeout; remote outcome unknown`) at 826–837 ms; the remote pid was still alive. |
| 6 | Connection termination mid-call | SIGTERM to the single local `ssh` child after readiness: `outcome-unknown` (`ssh outcome unknown`); the remote command had already started (counter `x`). No remote-termination claim is made. |
| 7 | Reopened persistent journal, same call ID | After case 6 the row is `completed`/`outcome-unknown`; reopening the journal and resubmitting the same call ID returns `outcome-unknown` and the remote counter is unchanged — no replay. |
| 8 | Lost response while the call still runs | Client aborted the HTTP response after the first output frame; a second gateway on the same journal answered the same call ID `outcome-unknown` (`gateway restarted while the call was running`), counter unchanged. |
| 9 | Reconnect after transport loss | A new call over a new SSH connection succeeded (exit 0, `reconnected`). |
| 10 | Spill request over real SSH | `bash` always asks for a spill; over SSH the full output still streams (200 lines, stream matches the result), `spillUnsupported: true`, and no `spillPath` is claimed. |

## Limits (measured, not assumed)

- **Remote termination is never guaranteed.** After cancellation (4) and timeout (5) the remote pid was observed alive.
  Closing the local `ssh` does not prove the remote command stopped, and the gateway never claims it did.
- A command that exits 255, a refused connection, a dropped connection, a timeout, and an abort are all reported
  `outcome-unknown`. `ssh_unreachable` is only produced when `ssh` cannot be spawned at all.
- Duplicate protection is not recovery. The journal prevents a repeat run of a known call ID; it does not resume,
  reconcile, or detect a still-running remote process after a restart.
- The runner uses the workstation's `ssh` from PATH and its existing configuration; the smoke pins port, identity, and
  known-hosts explicitly, so it does not exercise ProxyJump or agent reuse. Connection reuse remains deferred.
- The spill path for local execution is a gateway-local temp file, not a workspace path; over SSH no path is reported.
- SSH filesystem operations (`ssh-filesystem.ts`) share the same "loss is unknown, never retried" rule and are covered
  by the separate filesystem smoke, not here.
