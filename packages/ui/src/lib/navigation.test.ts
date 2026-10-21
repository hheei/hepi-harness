import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import type { WorkbenchNavigation } from "./navigation.ts";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild") as typeof import("esbuild");
const React: typeof import("react") = require("react");
const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
const router: typeof import("react-router") = require("react-router");

const uiRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * The workbench's navigation seam, on both hosts.
 *
 * The workbench states a logical query and a replace-navigate; the host states which history it has. What has to hold is
 * that (a) the two histories give the workbench the same logical query from the address each host really has, and (b)
 * the adapter writes only that query — never a path, never a `#` — so neither the surface nor its caller decides which
 * form the address takes.
 */
const hostRouterBundle: string = buildSync({
  entryPoints: [path.join(uiRoot, "host-router.tsx")],
  bundle: true, write: false, platform: "browser", format: "cjs", jsx: "automatic",
  external: ["react", "react-router"],
  logLevel: "silent",
}).outputFiles[0].text;

/** What the adapter module publishes: the one hook the workbench reads a host navigation through. */
type HostRouterModule = { useHostNavigation(): WorkbenchNavigation };

/** The state the fake history keeps: the address the page is on, and the stack it would navigate. */
type History = {
  /** The address the page is on now. */
  url: URL;
  /** Every address the history holds, oldest first. */
  entries: string[];
  /** The index of the current entry in `entries`. */
  index: number;
};

/** The window React Router is handed: the fake document, which is all its histories actually read. */
type RouterOptions = NonNullable<Parameters<typeof router.UNSAFE_createBrowserHistory>[0]>;
type RouterWindow = NonNullable<RouterOptions["window"]>;

/** The fake document as the window a router takes, which reads only `history`, `location` and the listener pair. */
const routerWindow = (fake: BrowserWindow): RouterWindow => fake as unknown as RouterWindow;

/** A `popstate` notification, as the fake window hands it to every listener it holds. */
type PopStateListener = (event: { readonly type: "popstate" }) => void;

/** The document just complete enough for `history` and `location` to behave as a browser's do. */
type BrowserWindow = {
  readonly location: {
    readonly href: string;
    readonly pathname: string;
    readonly search: string;
    readonly hash: string;
    readonly origin: string;
    assign(next: string | URL): void;
    replace(next: string | URL): void;
  };
  readonly history: {
    readonly state: { readonly idx: number };
    readonly length: number;
    pushState(state: unknown, title: string, next?: string | URL | null): void;
    replaceState(state: unknown, title: string, next?: string | URL | null): void;
    go(delta: number): void;
    back(): void;
    forward(): void;
  };
  readonly document: { readonly location: BrowserWindow["location"]; readonly defaultView: BrowserWindow };
  addEventListener(type: "popstate", listener: PopStateListener): void;
  removeEventListener(type: "popstate", listener: PopStateListener): void;
};

/** A document just complete enough for `history` and `location` to behave as a browser's do. */
function browserWindow(href: string): BrowserWindow {
  const state: History = { url: new URL(href), entries: [new URL(href).href], index: 0 };
  const listeners = new Set<PopStateListener>();
  const notify = (): void => { for (const listener of listeners) listener({ type: "popstate" }); };
  const location: BrowserWindow["location"] = {
    get href() { return state.url.href; },
    get pathname() { return state.url.pathname; },
    get search() { return state.url.search; },
    get hash() { return state.url.hash; },
    get origin() { return state.url.origin; },
    assign(next) { state.url = new URL(next, state.url); notify(); },
    replace(next) { state.url = new URL(next, state.url); notify(); },
  };
  const history: BrowserWindow["history"] = {
    get state() { return { idx: state.index }; },
    get length() { return state.entries.length; },
    pushState(_state, _title, next) {
      state.url = new URL(next ?? state.url.href, state.url);
      state.entries = state.entries.slice(0, state.index + 1).concat(state.url.href);
      state.index = state.entries.length - 1;
      notify();
    },
    replaceState(_state, _title, next) {
      state.url = new URL(next ?? state.url.href, state.url);
      state.entries[state.index] = state.url.href;
      notify();
    },
    go(delta) {
      state.index = Math.max(0, Math.min(state.entries.length - 1, state.index + delta));
      state.url = new URL(state.entries[state.index] as string);
      notify();
    },
    back() { history.go(-1); },
    forward() { history.go(1); },
  };
  const window: BrowserWindow = {
    location, history,
    document: { location, defaultView: undefined as unknown as BrowserWindow },
    addEventListener(type, listener) { if (type === "popstate") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "popstate") listeners.delete(listener); },
  };
  (window.document as { defaultView: BrowserWindow }).defaultView = window;
  return window;
}

/** One search the workbench wrote: the query it asked the host to show, and the router options it gave. */
type Write = { readonly to: { readonly search: string }; readonly options: { readonly replace?: boolean } };

/** The location and navigate the adapter is driven through, as one mount states them. */
type MountOptions = {
  readonly locationSearch: string;
  readonly navigate: (to: { readonly search: string }, options: { readonly replace?: boolean }) => void;
};

/** Load the adapter with a router it can be driven through, and return what the workbench would see. */
function mountAdapter({ locationSearch, navigate }: MountOptions): WorkbenchNavigation {
  const module: { exports: Partial<HostRouterModule> } = { exports: {} };
  const requireStub = (name: string): unknown => (
    name === "react" ? React
      : name === "react-router" ? { useLocation: () => ({ search: locationSearch }), useNavigate: () => navigate }
        : require(name)
  );
  new Function("module", "exports", "require", "window", hostRouterBundle)(
    module, module.exports, requireStub, browserWindow("http://web.test/"),
  );
  const hooks = module.exports as HostRouterModule;
  let seen: WorkbenchNavigation | null = null;
  function Probe(): null {
    seen = hooks.useHostNavigation();
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  assert.ok(seen, "the adapter stated what the workbench sees");
  return seen;
}

test("both histories state the same logical query, from the address each host really has", () => {
  // A Web page's query is in its path; an App's is in the fragment of the document it loaded from disk. React Router's
  // own two histories answer `location.search` from each, and both must answer the same two parameters.
  const web = router.UNSAFE_createBrowserHistory({ window: routerWindow(browserWindow("http://web.test/?session=conv-1&cwd=%2Frepo")) });
  assert.equal(web.location.search, "?session=conv-1&cwd=%2Frepo");
  const app = router.UNSAFE_createHashHistory({ window: routerWindow(browserWindow("file:///bundle/index.html#/?session=conv-1&cwd=%2Frepo")) });
  assert.equal(app.location.search, "?session=conv-1&cwd=%2Frepo", "the App's fragment query is the same logical query");
  // A fragment with no query states none, rather than an empty or inherited one.
  const bare = router.UNSAFE_createHashHistory({ window: routerWindow(browserWindow("file:///bundle/index.html#/")) });
  assert.equal(bare.location.search, "");
  for (const history of [web, app]) {
    const query = new URLSearchParams(history.location.search);
    assert.equal(query.get("session"), "conv-1");
    assert.equal(query.get("cwd"), "/repo");
  }
});

test("the adapter states the router's own search and writes only the logical query, replacing the entry", () => {
  const writes: Write[] = [];
  const seen = mountAdapter({ locationSearch: "?session=conv-2", navigate: (to, options) => { writes.push({ to, options }); } });
  // What the workbench reads is the router's location, unchanged: no parsing, no second source of the current query.
  assert.deepEqual(seen.location, { search: "?session=conv-2" });
  // What it writes is a search string and nothing else. A path or a `#` here would make the surface decide the address's
  // form, which is exactly what the two histories are meant to hide.
  seen.navigate("?session=conv-3");
  assert.deepEqual(writes, [{ to: { search: "?session=conv-3" }, options: { replace: true } }]);
  // An empty search is a statement too — the workspace switch clears the session — and it stays a search-only write.
  seen.navigate("");
  assert.deepEqual(writes[1], { to: { search: "" }, options: { replace: true } });
  assert.equal(writes.every(write => Object.keys(write.to).length === 1 && "search" in write.to), true);
});

test("the workbench reads its query from the location it is handed, not from the page's own address", () => {
  // A packaged App's `window.location.search` is empty: the query lives in the fragment. The hook this seam feeds parses
  // the location value it was given, so the App's fragment query and a Web page's path query are one code path.
  const module: { exports: Partial<HostRouterModule> } = { exports: {} };
  const requireStub = (name: string): unknown => (
    name === "react" ? React
      : name === "react-router" ? { useLocation: () => ({ search: "?session=app-conv&cwd=%2Fhome" }), useNavigate: () => () => {} }
        : require(name)
  );
  new Function("module", "exports", "require", "window", hostRouterBundle)(
    module, module.exports, requireStub, browserWindow("file:///bundle/index.html#/"),
  );
  const hooks = module.exports as HostRouterModule;
  const seen: { parsed: URLSearchParams | null } = { parsed: null };
  function Probe(): null {
    const navigation = hooks.useHostNavigation();
    seen.parsed = new URLSearchParams(navigation.location.search);
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  assert.ok(seen.parsed, "the hook stated a location the case could read");
  assert.equal(seen.parsed.get("session"), "app-conv");
  assert.equal(seen.parsed.get("cwd"), "/home");
});
