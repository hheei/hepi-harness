import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { McpResponse, McpServerInfo, McpSignInFlowInfo, McpTestResult } from "@hepi/protocol/mcp-ui";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { McpWorkflow } = await jiti.import<typeof import("./mcp-workflow.ts")>("./mcp-workflow.ts");
type Workflow = import("./mcp-workflow.ts").McpWorkflow;
type Snapshot = import("./mcp-workflow.ts").McpWorkflowSnapshot;

// Behaviour of Settings › MCP's workflow, at the seam the panel uses: every
// readout is one snapshot and every intent is a method. What is under test is
// what the panel would otherwise have to sequence itself — one overview readout
// that a stale answer cannot roll back, each operation's pending/answered/
// failed state with the readback after it, a test beside a change, and a
// sign-in polled by this object's own timers until it ends or is disposed.

const PROJECT = "/repo";
const KEY_DOCS = "global\u0000docs";
const KEY_OAUTH = "global\u0000oauth";

/** One request the workflow made, with the body it carried. */
interface Sent { readonly url: string; readonly method: string; readonly body: unknown }

/** A server as GET /api/mcp lists one. */
const server = (name: string, extra: Partial<McpServerInfo> = {}): McpServerInfo => ({
  name,
  scope: "global",
  sourcePath: "/home/me/.pi/agent/mcp.json",
  configKey: name + "-key",
  enabled: true,
  validated: true,
  envNames: [],
  headerNames: [],
  command: "npx",
  args: ["-y", name],
  usesOAuth: false,
  commandFields: [],
  variableReferences: [],
  masked: false,
  ...extra,
});

/** The overview the routes answer with, listing exactly the servers given. */
const overview = (servers: McpServerInfo[]): McpResponse => ({
  mcp: { available: true },
  codemode: { sandbox: { state: "available" }, builtinDisabled: false, preference: "automatic" },
  files: [
    { scope: "global", path: "/home/me/.pi/agent/mcp.json", exists: true, problems: [] },
    { scope: "project", path: PROJECT + "/.pi/mcp.json", exists: true, problems: [] },
  ],
  servers,
  project: { cwd: PROJECT, trust: { requiresTrust: true, trusted: true, decision: true, decisionPath: PROJECT, inherited: false } },
});

const flow = (phase: McpSignInFlowInfo["phase"], extra: Partial<McpSignInFlowInfo> = {}): McpSignInFlowInfo =>
  ({ flowId: "f1", scope: "global", name: "oauth", configKey: "oauth-key", phase, expiresInMs: 60_000, ...extra });

const tested = (state: McpTestResult["state"], testedAt: number): McpTestResult =>
  ({ state, testedAt, toolCount: 2, durationMs: 40, tools: [] });

const answer = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A request's route: its path, without the folder or server a query names. */
const pathOf = (url: string) => url.split("?")[0];

/**
 * The routes this workflow asks, with what the test decides each one says.
 *
 * `hold()` keeps the next answer of one route open, so a test can make an
 * answer arrive after something that supersedes it — the case the panel's
 * request counter exists for.
 */
function backend(initial: McpResponse) {
  const sent: Sent[] = [];
  const held = new Map<string, { answer: (body: unknown, status?: number) => void }[]>();
  const timers: { run: () => void; cancelled: boolean; fired: boolean }[] = [];
  const state = {
    overview: initial,
    /** The answer of the next POST /api/mcp, when it is not the overview plus what it wrote. */
    action: undefined as unknown,
    test: undefined as unknown,
    signInPhase: "authorize" as McpSignInFlowInfo["phase"],
  };
  let now = 1_000_000;
  const route = (key: string): unknown => {
    switch (key) {
      case "GET /api/mcp": return state.overview;
      case "GET /api/mcp/sign-in/f1": return flow(state.signInPhase);
      case "POST /api/mcp/sign-in": return flow("connecting");
      case "POST /api/mcp/test": return state.test;
      case "POST /api/mcp": return state.action;
      default: return undefined;
    }
  };
  const send: import("./mcp-config-helpers.ts").FetchLike = async (input, init) => {
    const url = input;
    const method = init?.method ?? "GET";
    sent.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    // A route is its method and path: the overview carries the folder as a query, and what a test holds or counts is
    // about the route rather than about one folder or one server.
    const key = method + " " + pathOf(url);
    const queue = held.get(key);
    if (queue && queue.length > 0) {
      const hold = queue.shift()!;
      return await new Promise<Awaited<ReturnType<import("./mcp-config-helpers.ts").FetchLike>>>((resolve) => {
        hold.answer = (body, status) => resolve(answer(body, status ?? 200));
      });
    }
    const body = route(key);
    return body === undefined ? answer({ error: "the test backend answers no other route" }, 501) : answer(body);
  };
  return {
    sent,
    state,
    send,
    now: () => now,
    /** Hold the next answer of one route open, for the test to release when it chooses. */
    hold(key: string) {
      const queue = held.get(key) ?? [];
      const entry = { answer: (_body: unknown, _status?: number) => {} };
      queue.push(entry);
      held.set(key, queue);
      return entry;
    },
    timers,
    /** The workflow's clock, and the timers it set: one step of both is one deadline passing. */
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((entry) => !entry.cancelled && !entry.fired)) {
        timer.fired = true;
        timer.run();
      }
    },
    setTimer(run: () => void) {
      const timer = { run, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    /** The timers still armed: neither run nor released. */
    liveTimers: () => timers.filter((entry) => !entry.cancelled && !entry.fired),
    /** The requests made to one route, by path and method. */
    requests: (method: string, path: string) => sent.filter((entry) => entry.method === method && pathOf(entry.url) === path),
  };
}

function workflowOf(stub: ReturnType<typeof backend>, extra: Partial<import("./mcp-workflow.ts").McpWorkflowOptions> = {}) {
  return new McpWorkflow({
    cwd: PROJECT,
    send: stub.send,
    now: stub.now,
    timers: {
      set: (run) => stub.setTimer(run),
      clear: (handle) => { (handle as { cancelled: boolean }).cancelled = true; },
    },
    ...extra,
  }) as Workflow;
}

/** Let the promises the workflow is waiting on run to their answers. */
const settle = async (rounds = 10) => { for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
const listed = (snapshot: Snapshot) => snapshot.overview.state === "loaded" ? snapshot.overview.data.servers : [];
const selectedOf = (snapshot: Snapshot) => snapshot.selected;

test("the overview's readout keeps the remembered row, and a refused read is unread rather than empty", async () => {
  const stub = backend(overview([server("docs"), server("notes")]));
  const workflow = workflowOf(stub, { initialSelection: KEY_DOCS });
  assert.equal(workflow.getSnapshot().overview.state, "loading", "nothing is claimed before the read answers");
  await workflow.refresh();
  assert.equal(selectedOf(workflow.getSnapshot()), KEY_DOCS, "the remembered row survives a load");
  assert.deepEqual(listed(workflow.getSnapshot()).map((entry) => entry.name), ["docs", "notes"]);

  const refused = stub.hold("GET /api/mcp");
  const reading = workflow.refresh();
  assert.equal(workflow.getSnapshot().refreshing, true, "a read on its way is stated");
  refused.answer({ error: "no host service", code: "mcp_unavailable" }, 503);
  await reading;
  const failed = workflow.getSnapshot();
  assert.equal(failed.refreshing, false);
  assert.equal(failed.overview.state, "failed", "a refused read is unread, not an empty listing");
  assert.equal(failed.overview.state === "failed" ? failed.overview.error.code : undefined, "mcp_unavailable");
  workflow.dispose();
});

test("a change's own answer replaces the listing, and a read already on its way cannot roll it back", async () => {
  const stub = backend(overview([server("docs")]));
  const workflow = workflowOf(stub);
  await workflow.refresh();

  // A read is out — a Refresh, or a load from the panel's mount — and a change is answered first.
  const stale = stub.hold("GET /api/mcp");
  const staleRead = workflow.refresh();
  const switching = stub.hold("POST /api/mcp");
  const change = workflow.setServerEnabled(listed(workflow.getSnapshot())[0], false);
  await settle();
  assert.equal(workflow.getSnapshot().busy, "switch:" + KEY_DOCS, "the change is pending while it is on its way");
  switching.answer(overview([server("docs", { enabled: false })]));
  await change;
  assert.equal(workflow.getSnapshot().busy, null, "and nothing is pending once it answered");
  assert.deepEqual(listed(workflow.getSnapshot()).map((entry) => entry.enabled), [false], "the answer is the listing the route read after the change");

  stale.answer(overview([server("docs", { enabled: true })]));
  await staleRead;
  assert.deepEqual(listed(workflow.getSnapshot()).map((entry) => entry.enabled), [false], "the read sent before the change is dropped when it lands");
  workflow.dispose();
});

test("a refused change is never shown as saved: it names the failure and reads the listing again", async () => {
  const stub = backend(overview([server("docs")]));
  const workflow = workflowOf(stub);
  await workflow.refresh();
  const before = stub.requests("GET", "/api/mcp").length;
  const refusing = stub.hold("POST /api/mcp");
  const change = workflow.setServerEnabled(listed(workflow.getSnapshot())[0], false);
  await settle();
  refusing.answer({ error: "the file no longer parses", reason: "unparsable" }, 409);
  await change;
  const failed = workflow.getSnapshot();
  assert.equal(failed.actionError?.key, KEY_DOCS, "the failure belongs to the server it was about");
  assert.equal(failed.actionError?.failure.reason, "unparsable");
  assert.deepEqual(listed(failed).map((entry) => entry.enabled), [true], "the listing still says what the file says, so nothing is shown as saved");
  await settle();
  assert.ok(stub.requests("GET", "/api/mcp").length > before,
    "and the listing is read again, because the file may no longer say what the panel showed");
  workflow.dispose();
});

test("a test runs beside a change, and its answer is kept per server for the entry it tested", async () => {
  const stub = backend(overview([server("docs")]));
  stub.state.test = { configKey: "docs-key", name: "docs", scope: "global", result: tested("connected", stub.now()) };
  const workflow = workflowOf(stub);
  await workflow.refresh();

  const testing = stub.hold("POST /api/mcp/test");
  const pressed = workflow.test(listed(workflow.getSnapshot())[0]);
  assert.equal(workflow.getSnapshot().tests[KEY_DOCS]?.running, true, "a test states that it is running");
  // A change goes out while the test is still out: a test writes no file, so nothing queues behind it.
  const switching = stub.hold("POST /api/mcp");
  const change = workflow.setServerEnabled(listed(workflow.getSnapshot())[0], true);
  await settle();
  assert.equal(workflow.getSnapshot().busy, "switch:" + KEY_DOCS, "the change was not held behind the test");
  testing.answer({ configKey: "docs-key", name: "docs", scope: "global", result: tested("connected", stub.now()) });
  await pressed;
  await settle();
  assert.equal(workflow.getSnapshot().tests[KEY_DOCS]?.running, false);
  assert.equal(workflow.getSnapshot().tests[KEY_DOCS]?.response?.result.state, "connected");

  switching.answer(overview([server("docs")]));
  await change;
  assert.equal(workflow.getSnapshot().tests[KEY_DOCS]?.response?.result.state, "connected",
    "a listing answered after the test does not hide its result");
  workflow.dispose();
});

test("an ended sign-in stops the polling and reads the overview again, once", async () => {
  const stub = backend(overview([server("oauth", { usesOAuth: true })]));
  const workflow = workflowOf(stub);
  await workflow.refresh();
  await workflow.signIn(listed(workflow.getSnapshot())[0]);
  assert.equal(workflow.getSnapshot().signIns[KEY_OAUTH]?.flow?.phase, "connecting");
  assert.equal(stub.liveTimers().length, 1, "a flow under way is polled");

  // The flow moves on with no method call and no render: the workflow's own timer is what asks.
  const polls = stub.requests("GET", "/api/mcp/sign-in/f1").length;
  stub.state.signInPhase = "authorize";
  stub.advance(1_000);
  await settle(14);
  assert.ok(stub.requests("GET", "/api/mcp/sign-in/f1").length > polls, "the flow was asked where it stands");
  assert.equal(workflow.getSnapshot().signIns[KEY_OAUTH]?.flow?.phase, "authorize", "and the panel shows where it is");

  const reads = stub.sent.length;
  stub.state.signInPhase = "done";
  stub.advance(1_000);
  await settle(18);
  assert.equal(workflow.getSnapshot().signIns[KEY_OAUTH]?.flow?.phase, "done", "the ended flow is what the panel shows");
  assert.equal(stub.liveTimers().length, 0, "an ended flow is polled no more");
  assert.ok(stub.sent.slice(reads).some((entry) => entry.method === "GET" && entry.url.startsWith("/api/mcp")),
    "and the overview is read again, for Signed in and the Connection row");
  workflow.dispose();
});

test("a flow whose polls fail is given up after its own time limit, and disposing stops it at once", async () => {
  const stub = backend(overview([server("oauth", { usesOAuth: true })]));
  const workflow = workflowOf(stub);
  await workflow.refresh();
  await workflow.signIn(listed(workflow.getSnapshot())[0]);
  // The route no longer knows the flow: the panel says so instead of polling for ever.
  const gone = stub.hold("GET /api/mcp/sign-in/f1");
  stub.advance(1_000);
  await settle();
  gone.answer({ error: "the flow is unknown", reason: "sign-in-unknown" }, 404);
  await settle(14);
  assert.equal(workflow.getSnapshot().signIns[KEY_OAUTH]?.gone, true, "a flow the server no longer knows reads as gone");
  assert.equal(stub.liveTimers().length, 0, "and nothing is polled for it");

  // A second flow, disposed while its poll is out: the panel asks nothing more and holds no timer.
  await workflow.signIn(listed(workflow.getSnapshot())[0]);
  const pending = stub.hold("GET /api/mcp/sign-in/f1");
  stub.advance(1_000);
  await settle();
  const before = stub.sent.length;
  workflow.dispose();
  pending.answer(flow("authorize"));
  await settle();
  assert.equal(stub.sent.length, before, "a disposed panel asks nothing more");
  assert.equal(stub.liveTimers().length, 0, "and holds no timer");
});

test("a removal offers an undo that expires on the workflow's timer, and undoing selects what it restored", async () => {
  const stub = backend(overview([server("docs"), server("notes")]));
  const workflow = workflowOf(stub);
  await workflow.refresh();

  const removing = stub.hold("POST /api/mcp");
  const removal = workflow.removeServer(listed(workflow.getSnapshot())[0]);
  await settle();
  removing.answer({
    ...overview([server("notes")]),
    undo: { token: "t1", scope: "global", name: "docs", path: "/home/me/.pi/agent/mcp.json", expiresInMs: 60_000 },
  });
  await removal;
  assert.equal(workflow.getSnapshot().undo?.token, "t1", "the removal offers its undo");
  assert.equal(selectedOf(workflow.getSnapshot()), "global\u0000notes", "and the selection follows the listing without it");

  const restoring = stub.hold("POST /api/mcp");
  const undo = workflow.undoRemoval();
  await settle();
  assert.equal(workflow.getSnapshot().undo?.undoing, true, "an undo on its way is stated");
  restoring.answer({ ...overview([server("docs"), server("notes")]), restored: { scope: "global", name: "docs" } });
  await undo;
  assert.equal(workflow.getSnapshot().undo, null, "a worked undo takes its notice away");
  assert.equal(selectedOf(workflow.getSnapshot()), "global\u0000docs", "and selects the server it put back");

  // A second removal that is only left to expire: nothing is written, and the notice goes by itself.
  const again = stub.hold("POST /api/mcp");
  const second = workflow.removeServer(listed(workflow.getSnapshot())[0]);
  await settle();
  again.answer({
    ...overview([server("notes")]),
    undo: { token: "t2", scope: "global", name: "docs", path: "/home/me/.pi/agent/mcp.json", expiresInMs: 60_000 },
  });
  await second;
  assert.equal(workflow.getSnapshot().undo?.token, "t2");
  stub.advance(60_000);
  await settle();
  assert.equal(workflow.getSnapshot().undo, null, "the notice expires on its own timer, with nothing written");
  workflow.dispose();
});

test("an Add selects and tests what it wrote, and a folder whose trust it changed is handed to the page", async () => {
  const stub = backend(overview([server("docs")]));
  const trusted: string[] = [];
  const workflow = workflowOf(stub, { onProjectTrustChanged: (folder, status) => trusted.push(folder + " " + String(status.decision)) });
  await workflow.refresh();
  stub.state.action = {
    ...overview([server("docs"), server("added")]),
    added: { scope: "global", name: "added", path: "/home/me/.pi/agent/mcp.json" },
    trust: { requiresTrust: true, trusted: true, decision: true, decisionPath: PROJECT, inherited: false },
  };
  stub.state.test = { configKey: "added-key", name: "added", scope: "global", result: tested("needs-auth", stub.now()) };
  const submitted = stub.hold("POST /api/mcp");
  const adding = workflow.add({
    action: "add",
    text: "npx -y added",
    values: {},
    server: 0,
    name: "added",
    scope: "global",
    rawPi: false,
  });
  await settle();
  submitted.answer(stub.state.action);
  await adding;
  await settle();
  assert.equal(workflow.getSnapshot().added?.key, "global\u0000added", "the notice names what was written");
  assert.equal(selectedOf(workflow.getSnapshot()), "global\u0000added", "and the new server is selected");
  assert.ok(stub.requests("POST", "/api/mcp/test").length === 1, "the new server is tested once");
  assert.deepEqual(trusted, [PROJECT + " true"], "the folder's trust is handed to the page");
  workflow.dispose();
});
