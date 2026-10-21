/**
 * Resolve hook for the audit probes: retry a bare specifier that cannot be resolved from `.scratch/` in
 * `apps/server`'s package context, which is where the workspace's dependencies are installed. Installed by
 * `node --import ./lib/register.mjs`, so no probe script needs a `node_modules` symlink beside it.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./resolve-hook.mjs", pathToFileURL(import.meta.filename));
