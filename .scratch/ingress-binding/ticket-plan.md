# Ingress Binding — implementation tickets

Status: both tickets integrated and independently reviewed with no material findings; latest integration `17fe24d4` (tested `125a69f1`, identical tree).
Spec: [spec.md](spec.md)

| # | Ticket | Blocked by | Status |
| --- | --- | --- | --- |
| 01 | [Backend-owned workspace locality verdict](issues/01-backend-locality-verdict.md) | [02 Domain handlers](../backend-composition/issues/02-domain-handlers.md), [01 Workspace resolution](../workspace-registry/issues/01-resolution-and-registration.md) | resolved `705717df` |
| 02 | [Ingress consumes locality result](issues/02-ingress-migration.md) | [01 Backend locality verdict](issues/01-backend-locality-verdict.md), [01 Workspace resolution](../workspace-registry/issues/01-resolution-and-registration.md) | resolved `125a69f1` |
