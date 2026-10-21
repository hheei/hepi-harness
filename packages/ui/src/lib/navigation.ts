import { createContext, useContext } from "react";
import type { FileSaveHost } from "./file/file-save";

/**
 * The logical location the workbench navigates by, stated the way a router's own hooks would state it.
 *
 * The two hosts differ in one way that matters: a Web page's address is a path, and a packaged App's address is a
 * fragment of a document it loaded from disk. React Router's `BrowserRouter` and `HashRouter` already resolve that
 * difference — each hands its children the same `location` and `navigate` — so what the workbench needs is that pair
 * and nothing about which one it got. It is stated here rather than imported from `react-router`, so this package
 * keeps no dependency on the router and its tests can state a location without mounting one.
 *
 * `location.search` is a full search string (`?session=…`), exactly as the DOM and both routers state it, and
 * `navigate` takes a search string the same way. A caller therefore writes `navigate("?session=" + id)` and never
 * assembles a `#` or a path: on the Web that becomes a URL, in the App it becomes a fragment, and neither the workbench
 * nor its callers decides which.
 */
export interface WorkbenchLocation {
  /** The search string of the current location, including the leading `?`, or `""` when there is none. */
  readonly search: string;
}

export interface WorkbenchNavigation {
  readonly location: WorkbenchLocation;
  /** Replace the current entry's search string. The path and the history depth are the host's, not the workbench's. */
  readonly navigate: (search: string) => void;
}

/**
 * What the host states about the client it is running as.
 *
 * The two things a shared surface may not assume: which origin the client ingress answers on (a packaged App is not
 * served from it), and whether the runtime keeps its own copy of a view (a native shell does not). Everything else the
 * workbench needs it reads from the connection scope.
 */
export interface WorkbenchHost {
  /**
   * The client ingress origin this client was admitted to, with no trailing slash, or `""` for a same-origin Web page.
   *
   * A relative address — a read block, a stream — resolves against it. A Web page leaves it empty and the browser's own
   * origin applies, which is also what keeps the httpOnly cookie going to the right place.
   */
  readonly ingressOrigin: string;
  /** Whether this client is the packaged App rather than a Web page. Reported, never guessed from the user agent. */
  readonly kind: "web" | "app";
}

/**
 * What the enclosing host can do for a surface that the surface cannot do itself.
 *
 * One thing lives here and it is the App's: saving a file to a destination the person chose. A Web page does not need it
 * — its download is a navigation the browser performs, and the bytes never enter the page — while a packaged App has no
 * download navigation at all, because its document is a bundle on `tauri://localhost`. The host that has a save path
 * states it here; a host without one states `null`, and a surface then offers the capability it does have instead of a
 * control that would collect a file into memory and call that a save.
 *
 * It is stated by the host rather than reached for from a surface because the save is platform I/O: the destination
 * picker, the file handle and the flush are the shell's, and no module of the shared tree may import one. That is also
 * what keeps the App's bundle boundary intact — the shared tree names an interface, and only `apps/app` implements it.
 */
export interface WorkbenchHostCapabilities {
  /** The native save host, or `null` on a host whose downloads are the browser's own. */
  readonly save: FileSaveHost | null;
}

const NavigationContext = createContext<WorkbenchNavigation | null>(null);
const CapabilitiesContext = createContext<WorkbenchHostCapabilities>({ save: null });

export const WorkbenchNavigationProvider = NavigationContext.Provider;
export const WorkbenchCapabilitiesProvider = CapabilitiesContext.Provider;

/** The router-neutral navigation the enclosing host stated. A surface outside one is a wiring error, not a default. */
export function useWorkbenchNavigation(): WorkbenchNavigation {
  const value = useContext(NavigationContext);
  if (value === null) throw new Error("The workbench is mounted outside a navigation host.");
  return value;
}

/**
 * What the enclosing host can do for a surface: the native save, where this host has one.
 *
 * A surface mounted outside any host gets `{ save: null }` rather than an error: a fixture that mounts one viewer has no
 * shell, and "this host cannot save" is a true answer about it, not a wiring mistake.
 */
export function useWorkbenchHostCapabilities(): WorkbenchHostCapabilities {
  return useContext(CapabilitiesContext);
}

/**
 * The logical query as a `URLSearchParams`, from the location the host stated.
 *
 * It is the one reader of the location's search string, so every caller — the initial navigation, the cwd restore, the
 * session write-back — asks the same question of the same value instead of each parsing `window.location` on its own.
 * The latter is also what a packaged App cannot do: `window.location.search` is empty there, because the query lives
 * in the fragment.
 */
export function useWorkbenchQuery(): URLSearchParams {
  return new URLSearchParams(useWorkbenchNavigation().location.search);
}
