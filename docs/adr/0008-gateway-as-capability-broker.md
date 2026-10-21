# Gateway as a Capability Broker

Status: accepted

Hepi uses three responsibility layers. App and Web own presentation and user interaction. Gateway is an authenticated capability broker: it selects execution environments, routes trusted callers, and owns host capabilities such as files, terminal, SSH, skills, and MCP processes and credentials. Backend is the single durable semantic authority: pi-durable owns conversations, tasks, model configuration and provider authentication, per-user model scope, defaults, and durable model execution semantics. Gateway may perform CPU and network work, and Backend may perform network work; the boundary follows authority, capability, and side-effect ownership rather than hardware or transport categories.

The Gateway may relay Backend requests, but it does not create a second model catalog, durable domain store, or conversation lifecycle. A shared Backend identifies the authenticated caller supplied by Gateway and resolves the caller's account-scoped model view while retaining conversation and model decisions durably. This keeps host-specific execution concerns out of pi-durable while preserving pi-durable's conversation semantics and recovery guarantees.

## Consequences

- Web and App use Gateway as their authenticated entry point.
- Gateway owns environment selection and host-local capabilities; Backend owns durable meaning and model state.
- Model catalog and provider OAuth remain Backend concerns; Gateway transports the request and supplies trusted caller identity.
- New boundaries must be evaluated by authority and side effects, not by whether work appears CPU-bound or network-bound.
- Capability results return through Backend durable seams when they affect conversation state; host operations that are not conversation facts remain Gateway-owned.

## Implementation status (2026-10-20)

The decision above is the target. This section records where the delivered tree stands against it and is not a
revision of it: the text above keeps its original wording and intent, and a divergence recorded here stays a divergence
until a later ADR decides otherwise.

**Entry: one seam, named differently.** The decision says clients use the Gateway as their entry point. The delivered
system interposes the **client ingress** — one listener that admits a Web session cookie or a device bearer and calls
the Backend with its own service credential. This is a clarification of the same seam rather than a different one: the
ingress is the Gateway's client-facing listener in `packages/gateway/src/ingress/`, composed in the same process when a
deployment runs them together. Two names, one boundary, and the Gateway's answer to a client is unchanged.

**Provider authentication: the tree diverges, and the decision is unchanged.** The decision places model catalog and
provider OAuth on the Backend. What the tree does today:

- The **Gateway performs provider authentication**. A person's API key or sign-in flows through the client ingress to the
  local Gateway, which writes its own agent directory's `auth.json` on that host (`~/.pi/agent`, or that host's
  `PI_CODING_AGENT_DIR`) under a lock with an atomic replace
  (`packages/gateway/src/provider-auth.ts`, `provider-login.ts`). The Backend receives no credential over the wire and
  routes none.
- The **Backend reads its own configured account, and that is the whole of its part**. In `HEPI_CONFIG_SOURCE=pi` mode
  its account is the agent directory it was configured with (`PI_CODING_AGENT_DIR`, else `~/.pi/agent` on the backend
  host). It observes a Gateway-written credential only where that directory and the Gateway's are the same file — same
  account and path, and across two hosts a shared or identically mounted one — because configuration points both at it,
  not because the Gateway pushed anything. In the default environment mode its account is its process environment and an
  in-memory store, and it reads no `auth.json` at all, so a Gateway write on the Web host is not this Backend's concern
  ([providers](../providers.md), [pi config](../pi-config.md)).
- Model **authority** remains the Backend's: it owns the registry, the configured provider set, selection and request
  semantics. Credential **I/O** is the host Gateway's. Neither statement implies the other, and no route or signal makes
  a foreign credential available to a Backend that was not configured with it.

So the accepted split — provider authentication as a Backend concern — is not what ships, and this note does not read the
implementation back into the decision. Which layer should own credential writing is an open question for a future ADR;
the current seam is recorded here so the divergence is visible, dated, and reversible by decision rather than by
attrition.
