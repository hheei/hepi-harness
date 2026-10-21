# Hepi Harness

Hepi is a personal distributed coding-agent harness: one authoritative
`@earendil-works/pi-durable` backend, a shared React workbench for Web and desktop, and a workstation execution gateway.
Use it to chat with an agent, work in local or SSH projects, browse files, open terminals and grant MCP tools.

See the [user guide](docs/user-guide.md) for workflows and the [documentation index](docs/README.md) for all guides.

This initial public snapshot is sanitized: deployment addresses, hostnames and user paths are examples;
private operational logs and screenshots are replaced with placeholders. Configure your own deployment values.
Historical verification reports describe their original runs; placeholders do not contain the original evidence.

## Getting started

### Requirements

Use Node 24+ for the direct `.ts` entrypoints (verified on Node 26.5.1); the upstream runtime/SQLite requires Node 22.19+.
Use pnpm 12.4.1.

### Run

From the checkout root:

```bash
pnpm install
pnpm dev
```

This starts the execution gateway, backend and Vite Web UI. Backend and gateway use `node --watch`, including imported
workspace sources; Vite hot-reloads the UI. Development SQLite files stay under `.dev/`. Override `PORT`,
`HEPI_GATEWAY_PORT` or `HEPI_DEV_WORKSPACE` through the environment; use `pnpm dev --only=server,web` for a subset.

Start the client ingress in another terminal; `pnpm dev` does not start it:

```bash
HEPI_INGRESS_BACKEND=http://127.0.0.1:8787 \
HEPI_INGRESS_SERVICE_TOKEN=local-server-token \
pnpm --filter @hepi/gateway start:ingress
```

Open http://127.0.0.1:30141. Vite proxies `/api` to the ingress at loopback `8790`; override with `HEPI_INGRESS_ORIGIN`.
For separate processes, gateway/workspace binding and authenticated SSH prerequisites, see
[local integration](docs/local-integration.md) and [client ingress](docs/client-ingress.md).

Configure a model before sending a task: set `HEPI_PROVIDER`/`HEPI_MODEL` and the required base URL/key on the backend,
or define providers in **Settings › Models**. No model is configured by default: the catalog is empty and runs settle
as `no_model`. See [providers](docs/providers.md) and optional [backend Pi configuration](docs/pi-config.md).

## Use and deploy

| Task | Guide |
| --- | --- |
| Sign in, create projects, chat, use files and terminals | [User guide](docs/user-guide.md) |
| Find implementation owners and development commands | [Developer handbook](docs/developer-handbook.md) |
| Install without a source checkout | [npm client](packages/client/README.md) |
| Build and configure the desktop App | [App README](apps/app/README.md) |
| Run the backend with persistent storage and SSH tunnels | [Linux Docker Compose deployment](docs/container-deployment.md) |
| Package and deploy the Web origin | [Client-runtime release](docs/client-runtime-release.md) |
| Publish npm client and GHCR server images | [Version-tag releases](docs/releases.md) |

Web and App connect to the **client ingress**, which admits a Web cookie or device bearer and calls the backend with
its own service credential. The backend owns conversations, tasks and model execution; the execution gateway owns
execution, files, terminals, SSH, MCP and host provider credentials. `packages/ui` is the shared workbench;
`packages/session` handles snapshots/reconnect and `packages/protocol` defines wire contracts.

The Web release is a static directory served by the ingress. First publication requires registry ownership and publisher
binding. For current capabilities, including image submission, queued-message recall and limits on upstream controls,
read [migration status](docs/migration-status.md); copied controls do not establish support.

## Development

```bash
pnpm verify:changed
pnpm verify:changed --base=main --dry-run  # preview checks for branch commits plus local edits
```

Without `--base`, selection covers staged, unstaged and untracked edits against HEAD. Use `--base=<branch-or-SHA>`
for committed branch work or `pnpm verify --profile=fast|full` for broader gates. Add production Web builds and browser
checks when changed behavior needs them. `pnpm -r test` runs package scripts; Web has no general `test` script.
See [verification](docs/verification.md), [CI](docs/ci.md) and [pinned upstream sources/licenses](docs/upstream-sources.md).

## Constraints

One backend writer per deployment; multiple UIs are safe, multiple backends on one database are unsupported.
Outside the dev launcher, SQLite defaults to `apps/server/data/hepi.sqlite`. Services bind loopback by default;
a non-loopback backend requires an explicit token. Use HTTPS/private networking and keep development tokens private.
Hepi is not multi-user SaaS or a shell sandbox: allowing bash permits arbitrary scripts as the gateway user.
