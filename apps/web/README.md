# Hepi Web host

The Web page is a **Vite single-page app** (`apps/web/src`) that shares one workbench with the desktop App: the React
tree, hooks, styles and pure rules live in `packages/ui`, and `apps/web/src/main.tsx` mounts them with a
`BrowserRouter`, a same-origin (cookie) credential and the browser's own `conversationSource`. The page is served by the
**client ingress**, a Node process that serves `apps/web/dist` and answers `/api` on the same origin
([client ingress](../../docs/client-ingress.md), [client-runtime release](../../docs/client-runtime-release.md)). There is
no Next runtime, no route handler and no server-side adapter in this package.

```bash
pnpm dev                                   # from the repository root: gateway, backend and the Vite page
HEPI_INGRESS_ORIGIN=http://127.0.0.1:8790 pnpm --filter @hepi/web dev   # page only, /api proxied to an ingress
```

`apps/web/vite.config.ts` proxies `/api` to `HEPI_INGRESS_ORIGIN` (default `http://127.0.0.1:8790`) so a cookie session
behaves in development as it does in production. A page with no ingress behind that proxy has no API: every route it
needs belongs to the ingress, and the ingress is what a deployment switches
([the 1873d24 cutover record](../../docs/1873d24-deployment.md)).

## What this package owns, and what it does not

| Piece | Owner |
| --- | --- |
| Page entry, router, service worker, install manifest | `apps/web/src`, `apps/web/public` |
| React tree, hooks, components, styles, pure rules | `packages/ui/src` |
| Browser transport, SSE folding and lifecycle acquisition | `packages/session/src`, `packages/ui/src/lib/durable-projection.ts` |
| `/api` routes, Web login/logout, static serving | `packages/gateway/src/ingress` |
| Conversation records, projections, agent loop | the Backend (`apps/server`) |

The page holds no projection of its own: the Backend's `ServerSnapshot` and delta frames are folded by the shared
client and projected once by `packages/ui/src/lib/durable-projection.ts`. Model selection comes from the Backend's
`GET /api/models`, whose answer states `defaultModel` explicitly (including `null` when the deployment configured
none) — there is no separate default-model route and no client-side default
([providers](../../docs/providers.md)). Login is the ingress's own: `GET /api/web-auth` states whether the page is
gated, `POST /api/web-login` exchanges the login material for the `hepi-web-session` cookie, and `DELETE /api/web-logout`
(`WEB_LOGOUT_PATH` in `@hepi/protocol`) clears it ([client ingress](../../docs/client-ingress.md#the-client-api)).

Features, unserved capabilities and the routes behind them are documented where they live: [chat](../../docs/chat.md),
[workbench](../../docs/workbench.md), [projects](../../docs/projects.md), [MCP on the Web host](../../docs/mcp-on-the-web-host.md),
[execution-side skills](../../docs/execution-side-skills.md), [installation](../../docs/execution-side-installation.md)
and [migration status](../../docs/migration-status.md) for what is deliberately not built. Unsupported operations answer
the ingress's named limits (`501 not_supported`) rather than rendering an inert control.

## Upstream provenance

The shared workbench is adapted from **pi-web 0.10.0** (`76bdc57027172eb381a216d647225a6d24f23360`, MIT, copyright 2026
agegr); `apps/web/LICENSE` keeps that licence, and `packages/ui/THIRD_PARTY_NOTICES.md` is the notice the build copies
into each artifact. [Upstream sources](../../docs/upstream-sources.md) pins every copied version, revision and licence,
and `packages/gateway/vendor/pi-web/` (with a `README.md` naming each file's live consumer) and
`packages/session/vendor/pi-web/` hold the snapshots that still have an executable adaptation.

**Earlier tree, kept as history.** Until ticket 17 this package was a copy of pi-web's Next application: `app/`,
`components/`, `hooks/`, `lib/`, `adapters/` and `vendor/pi-web/` under `apps/web`, with an `app/api/[...path]` route
handler acting as a BFF in front of the Backend. All of it is retired — the page is the Vite build above and the
ingress answers `/api` — so a path from that layout names history, not this tree. The per-file retirement records and
their evidence are in [migration status](../../docs/migration-status.md) and
[upstream sources](../../docs/upstream-sources.md); `DurableLogin` (a Next-app login wrapper) and `/api/durable-login`
describe that retired tree, and both are gone from this one.

## Install, offline and page notifications (ticket 14)

**The Vite page owns its own install surface.** The static build in `apps/web/src` (entry `main.tsx`, build
`vite.config.ts`) is served at the client-ingress origin, and the three files that make it installable live in
`apps/web/public`, which only this host builds: `manifest.webmanifest` (name, start URL `/`, standalone display and the
192/512 icons), `offline.html` and `sw.js`. The entry links the manifest from `index.html` and registers the worker with
`registerServiceWorker` (`src/pwa.ts`) after the first render, under `/sw.js?v=<package version>`, `scope: "/"`. The App
never registers a worker: it mounts the same shared tree from its own entry, and `apps/app/test/bundle-boundary.test.mjs`
asserts that no registration reaches its bundle.

**The worker keeps static assets and nothing private.** It precaches the offline page, the manifest and the icons at
install; navigations go to the network first and fall back to `offline.html` when the ingress cannot answer (bounded by
an 8 s first-byte timeout, because a dead upstream can accept a connection and never reply); Vite's hashed `/assets/`
files are cache-first, which needs no revalidation because one hashed name is one file forever. `/api/` is never
intercepted and never cached — a cache is not scoped to a credential, so a conversation answer produced for one
signed-in browser must not be readable from it by another. The worker installs no `push`, `sync` or `periodicsync`
handler. `sw.js` is versioned by the package version, so a new build installs a new cache and the activation deletes the
one it replaced; nothing is migrated out of an older cache and no older page is kept working.

**The page's completion notice is the only notification, and it follows the lifecycle.** Settings General no longer
offers a "register push" control and no surface asks `/api/push/*`: the Web Push prototype is retired because this
deployment has no push backend to deliver a subscription to. What remains is the in-page notice in
`packages/ui/src/lib/browser-notifications.ts`, raised by `AppShell` only for an answered turn the user was not looking
at — a page in the foreground reports through its transcript and its tone instead — and delivered through the worker's
registration when one exists, or through the page's own `Notification` where it does not. A recovery lookup, a
reconnect, an acquired baseline and a resynchronisation are silent by construction: the lifecycle projection produces
no notice for them. Universal background push stays an explicit non-goal.

The browser seam is `pnpm --filter @hepi/web test:pwa-offline` (a fresh Chromium profile against the production build:
parsed manifest, activated worker, offline navigation, cached hashed asset, uncached API), the worker's own rules are
`apps/web/src/service-worker.test.mjs`, and the manifest/registration agreement is `apps/web/src/pwa.test.mjs`.

## Checks

`pnpm --filter @hepi/web build` emits `apps/web/dist`; `pnpm --filter @hepi/web typecheck` runs both tsconfigs. The
browser journeys are the `test:*` scripts in `apps/web/package.json` (each spawns the production build plus the real
system it needs; see the guide for the surface it drives). The shared unit suites are `pnpm test:web:unit` and
`pnpm --filter @hepi/ui test`; [verification](../../docs/verification.md) states the commands, revisions and recorded
baselines.
