# Tailscale test deployment

Status: complete and verified. User authorized deployment to remote-host and a local Web instance on 2026-10-10.
Application release at that time: df24b7c, integration/execution-resources — a dated pin, not the current deployment.
The live deploy has moved since (local release `51492c4`); see [docs/local-tailscale-deployment.md](../../docs/local-tailscale-deployment.md)
and [docs/oracle-tailscale-deployment.md](../../docs/oracle-tailscale-deployment.md) for current addresses and units.

Both hosts are already members of the user's tailnet. Deploy current backend and Web containers to remote-host,
plus a local Web instance on workstation, sharing the oracle durable backend. Preserve existing conversation database,
provider configuration and authentication tokens. Back up stopped database and WAL sidecars before replacing
the previous backend writer. Keep unrelated workloads unchanged.

| Role | Host | Planned endpoint |
| --- | --- | --- |
| Durable backend | remote-host, ARM64 | loopback 8787, Tailscale Serve HTTPS 8444 |
| Remote Web | remote-host | loopback 30141, Tailscale Serve HTTPS 8443 |
| Local Web | workstation | Tailscale IP <client-host-tailnet-ip>, HTTP 30141 |
| Execution gateway | workstation | loopback 28788, reverse SSH to oracle loopback 18788 |

Local tailscaled refuses Serve configuration for the current account; noninteractive sudo requires a password.
Bind local Web directly to its Tailscale interface so deployment can proceed with existing permissions.
Remote sudo works and Tailscale certificates are enabled. No Funnel or public-interface application exposure.

Use a persistent local fixture workspace under ~/.local/share/hepi/workspace, logical ID integration. Keep
gateway journal durable, and supervise gateway and SSH tunnel via user systemd. Use Docker restart policies for
Web and backend services. Retain old backend unit and backup for rollback, but stop its writer before container starts.

Acceptance: both Web pages accessible across Tailscale; unauthenticated and wrong-token requests fail; authenticated
Web requests proxy the real DeepSeek model catalog; one bounded real DeepSeek turn submitted through local Web SSE
reads exact proof-file bytes from the local gateway, and remote Web sees the same durable conversation.
No registry publishing or changes to tailnet-wide ACLs are required. Record actual endpoints, operational paths,
verification and rollback in deployment docs.
