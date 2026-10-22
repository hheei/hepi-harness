# Documentation index

Start with the [root quickstart](../README.md#getting-started), [user guide](user-guide.md) or
[developer handbook](developer-handbook.md). Use this index to find the guide that owns a task.
[Migration status](migration-status.md) records delivered capabilities and remaining limits.

## Current topology

```text
App / Web ──device bearer or cookie──► client ingress ──► durable Backend ──► execution gateway
```

The ingress checks client identity, calls the Backend with its service credential and serves the static Web build;
it exposes no internal execution route. The Backend is the single durable runtime/SQLite writer. Execution gateways
own their host's execution, files, terminal, SSH, MCP and provider credentials. Both clients mount `packages/ui`.

Choose topology/credentials in [Deployment](deployment.md), package server roles with [Compose](container-deployment.md),
ship through the [routine runbook](deployment-runbook.md#routine-deployment-default), and package/cut over the Web
origin with [Client-runtime release](client-runtime-release.md). Inspect a live host with runbook stage 1 and the
[workstation](local-tailscale-deployment.md#current-local-backend) or [Oracle](oracle-tailscale-deployment.md) guide.
Dated records below describe their own revision and host; they do not establish current health.

## Develop and use

| Need | Guide |
| --- | --- |
| Get oriented as a developer | [Developer handbook](developer-handbook.md) |
| Understand the implementation layer by layer | [Developer guide](developer-guide.md) |
| Render a caught value as text | [Error message text](error-message-text.md) |
| Go from a checkout to a running development stack | [Onboarding](development/onboarding.md) |
| Diagnose a symptom | [Troubleshooting](development/troubleshooting.md) |
| Use the product: sign in, projects, chat, files, terminal, MCP | [User guide](user-guide.md) |
| Start from a checkout | [Root README](../README.md), [local integration](local-integration.md) |
| Understand ownership and the runtime | [Architecture](architecture.md), [glossary](../GLOSSARY.md), [migration status](migration-status.md) |
| Create local or SSH Projects | [Projects](projects.md) |
| Chat, images and queued input | [Chat](chat.md) |
| Read the Web host | [apps/web README](../apps/web/README.md), [client ingress](client-ingress.md) |
| Build, package and verify the desktop App | [apps/app README](../apps/app/README.md) |
| Build a client-runtime release and cut the Web origin over | [Client-runtime release](client-runtime-release.md) |
| Browse files and inspect changes | [Workbench](workbench.md) |
| Configure, test and sign in to MCP servers, or offer their tools to a conversation | [MCP on the Web host](mcp-on-the-web-host.md) |
| Discover execution-side skills, prompts and context | [Execution-side resources](execution-side-skills.md) |
| Install, update and toggle skills | [Installation](execution-side-installation.md) |
| Configure providers and models | [Providers](providers.md), [backend Pi configuration](pi-config.md) |
| Check supported controls and TODOs | [Migration status](migration-status.md) |
| Connect a client, manage device credentials, read/submit/follow a conversation, and read history/media resources | [Client ingress](client-ingress.md) |
| Run checks | [Verification](verification.md), [performance follow-up verification](perf-follow-up-verification.md) |
| Read what CI verifies, and what it does not | [Continuous integration](ci.md) |

## Deploy and distribute

| Need | Guide |
| --- | --- |
| Choose topology and credentials | [Deployment](deployment.md) |
| Run the Backend and gateway as containers | [Container deployment](container-deployment.md) |
| Run a deployment or a rollback | [Deployment runbook](deployment-runbook.md) |
| Ship a revision through the existing topology | [Routine deployment](deployment-runbook.md#routine-deployment-default) |
| Install gateway CLI | [Client README](../packages/client/README.md) |
| Inspect workstation / Oracle test setup | [workstation](local-tailscale-deployment.md), [Oracle](oracle-tailscale-deployment.md) |
| See dated deployment evidence | [Deployment records](records/README.md) (dated per-record index), [2026-10-14 runtime inspection](../.scratch/development-audit/fixes-deploy-probe.md), [workstation](local-tailscale-deployment.md), [Oracle](oracle-tailscale-deployment.md) |
| Publish the client and packaged artifacts | [Releases](releases.md) |
| Verify installed artifacts | [Distribution smoke](distribution-smoke.md) |

Credential examples are placeholders or local test values. Keep deployed credentials, host mappings, paths and accounts
in git-ignored private configuration. Client login and Backend/gateway authentication are independent. Deployment guides
use `<client-host>` (build/Web/gateway), `<runtime-host>` (Backend), `<client-user>`/`<runtime-user>`,
`<client-host-tailnet-ip>`/`<runtime-host-tailnet-ip>` and `<runtime-host>.<tailnet>.ts.net`; this convention does not
rewrite older tracked history.

## Decisions and agent workflow

| Decision | Record |
| --- | --- |
| One authoritative runtime | [ADR 0001](adr/0001-single-authoritative-durable-runtime.md) |
| Resources follow execution | [ADR 0002](adr/0002-skills-follow-execution-environment.md) |
| Runtime Project registration | [ADR 0003](adr/0003-projects-bind-runtime-registered-workspaces.md) |
| One Project, many folders, one default | [ADR 0004](adr/0004-one-project-many-folders-one-default.md) |
| SSH profile ownership | [ADR 0005](adr/0005-ssh-project-one-profile-explicit-owner.md) |
| Durable submissions | [ADR 0006](adr/0006-durable-submission-lifecycle.md) |
| Lifecycle facts, one projection | [ADR 0007](adr/0007-lifecycle-facts-one-projection.md) |
| Gateway capability broker | [ADR 0008](adr/0008-gateway-as-capability-broker.md) |

ADR 0008 places provider auth in the Backend as its target; the dated implementation note records the shipped host
Gateway ownership. Preserve that distinction when reading the decision.

Workflow: [AGENTS.md](../AGENTS.md), [review policy](agents/review-policy.md), [verification practice](agents/verification.md),
[copy-first integration](agents/copy-first.md), [domain docs](agents/domain.md), [issue tracker](agents/issue-tracker.md).
[Graph navigation](agents/graph-navigation.md) covers the partial AST index and supplemental deep graph; confirm hits
in source. Specs, tickets and review notes live in [local effort records](../.scratch/README.md).

## Client architecture research

Dated design/research records; use [Architecture](architecture.md) and [Client ingress](client-ingress.md) for current ownership:

- [Pilo simplicity review](research/pilo-simplicity-review.md): approved cleanup and client-app tickets 23–25.
- [Architecture and feature inventory](research/app-architecture-and-pilo-study.md): architecture versus later product ideas.
- [Client adaptation](research/hepi-client-architecture-adaptation.md) and [blueprint](research/hepi-client-architecture-blueprint.md):
  source seams, ingress contracts, connection scope and authentication ownership.
- [Implementation spec](../.scratch/client-app/spec.md), [17-ticket plan](../.scratch/client-app/ticket-breakdown.md),
  [gap/pattern review](../.scratch/client-app/review-notes.md): scoped effort records.
- [React routing evidence](research/react-routing-adoption-evidence.md): pinned Router/Vite examples, not performance measurements.
- [Surface design notes](notes/README.md): [subtree control](notes/subtree-control-web-ux.md).

The shared workbench, ingress client identity, device credentials and conversation read/submit/SSE/request-id recovery
are implemented. The [2026-10-18 cutover](records/1873d24-deployment.md) made the Web origin the ingress; ticket 17 retired
Next, BFF adapters, next.config.ts, the hepi-web image and Compose web service. Native journeys beyond the evidenced
desktop target and named capability limits remain open. This private project uses fresh-state direct cutovers;
old-user upgrades, historical-data migration, compatibility and rollback rehearsals are outside its scope.

## Historical evidence and upstream provenance

Records bind to their date/revision. Verify current dependencies, service documentation and deployed health before reuse.

| Evidence | Records |
| --- | --- |
| Upstream versions and licenses | [Upstream sources](upstream-sources.md); vendor snapshots/notices retain attribution |
| Web-origin and Backend moves | [Ingress cutover](records/1873d24-deployment.md) (2026-10-18), [Backend local migration](backend-local-migration-2026-10-16.md) (2026-10-16) |
| Earlier cutovers, newest first | [cb4494b](records/cb4494b-deployment.md), [f603a48](records/f603a48-deployment.md), [0628888e5a85](records/0628888e5a85-deployment.md), [96297fe](records/96297fe-deployment.md), [19d7cda](records/19d7cda-deployment.md), [78078de](records/78078de-deployment.md), [39c168d](records/39c168d-deployment.md), [edef2c0](records/edef2c0-split-deployment.md) |
| Workspace removal | [2026-10-13 record](records/f603a48-workspace-removal.md): configured default workspace and six sessions removed |
| Execution resources | [Validation](execution-resources-validation.md), [real-model smoke](execution-resources-real-model-smoke.md) |
| Coding, SSH and split deployment | [Coding verification](real-model-coding-verification.md), [SSH interruptions](ssh-interruption-verification.md), [initial split verification](split-deployment-verification.md) |
| Submission stall | [Measured diagnosis](../.scratch/submit-stall/diagnosis.md), [integrated record](../.scratch/submit-stall/spec.md#integrated-record) |
| Initial research | [Durable harness](research/durable-harness-upstream-research.md), [Pi Web persistence](research/pi-web-persistence.md), [npm publishing](research/npm-trusted-publishing.md) |
| Retired prototype | [Archive](archive/README.md), [durable harness demo](archive/durable-harness-demo.md), [initial prompt](prompts/PI_DURABLE_HARNESS_AGENT_PROMPT.md) |

The reference deployment in Deployment and host upgrade sections are also dated evidence. The submit-stall diagnosis
records a separate ~300 s idle SSE teardown (BodyTimeoutError); later heartbeat delivery (perf tickets 01/02) closed that
gap. Read [execution-side resources](execution-side-skills.md) and [Verification](verification.md) for current behavior/checks.
