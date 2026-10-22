import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { thirdPartyNoticesPlugin } from "@hepi/ui/lib/third-party-notices";
import { chunkGroups } from "@hepi/ui/lib/vite-chunk-groups";
import { fileURLToPath } from "node:url";

/**
 * The App build: the same shared workbench, bundled into the shell.
 *
 * It has no public directory on purpose. The install prompt, the manifest and the service worker are the Web host's, and
 * shipping them inside the App would claim an offline behaviour this build does not implement.
 *
 * `base` is relative because the document is loaded from the bundle's own location rather than served at an origin's
 * root, which is the same reason the App uses a `HashRouter`.
 *
 * The third-party notice is the one static file this build does copy, from `packages/ui`, because the shell embeds the
 * reader `@hepi/ui` bundles into this directory: `frontendDist` above is what carries it into the package.
 */
export default defineConfig({
  root: fileURLToPath(new URL("./src", import.meta.url)),
  base: "./",
  plugins: [react(), tailwindcss(), thirdPartyNoticesPlugin()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    // The same groups the Web build uses: both hosts bundle this one workbench, so they share one chunk policy.
    rolldownOptions: { output: { codeSplitting: { groups: chunkGroups } } },
  },
});
