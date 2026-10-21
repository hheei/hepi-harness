# Web host (`@hepi/web`)

A static Vite single-page build, not a Next application. `src/main.tsx` mounts the shared `@hepi/ui` workbench, and the client ingress serves the build to the browser and answers `/api` on the same origin.

- `src/` — entry, PWA registration, and this package's `*.test.ts` unit suites.
- `public/` — manifest, icons, service worker and offline page served beside the build.
- `e2e/` — headless-Chromium drivers, one `test:<name>` script each, run against the built page and a real Backend: build first with `pnpm --filter @hepi/web build`.
- `vite.config.ts` — root `src/`, `dist/` output, and the dev server's `/api` proxy to the ingress origin.

The package declares no `test` script; the unit suite runs from the repository root as `pnpm test:web:unit`, and `pnpm verify:changed` selects the checks this package participates in. The connected surface and its limits are in [README.md](README.md).
