import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { thirdPartyNoticesPlugin } from "@hepi/ui/lib/third-party-notices";
import { chunkGroups } from "@hepi/ui/lib/vite-chunk-groups";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The build's own version, which names the service worker's cache: a new build installs a new one and the activation
// deletes the caches it replaces. It is read from the package rather than the environment so a local build and a
// released build cannot disagree about which cache they are.
const version: string = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

/**
 * The Web build: a static SPA served by the client-ingress origin.
 *
 * Two things are stated here because only a build can state them. `@` resolves to the shared workbench's own source, so
 * the package's modules keep the import spelling they were extracted with. The static assets the workbench names at
 * runtime — the manifest, the icons, the service worker — are served from `apps/web/public`, which is this host's, not
 * the shared package's: a native App has no service worker and no install prompt.
 */
export default defineConfig({
  root: fileURLToPath(new URL("./src", import.meta.url)),
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  plugins: [react(), tailwindcss(), thirdPartyNoticesPlugin()],
  define: { __WEB_BUILD_VERSION__: JSON.stringify(version) },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    // Cache boundaries, not deferred loading: the groups cut the workbench into separately cacheable chunks. The App
    // build declares the same groups from the same module.
    rolldownOptions: { output: { codeSplitting: { groups: chunkGroups } } },
  },
  server: {
    // The dev server talks to the ingress on the deployment's own origin, so a cookie session behaves as it will in
    // production instead of becoming a cross-origin request.
    proxy: {
      "/api": { target: process.env.HEPI_INGRESS_ORIGIN ?? "http://127.0.0.1:8790", changeOrigin: false },
    },
  },
});
