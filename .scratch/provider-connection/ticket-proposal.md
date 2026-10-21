# Ticket proposal: Provider Connection Management

Status: approved framework; complete. Tickets 01-04 delivered on this lane and ticket 05 implemented with its composed
browser acceptance green (one material finding fixed at its owning seam); its two named limits remain recorded, not
worked around.

| Ticket | Blocked by | Delivery |
| --- | --- | --- |
| [01 - Gateway provider auth and API keys](issues/01-gateway-provider-auth.md) — **done** | None | typed Gateway operation, provider status, secure API-key CRUD |
| [02 - Web auth relay and UI integration](issues/02-web-auth-relay.md) — **done** | 01 | client-ingress `/api/auth/providers` + `/api/auth/api-key/:id` over the host service, no backend credential path |
| [03 - pi-ai interactive login flows](issues/03-pi-ai-login-flows.md) — **done** | 01, 02 | OAuth/device/manual-code flow bridge, TTL, cancellation and reconnect |
| [04 - model availability refresh](issues/04-model-refresh.md) — **done** | 01, 02 | credential-change catalog invalidation; the Backend needs no signal |
| [05 - system acceptance](issues/05-system-acceptance.md) — **implemented** | 02, 03, 04 | one real browser through one composed same-account Pi-mode stack, plus docs and checks closeout |

Ticket 01/02 establish the API-key vertical slice. Ticket 03 adds existing pi-ai interactive auth. Ticket 04 can proceed independently after the relay contract. Loopback OAuth remains optional until topology is confirmed. Ticket 05's composed browser journey has run; interactive OAuth against real upstream endpoints stays out (a host-side provider-registration seam would be needed), and its security-boundary probes are **not authorized for this lane** — the ticket records both.

Branch existence is not acceptance: a merged tip or green unit test does not prove the journey. Ticket 05 observes the real path in a named configuration mode and reports stored state separately from runtime-usable state.

Not tickets, deliberately: provider connection test / model discovery and managed skill uninstall remain deferred decision records in [deferred-decisions.md](deferred-decisions.md).

Cross-effort execution map: [`../ux-closeout-research/spec.md`](../ux-closeout-research/spec.md) (M1/P1/P2, created by parent).
