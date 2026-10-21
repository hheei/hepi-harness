# Tailscale deployment verification

Dated evidence: measured at application release df24b7c, with deployment docs d2ea496 (local) and 161f074 (oracle).
The live deploy has moved since; current addresses, units and pinned image tags are in
[docs/local-tailscale-deployment.md](../../docs/local-tailscale-deployment.md) and
[docs/oracle-tailscale-deployment.md](../../docs/oracle-tailscale-deployment.md).

| Role | Live endpoint |
| --- | --- |
| Local Web | http://<client-host-tailnet-ip>:30141 |
| Remote Web | https://<runtime-host>.<tailnet>.ts.net:8443 |
| Remote authenticated API | https://<runtime-host>.<tailnet>.ts.net:8444 |
| Gateway | workstation loopback 28788, oracle reverse SSH loopback 18788 |

Remote backend and Web images built and run natively on ARM64, healthy and restart-enabled. Tailscale Serve
exposes only tailnet endpoints. Backend runs as uid/gid 1001 and bind-mounts the existing state directory.
The old backend writer was stopped and disabled before container cutover; its unit and consistent database
backup remain available for rollback. Existing conversations 1 and 8 and their 23 entries were preserved.
Remote verification 10/10 includes auth, real DeepSeek catalog, Web proxy, database integrity and continuity;
restart and rollback drills passed. Native SQLite, node-pty and QuickJS were exercised in the ARM64 container.

Local gateway, SSH tunnel and Web user services are enabled, active and linger-enabled. The packaged client
is installed outside the checkout. The six-row gateway journal was preserved; the fixture workspace was copied
to /home/<client-user>/.local/share/hepi/workspace. Gateway failure/restart and remote-to-local Web reachability passed.

Final verification: 18 HTTP/SSE/model checks across both Web endpoints and one real DeepSeek turn, conversation
60. The model called read on a unique proof file in the local persistent workspace; its tool result and final
answer contained the exact on-disk marker. The remote Web returned the same durable session. The first verifier
assertion mistakenly checked raw name instead of normalized toolName; the saved transcript confirmed success
after correction, with no second paid turn.

Headless Chromium verified both login forms, session 60 rendering, authentication after reload and composer
input. Zero JavaScript page errors on either page. Local isSecureContext is false; remote HTTPS is true.

Tokens remain in mode-600 runtime files, values absent from repo and reports. Human login token is HEPI_AUTH_TOKEN
in /home/<client-user>/.config/hepi/web.env, shared by both Web instances. Local Serve configuration was denied to this
account, so local Web binds its Tailscale IP only and uses tailnet-encrypted HTTP. HTTPS there is optional and
requires local administrator/operator permissions. No public application bind or Funnel was configured.
