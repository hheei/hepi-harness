# Ticket proposal: cross-conversation references

**Status:** **delivered** — every ticket on this line. 01 delivered on `impl/xref-01-target-validation` (`5a963cd`) and
its contract is **on this line** as `9aacab4` from a separately cut branch whose tree is byte-identical (that branch
itself was not merged); 02 delivered **and integrated** (`impl/xref-02-03` at `c986a56`, cherry-picked onto
`client-app-integration` as `6191f82` with its record at `42dcbc3`); 03 **accepted at `0a3d065`** and **re-run on the integration line at `0acf499`**, where its three
journeys — the real ingress→Backend create/reload/follow, the inherited-fork-entry follow and a real transient read
failure with its retry — ran and passed in `apps/web/e2e/ux-references-acceptance.mjs`. Its history-05 edge was met at
`a0caf5d`.

| Ticket | Blocked by | Delivery |
| --- | --- | --- |
| [01 - target validation contract](issues/01-target-validation-contract.md) — **delivered, on this line as `9aacab4`** | [client-app 17](../client-app/issues/17-retire-next-and-transition-paths.md) (met 2026-10-19; the delivered work touches no retired path — see the ticket) | Backend-owned validation that a reference target and optional entry belong to the target's visible committed fork-aware history, with named outcomes |
| [02 - explicit creation and follow UI](issues/02-creation-and-follow-ui.md) | 01 (resolved), [history 03](../history-navigation-research/issues/03-navigation-jump-coordinator.md) (resolved and integrated) — **delivered and integrated**, `impl/xref-02-03` at `c986a56` cherry-picked onto `client-app-integration` at `6191f82` | Create-reference action and picker, conversation-only default, entry follow through the bounded target coordinator, named failure states |
| [03 - acceptance](issues/03-acceptance.md) | 02 (integrated), [history 05](../history-navigation-research/issues/05-system-acceptance.md) (**met** — delivered and accepted at `a0caf5d`) — **delivered at `0a3d065`, re-run at `0acf499`**: the real ingress→Backend create/reload/follow, the inherited-fork-entry follow and a real transient read failure with its retry all ran and passed in `apps/web/e2e/ux-references-acceptance.mjs` | End-to-end acceptance for create/reload/follow, unavailable targets and entries, bounded entry navigation, no schema or model-tool drift |

Tickets are vertical where practical. 01 settles validation before any UI invents an entry identity. 02 reuses the existing reference owner and the history target coordinator rather than a second navigation path. 03 is an integration gate, not a separate release.

Scope guard: conversation-only references are the default; entry references are optional and chosen from a stable known entry identity. No automatic references on dispatch or fork, no model tool, and no new schema or copied history unless ticket 01 proves material necessity.

Cross-effort context: [spec](spec.md), [research evidence](research.md), `../ux-closeout-research/spec.md`.
