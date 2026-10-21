# Backend co-location — 2026-10-16

The user requested moving the durable backend to the workstation beside the gateway to simplify testing. Cutover completed at 12:37:53 UTC. This topology/state move preserves the deployed source, independently of ongoing subagent implementation.

## Running artifacts and connections

| Role | Current artifact / connection |
| --- | --- |
| Backend | Source `56ff08f9a3b7bb24839b91c5f9a3a099219e6bbc`, image `hepi-backend:56ff08f-workstation`, linux/amd64 |
| Backend image ID | `sha256:9dd534b6fedaecca0260602a71b543241f8c56d9034c988f9c132d1e771a13c8` |
| Primary Web | Existing `hepi-web:bff1904`, same address and image |
| Gateway | Existing installed release/unit, same process and journal |
| Local path | Web → backend `127.0.0.1:18787` → gateway `127.0.0.1:28788` |
| Remote compatibility | Remote Web/API → remote loopback `8787` → SSH reverse forward → local backend `18787` |
| Former backend | `hepi-oracle-backend-1` stopped; restart policy changed from `unless-stopped` to `no` |

Built only on the workstation from a clean detached checkout of the deployed commit, with frozen dependencies and linux/amd64. The old arm64 image remains available. The new image's architecture/digest and Node v24.22.0 were checked before switching; existing source verification was reused. No product code, model catalog, credentials or gateway implementation was upgraded.

## State and cutover evidence

Online backups were taken before the switch. After confirming all visible conversations idle, the former backend was stopped and final SQLite backups taken. Each backup passed `integrity_check`; transferred files matched SHA-256. Backend agent configuration moved separately with private permissions. Only then was the new writer started on the persistent state mount.

| Durable state | Before / after |
| --- | --- |
| Conversation database | 17 conversations, 1664 entries, 1616 tasks, 30 submissions |
| Project database | 4 projects, 4 project folders, 0 retained bindings |
| Skill repository | 0 bundles, 0 files |
| Other conversation tables | All table row counts identical after startup |

All three live databases passed a second read-only integrity check. The API's same nine non-deleted conversations remained visible. Project payloads and the seven-model catalog matched pre-switch responses exactly.

Backend now runs under enabled user `hepi-backend.service` with a 0600 environment file and a host bind mount for state. Web's dependency changed from the old tunnel to the local backend; its server URL and login token stayed unchanged. Tunnel now carries only remote compatibility. Backend, Web and tunnel are active with zero automatic restarts. Gateway process/unit/environment were preserved without restart. The local execution path no longer depends on SSH.

Read-only smoke: backend missing token 401 / valid token 200; all four workspaces report no host error; a gateway-backed file listing returns 200; primary Web root 200, missing cookie 401, valid cookie 200; remote compatibility API returns 200 and the same conversation IDs; the retained remote Web also returns 200 for its authenticated model list. These checks made no model calls and added no entries/submissions. Remote Web image/container and public-facing mappings were preserved.

Private evidence is indexed under the operator's 0700 migration directory, with original units/env, old container inspection, online/final backup manifests, immutable final database copies, configuration archives, switch and smoke results. Git-ignored operational scripts/logs are in `.dev/deploy/backend-to-workstation-20261016/`; the Docker build log is retained by the originating session. No secret values or host-specific absolute roots are in this record.

Verification command: `node .dev/deploy/backend-to-workstation-20261016/verify.mjs`, exit 0 against the running `56ff08f-workstation` image; raw `.dev/deploy/backend-to-workstation-20261016/smoke.log`, private `smoke.json`. SQLite checks use read-only connections and are recorded in private `live-db-verification.json`. Documentation check reports the same 12 pre-existing scratch links; no new missing guide.

## Operations and rollback

Use [workstation operations](local-tailscale-deployment.md#current-local-backend) and the [runbook](deployment-runbook.md) for current topology. Build local backend updates for amd64, pin the image in its user unit and preserve the state mount. The inspection helper currently probes only through SSH; local runtime SSH is intentionally unset, so use direct unit/image inspection and authenticated smoke for this deployment.

Topology rollback requires stopping the local writer, making and verifying fresh backups of its **current** three databases, transferring those and current backend configuration back to the former runtime host, then restoring saved units, connections and a pinned compatible artifact. Verify the single writer before enabling the remote service. Old remote files/final backups are point-in-time evidence; starting that container directly would abandon writes accepted since cutover. Keep both artifacts and original private unit/env copies available.
