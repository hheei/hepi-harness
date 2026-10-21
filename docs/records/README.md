# Dated deployment records

These are historical deployment records. Each one is bound to the revision and date it names, on the hosts as they
were then; none of them establishes current health, current paths or current topology. Read the current owner instead:

- [Deployment](../deployment.md) and the [routine runbook](../deployment-runbook.md) for choosing and shipping a topology.
- [workstation](../local-tailscale-deployment.md#current-local-backend) and [Oracle](../oracle-tailscale-deployment.md)
  for the two hosts as they stand.
- [Migration status](../migration-status.md) for delivered capability and remaining limits.

Records are kept verbatim; their commit references, image digests, host names and roots are evidence of that window.
Where a record is superseded, the successor is named in the record itself.

## Newest first

| Record | Covers |
| --- | --- |
| [1873d24](./1873d24-deployment.md) | Web-origin cutover to the client ingress, 2026-10-18: the ingress replaced the Next container on the same address and port. |
| [cb4494b](./cb4494b-deployment.md) | Split-topology move to `cb4494b`, 2026-10-13: all three roles rebuilt and switched. |
| [f603a48](./f603a48-deployment.md) | Split-topology move to `f603a48`, 2026-10-13: backend and Web UI. |
| [workspace removal](./f603a48-workspace-removal.md) | Same revision and date: the deployment-configured default workspace and its six sessions removed. |
| [0628888e5a85](./0628888e5a85-deployment.md) | Split-topology move to `0628888e5a85`, 2026-10-12: all three roles, plus the browser file-payload capability. |
| [96297fe](./96297fe-deployment.md) | Split-topology move to `96297fe`, 2026-10-12: Web image, and the reverse forward moved to the runtime host's OpenSSH. |
| [19d7cda](./19d7cda-deployment.md) | Split-topology deployment of `19d7cda`, 2026-10-12: backend, Web UI and client bundle. |
| [78078de](./78078de-deployment.md) | Split-topology deployment of `78078de`, 2026-10-11: both halves rebuilt. |
| [39c168d](./39c168d-deployment.md) | Split-topology deployment of `39c168d`: Web image only, backend retagged, gateway untouched. Superseded by `78078de`. |
| [edef2c0](./edef2c0-split-deployment.md) | Split-topology deployment of `edef2c0`, 2026-10-11: Web image only. Superseded by `39c168d`. |

Host-level rollback commands in these records are recorded against that window; current rollback lives in the
[runbook](../deployment-runbook.md#rollback-and-database-restore-are-different-operations).
