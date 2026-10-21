import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const router = require("react-router");

const uiRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * The workbench's navigation seam, on both hosts.
 *
 * The workbench states a logical query and a replace-navigate; the host states which history it has. What has to hold is
 * that (a) the two histories give the workbench the same logical query from the address each host really has, and (b)
 * the adapter writes only that query — never a path, never a `#` — so neither the surface nor its caller decides which
 * form the address takes.
 */
const hostRouterBundle = buildSync({
  entryPoints: [path.join(uiRoot, "host-router.tsx")],
  bundle: true, write: false, platform: "browser", format: "cjs", jsx: "automatic",
  external: ["react", "react-router"],
  logLevel: "silent",
}).outputFiles[0].text;

/** A document just complete enough for `history` and `location` to behave as a browser's do. */
function browserWindow(href) {
  const state = { url: new URL(href), entries: [new URL(href).href], index: 0 };
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener({ type: "popstate" }); };
  const location = {
    get href() { return state.url.href; },
    get pathname() { return state.url.pathname; },
    get search() { return state.url.search; },
    get hash() { return state.url.hash; },
    get origin() { return state.url.origin; },
    assign(next) { state.url = new URL(next, state.url); notify(); },
    replace(next) { state.url = new URL(next, state.url); notify(); },
  };
  const history = {
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
      state.url = new URL(state.entries[state.index]);
      notify();
    },
    back() { this.go(-1); },
    forward() { this.go(1); },
  };
  const window = {
    location, history,
    addEventListener(type, listener) { if (type === "popstate") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "popstate") listeners.delete(listener); },
  };
  window.document = { location, defaultView: window };
  return window;
}

/** Load the adapter with a router it can be driven through, and return what the workbench would see. */
function mountAdapter({ locationSearch, navigate }) {
  const module = { exports: {} };
  new Function("module", "exports", "require", "window", hostRouterBundle)(
    module, module.exports,
    (name) => (name === "react" ? React
      : name === "react-router" ? { useLocation: () => ({ search: locationSearch }), useNavigate: () => navigate }
        : require(name)),
    browserWindow("http://web.test/"),
  );
  let seen = null;
  function Probe() {
    seen = module.exports.useHostNavigation();
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  return seen;
}

test("both histories state the same logical query, from the address each host really has", () => {
  // A Web page's query is in its path; an App's is in the fragment of the document it loaded from disk. React Router's
  // own two histories answer `location.search` from each, and both must answer the same two parameters.
  const web = router.UNSAFE_createBrowserHistory({ window: browserWindow("http://web.test/?session=conv-1&cwd=%2Frepo") });
  assert.equal(web.location.search, "?session=conv-1&cwd=%2Frepo");
  const app = router.UNSAFE_createHashHistory({ window: browserWindow("file:///bundle/index.html#/?session=conv-1&cwd=%2Frepo") });
  assert.equal(app.location.search, "?session=conv-1&cwd=%2Frepo", "the App's fragment query is the same logical query");
  // A fragment with no query states none, rather than an empty or inherited one.
  const bare = router.UNSAFE_createHashHistory({ window: browserWindow("file:///bundle/index.html#/") });
  assert.equal(bare.location.search, "");
  for (const history of [web, app]) {
    const query = new URLSearchParams(history.location.search);
    assert.equal(query.get("session"), "conv-1");
    assert.equal(query.get("cwd"), "/repo");
  }
});

test("the adapter states the router's own search and writes only the logical query, replacing the entry", () => {
  const writes = [];
  const seen = mountAdapter({ locationSearch: "?session=conv-2", navigate: (to, options) => writes.push({ to, options }) });
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
  const module = { exports: {} };
  new Function("module", "exports", "require", "window", hostRouterBundle)(
    module, module.exports,
    (name) => (name === "react" ? React
      : name === "react-router" ? { useLocation: () => ({ search: "?session=app-conv&cwd=%2Fhome" }), useNavigate: () => () => {} }
        : require(name)),
    browserWindow("file:///bundle/index.html#/"),
  );
  let parsed = null;
  function Probe() {
    const navigation = module.exports.useHostNavigation();
    parsed = new URLSearchParams(navigation.location.search);
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  assert.equal(parsed.get("session"), "app-conv");
  assert.equal(parsed.get("cwd"), "/home");
});
