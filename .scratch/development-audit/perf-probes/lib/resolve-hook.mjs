import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPackage = pathToFileURL(resolvePath(here, "..", "..", "..", "..", "apps", "server", "package.json")).href;

/** Retry a failed bare import from `apps/server`'s own dependency tree; everything else resolves normally. */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    if (!specifier.startsWith("@") && !/^[a-z]/.test(specifier)) throw error;
    return await next(specifier, { ...context, parentURL: serverPackage });
  }
}
