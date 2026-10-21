import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";

const webRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");
// The same resolution the app uses: the modules under test import through the `@/` alias.
const { CompletionDelivery } = await createJiti(import.meta.url, { alias: { "@": webRoot } }).import("../lib/completion-delivery.ts");
// The registry reads the connection's stream; the stream owner here is the real one, so only the socket is synthetic.
const { AgentEventConnection } = await createJiti(import.meta.url, { alias: { "@": webRoot } }).import("@hepi/session/browser");
// A case about the shared catalogue read mounts the real client, so the origin, the credential and the disposal it
// states are the ones production states.
const { createClient } = await createJiti(import.meta.url, { alias: { "@": webRoot } }).import("../client.ts");
// A connection is assembled in one place and its conversation API with it, so the value a mount is inside here is that
// assembly rather than a hand-built lookalike.
const { workbenchConnection } = await createJiti(import.meta.url, { alias: { "@": webRoot } }).import("../lib/workbench-scope.ts");

/**
 * One completion registry over the real stream owner.
 *
 * The registry is a reader of the connection's stream rather than the owner of one, so these cases state the connection
 * the page would hold and only the socket below it is synthetic: the same assembly the shell builds, with the real
 * `AgentEventConnection` and the real fold.
 */
function streamRegistry(t, { createSource, onAnswered = () => {} }) {
  const connection = new AgentEventConnection({ createSource, readinessTimeoutMs: 1000, reconnectDelayMs: 1000, onUnexpectedError: () => {} });
  const delivery = new CompletionDelivery({
    subscribe: (conversationId, listener) => connection.subscribe(conversationId, listener),
    lookup: async () => null,
    onAnswered,
  });
  t.after(() => { delivery.close(); connection.close(); });
  return { delivery, connection };
}
// The remembered view is page memory shared by every mount in this process, so a test states what it starts from.
const cache = await createJiti(import.meta.url, { alias: { "@": webRoot } }).import("../lib/session-view-cache.ts");
/** The connection this mount is inside: every scoped store the hook reaches keys by this same string. */
const TEST_SCOPE = "test|backend|account";
const hookBundle = buildSync({
  entryPoints: [path.join(webRoot, "hooks", "useAgentSession.ts")], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["react"], alias: { "@": webRoot },
}).outputFiles[0].text;
const plain = value => JSON.parse(JSON.stringify(value));
const respond = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const same = (left, right) => Boolean(left && right) && left.length === right.length && left.every((v, i) => Object.is(v, right[i]));
const options = { session: { id: "conv", cwd: "/tmp" }, newSessionCwd: null, newSessionDraftKey: null };
const nativeFrame = ({ revision = 1, projectionId = "P-conv", text = "initial", ...rest } = {}) => ({
  protocol: "hepi.v1", conversationId: "conv", projectionId, revision, run: null, submissions: [], busy: false, partial: "",
  liveTools: [], toolNames: [], extensions: [], liveMessage: undefined,
  settings: { model: null, thinkingLevel: "off" }, queuedMessages: { steering: [], followUp: [] },
  historyRevision: "rev-" + revision, historyHead: "h1", hasMore: true, oldestEntryId: "e" + revision,
  entries: [{ id: "e" + revision, role: "user", text, message: { role: "user", content: text } }],
  failure: null, ...rest,
});

/** One frame as the stream publishes it: the backend's own native payload, under the name the backend gave it. */
const frame = (overrides) => nativeFrame(overrides);

/**
 * One frame's worth of stream, as the browser's transport delivers it: the event name plus the native payload. The
 * hook folds it with the shared reducer and projects the held state, exactly as it does for a real stream.
 */
const streamFrame = (snapshot, event = "snapshot") => ({ type: "frame", sessionId: "conv", event, data: snapshot });
function deferredRead() {
  const pending = Promise.withResolvers();
  return { promise: pending.promise, release: body => pending.resolve(respond(body)) };
}

// Run the actual bundled hook with independent React and transport state per fixture.
function harness(t, responder) {
  const requests = [], sources = [];
  // Every conversation request this hook makes is the connection's own. The client below is the only way to reach the
  // sandbox's `fetch`, so a request recorded without it is a surface that reached around the connection.
  const clientRequests = [];
  let inClient = false;
  let current;
  const react = {
    useState(initial) {
      const mount = current, index = mount.index++;
      if (!(index in mount.slots)) mount.slots[index] = typeof initial === "function" ? initial() : initial;
      return [mount.slots[index], next => {
        const value = typeof next === "function" ? next(mount.slots[index]) : next;
        if (!Object.is(value, mount.slots[index])) { mount.slots[index] = value; mount.dirty = true; }
      }];
    },
    useRef(initial) { const m = current, i = m.index++; return m.slots[i] ?? (m.slots[i] = { current: initial }); },
    useMemo(factory, deps) {
      const m = current, i = m.index++;
      if (!m.slots[i] || !same(m.slots[i].deps, deps)) m.slots[i] = { deps, value: factory() };
      return m.slots[i].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const m = current, i = m.index++;
      if (!m.slots[i] || !same(m.slots[i].deps, deps)) {
        const previous = m.slots[i];
        m.slots[i] = { deps, cleanup: previous?.cleanup, effect };
        m.effects.push(() => { m.slots[i].cleanup?.(); m.slots[i].cleanup = effect(); });
      }
    },
    useLayoutEffect(effect, deps) { return react.useEffect(effect, deps); },
    // The hook reads the connection it is mounted inside. A mount here is a mount inside one scope, so the only context
    // in this closure is that one: the stores the hook reaches are keyed by it, and a case about the cache states the
    // same key.
    createContext: () => ({}),
    // The connection the hook is inside. Its client is the one seam every conversation request, page, submission lookup
    // and lease goes through, so the harness states it as the transport the sandbox's `fetch` answers — the same shape
    // the real client has, with no origin of its own to resolve.
    useContext: () => current.connection,
    useReducer(reducer, initial) { const [value, set] = react.useState(initial); return [value, action => set(previous => reducer(previous, action))]; },
  };
  class Source {
    constructor(url) { this.url = url; this.readyState = 1; sources.push(this); queueMicrotask(() => this.emit({ type: "connected" })); }
    close() { this.readyState = 2; }
    emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  }
  const sandbox = {
    module: { exports: {} }, require: name => name === "react" ? react : require(name), console,
    URLSearchParams, URL, AbortController, DOMException, crypto: globalThis.crypto, queueMicrotask, EventSource: Source,
    document: { visibilityState: "visible", title: "", addEventListener() {}, removeEventListener() {} }, navigator: {},
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    fetch: async (url, init) => {
      const target = String(url), body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ url: target, method: init?.method ?? "GET", body, viaClient: inClient });
      if (target.startsWith("/api/models")) return respond({ models: {}, modelList: [] });
      return responder(target, init, body);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(hookBundle, sandbox);
  const subscribeAgentEvents = (id, listener) => {
    const source = new Source("/api/conversations/" + id + "/events");
    source.onmessage = message => listener(JSON.parse(message.data));
    return { ready: async () => {}, reconnect() {}, release: () => source.close(), continuity: () => null };
  };
  // The connection a mount inside this sandbox holds unless the case states its own. Its client answers the sandbox's
  // `fetch`, so a request recorded without it is a surface that reached around the connection. The value is built once
  // per mount and handed back unchanged: a store or an effect that keys by the connection must see one connection, not
  // a fresh object per render.
  const defaultConnection = () => workbenchConnection({
    origin: "",
    request: (path, init) => {
      clientRequests.push(String(path));
      inClient = true;
      return sandbox.fetch(path, init).finally(() => { inClient = false; });
    },
    // The client's own JSON read, as the real one is built: one request, and a refusal carrying its status.
    readJson: async (path, init) => {
      clientRequests.push(String(path));
      inClient = true;
      const response = await sandbox.fetch(path, init).finally(() => { inClient = false; });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(typeof body.error === "string" && body.error !== "" ? body.error : "HTTP " + response.status);
        error.status = response.status;
        throw error;
      }
      return body;
    },
  }, { profile: "test", backendId: "backend", accountScope: "account" });
  return {
    requests, sources, clientRequests,
    mount(extra = {}, connection = defaultConnection()) {
      let unmounted = false;
      const m = {
        options: { subscribeAgentEvents, ...options, ...extra }, connection, slots: [], index: 0, effects: [], dirty: true, out: null,
        render() {
          current = m; m.index = 0; m.effects = []; m.dirty = false;
          m.out = sandbox.module.exports.useAgentSession(m.options);
          for (const effect of m.effects) effect();
        },
        // StrictMode mounts an effect twice: the same slot is cleaned up and run again. Replaying every effect is that
        // sequence, with the render that installed it left in place.
        replayEffects() {
          for (const slot of m.slots) slot?.cleanup?.();
          for (const slot of m.slots) if (slot?.effect) slot.cleanup = slot.effect();
        },
        unmount() { if (!unmounted) { unmounted = true; for (const slot of m.slots) slot?.cleanup?.(); } },
      };
      t.after(() => m.unmount());
      return m;
    },
    async pump(m) {
      for (let i = 0; i < 60; i++) { if (m.dirty) m.render(); await Promise.resolve(); }
      assert.equal(m.dirty, false, "hook settles");
    },
  };
}
// The reads answer the backend's own native snapshot, which is what the hook now projects; the agent-state fields
// the composer reads are the snapshot's own scalars.
const normal = (url, init) => url.endsWith("/state") ? respond(nativeFrame())
  : url.endsWith("/messages") || url.endsWith("/busy") ? respond({ submissionId: "s1", control: { state: "allowed", revision: 1 } })
    : url === "/api/conversations" && init?.method === "POST" ? respond({ conversationId: "conv" })
      : respond({ success: true, data: { submissionId: "s1" } });

test("real send dispatch recovers by request identity once without resend or completion tone", async (t) => {
  const h = harness(t, (url, init) => {
    if (url.includes("/submissions?")) {
      const requestId = new URL(url, "http://web").searchParams.get("requestId");
      return respond({ protocol: "hepi.v1", conversationId: "conv", submission: {
        protocol: "hepi.v1", conversationId: "conv", submissionId: "s1", requestId, type: "input", status: "done", entryId: "e2", answerId: "a1",
      } });
    }
    return normal(url, init);
  });
  const tones = [];
  const m = h.mount({ onAgentEnd: () => tones.push("end") });
  await h.pump(m);
  await m.out.handleSend("recover this");
  await h.pump(m);
  const sent = h.requests.find(r => r.method === "POST" && r.body?.type === "conversation.submit");
  assert.ok(sent, "actual hook dispatches a prompt");
  assert.equal(m.out.pendingSubmissions.length, 1);
  m.out.handleAgentEventRef.current({ type: "resync", sessionId: "conv" });
  await h.pump(m);
  const lookups = h.requests.filter(r => r.url.includes("/submissions?"));
  assert.equal(lookups.length, 1);
  assert.equal(new URL(lookups[0].url, "http://web").searchParams.get("requestId"), sent.body.requestId);
  assert.deepEqual(plain(m.out.pendingSubmissions), []);
  assert.deepEqual(tones, []);
  assert.equal(h.requests.filter(r => r.method === "POST" && r.body?.type === "conversation.submit").length, 1);
});

test("a receipt that lands after a reconnect's sweep still asks by request identity", async (t) => {
  // The race this covers: the turn is staged and its prompt answer is still in flight when the conversation's stream
  // reconnects. The reconnect's own recovery sweep runs while the turn has no native identity, so it has nothing to
  // ask about; the receipt that follows names one, and by then the conversation may already have settled that
  // submission — the same reconnect delivered the window holding its committed message, while the settlement frame
  // itself was gone. Nothing asks again, so the turn would stay on screen as a permanent pending overlay.
  const prompt = deferredRead();
  const h = harness(t, (url, init) => {
    if (url.includes("/submissions?")) {
      const requestId = new URL(url, "http://web").searchParams.get("requestId");
      return respond({ protocol: "hepi.v1", conversationId: "conv", submission: {
        protocol: "hepi.v1", conversationId: "conv", submissionId: "s1", requestId, type: "input", status: "done", entryId: "e2", answerId: "a1",
      } });
    }
    if (url === "/api/conversations/conv/messages" && init?.method === "POST") return prompt.promise;
    return normal(url, init);
  });
  const tones = [];
  const m = h.mount({ onAgentEnd: () => tones.push("end") });
  await h.pump(m);
  const sending = m.out.handleSend("raced turn");
  await h.pump(m);
  const staged = h.requests.find(r => r.method === "POST" && r.body?.type === "conversation.submit");
  assert.ok(staged, "the hook dispatched a prompt");
  assert.equal(m.out.pendingSubmissions.length, 1, "the turn is staged while its answer is in flight");
  // The stream reconnects and states the window in which the turn is already committed.
  h.sources.at(-1).emit({ type: "connected", sessionId: "conv" });
  h.sources.at(-1).emit(streamFrame(nativeFrame({ revision: 4, entries: [
    { id: "e1", role: "user", text: "raced turn", message: { role: "user", content: "raced turn" } },
    { id: "e2", role: "assistant", text: "answer", message: { role: "assistant", content: "answer" } },
  ] })));
  await h.pump(m);
  assert.equal(m.out.pendingSubmissions.length, 1, "the reconnect's sweep has nothing to ask about while the turn is staged");
  prompt.release({ submissionId: "s1" });
  await sending;
  await h.pump(m);
  const lookups = h.requests.filter(r => r.url.includes("/submissions?"));
  assert.equal(lookups.length, 1, "the receipt leaves the turn's own submission as the one question owed");
  assert.equal(new URL(lookups[0].url, "http://web").searchParams.get("requestId"), staged.body.requestId);
  assert.deepEqual(plain(m.out.pendingSubmissions), []);
  assert.equal(m.out.statusPhase, null, "recovery clears Preparing along with the stale message");
  assert.equal(h.requests.filter(r => r.method === "POST" && r.body?.type === "conversation.submit").length, 1, "nothing is resent");
  assert.deepEqual(tones, [], "a recovery is not a completion");
});

test("a fresh composer's own stream handshake leaves its receipt owing the same question", async (t) => {
  // The same race on the path a new composer takes: creating the conversation, joining its stream and dispatching the
  // prompt all happen before any receipt exists. The handshake's recovery sweep therefore runs while the turn is
  // staged and asks nothing; the receipt is what gives it an identity, and the settlement may already have happened.
  const prompt = deferredRead();
  const h = harness(t, (url, init) => {
    if (url === "/api/conversations" && init?.method === "POST") return respond({ conversationId: "fresh" });
    if (url.includes("/submissions?")) {
      const requestId = new URL(url, "http://web").searchParams.get("requestId");
      return respond({ protocol: "hepi.v1", conversationId: "fresh", submission: {
        protocol: "hepi.v1", conversationId: "fresh", submissionId: "s9", requestId, type: "input", status: "done", entryId: "e2", answerId: "a1",
      } });
    }
    if (url === "/api/conversations/fresh/messages" && init?.method === "POST") return prompt.promise;
    return normal(url, init);
  });
  const m = h.mount({ session: null, newSessionCwd: "/tmp", newSessionDraftKey: "fresh" });
  await h.pump(m);
  const sending = m.out.handleSend("first prompt");
  await h.pump(m);
  const staged = h.requests.find(r => r.method === "POST" && r.body?.type === "conversation.submit");
  assert.ok(staged, "the new composer dispatched a prompt");
  assert.equal(m.out.pendingSubmissions.length, 1);
  // The stream this composer just joined states the window in which the turn is already committed: the user entry and
  // its answer are both there, and the settlement frame that said so was the one this attachment never saw.
  h.sources.at(-1).emit(streamFrame({ ...nativeFrame({ revision: 4, entries: [
    { id: "e1", role: "user", text: "first prompt", message: { role: "user", content: "first prompt" } },
    { id: "e2", role: "assistant", text: "answer", message: { role: "assistant", content: "answer" } },
  ] }), conversationId: "fresh" }));
  await h.pump(m);
  assert.equal(m.out.pendingSubmissions.length, 1, "the committed window alone does not settle a staged turn");
  prompt.release({ submissionId: "s9" });
  await sending;
  await h.pump(m);
  const lookups = h.requests.filter(r => r.url.includes("/submissions?"));
  assert.equal(lookups.length, 1, "the receipt asks about its own submission exactly once");
  assert.equal(new URL(lookups[0].url, "http://web").searchParams.get("requestId"), staged.body.requestId);
  assert.deepEqual(plain(m.out.pendingSubmissions), [], "the turn settles from its own record");
  assert.equal(m.out.statusPhase, null, "the fresh composer no longer displays Preparing");
  assert.equal(h.requests.filter(r => r.method === "POST" && r.body?.type === "conversation.submit").length, 1);
});

test("creation and follow-up refusals restore text and attachments exactly once", async (t) => {
  for (const kind of ["creation", "follow-up"]) {
    const h = harness(t, (url, init) => {
      if (url === "/api/conversations" && init?.method === "POST") return respond({ error: "unavailable" }, 503);
      // Both admission routes refuse the same way: an immediate send goes to `/messages`, a queued one to `/busy`.
      if ((url.endsWith("/messages") || url.endsWith("/busy")) && init?.method === "POST") return respond({ error: "bad image", code: "prompt_rejected", accepted: false }, 400);
      return normal(url);
    });
    const restored = [];
    const m = h.mount({
      ...(kind === "creation" ? { session: null, newSessionCwd: "/tmp", newSessionDraftKey: "failed" } : {}),
      chatInputRef: { current: { restoreSubmission: (...args) => restored.push(args) } },
    });
    try {
      await h.pump(m);
      const image = { data: "AQID", mimeType: "image/png", previewUrl: "blob:preview" };
      if (kind === "creation") await m.out.handleSend("keep me", [image]);
      else await m.out.handleFollowUp("keep me", [image]);
      await h.pump(m);
      // The queued admission carries the attachment too: what the surface staged is what the conversation is asked for,
      // so a follow-up cannot be admitted with less than the user wrote.
      if (kind === "follow-up") {
        const queued = h.requests.filter(r => r.method === "POST" && r.url.endsWith("/busy"));
        assert.equal(queued.length, 1, kind);
        assert.deepEqual(plain(queued[0].body.images), [{ type: "image", data: "AQID", mimeType: "image/png" }], kind);
      }
      assert.deepEqual(plain(m.out.pendingSubmissions), [], kind);
      assert.equal(restored.length, 1, kind);
      assert.equal(restored[0][0], "keep me", kind);
      assert.deepEqual(plain(restored[0][1]), [{ data: "AQID", mimeType: "image/png" }], kind);
      // The refusal the Backend stated is what the surface shows, whichever route carried it.
      assert.ok(plain(m.out.notices).some(n => n.type === "error" && n.message.includes(kind === "creation" ? "unavailable" : "bad image")), kind);
    } finally { m.unmount(); }
  }
});

test("a shell draft is refused on every send path with nothing staged, and ordinary turns still go", async (t) => {
  const h = harness(t, (url, init) => normal(url, init));
  const restored = [];
  const m = h.mount({ chatInputRef: { current: { restoreSubmission: (...args) => restored.push(args) } } });
  await h.pump(m);
  const prompts = () => h.requests.filter(r => r.method === "POST" && (r.body?.type === "conversation.submit" || r.url.endsWith("/busy")));

  await m.out.handleSend("!pwd");
  await h.pump(m);
  assert.equal(prompts().length, 0, "an idle shell draft is not dispatched");
  assert.deepEqual(plain(m.out.pendingSubmissions), [], "and nothing is staged for it");
  assert.ok(plain(m.out.notices).some(n => n.type === "warning" && n.message.includes("shell commands")), "the refusal is stated");

  h.sources.at(-1).emit(streamFrame(frame({ revision: 2, busy: true, run: { inputs: ["s1"] },
    submissions: [{ protocol: "hepi.v1", conversationId: "conv", submissionId: "s1", type: "input", status: "placed", entryId: "e2" }] })));
  await h.pump(m);
  assert.equal(m.out.agentRunning, true, "the conversation is busy");

  await m.out.handleSteer("!pwd");
  await m.out.handleFollowUp("!pwd");
  await h.pump(m);
  assert.equal(prompts().length, 0, "a queued shell draft is refused on the steer and the follow-up path alike");
  assert.deepEqual(plain(m.out.pendingSubmissions), [], "and neither stages a turn");

  await m.out.handleSteer("keep going");
  await m.out.handleFollowUp("and this");
  await h.pump(m);
  assert.equal(prompts().length, 2, "ordinary steer and follow-up still reach the host");
  assert.equal(m.out.pendingSubmissions.length, 2);
  assert.deepEqual(restored, [], "the composer kept every refused draft, so nothing had to be put back");
});

test("loaded history survives stream head advances and remount; remount accepts later stream frames", async (t) => {
  const window = (revision, ids, head = "h1") => frame({
    revision, historyHead: head, oldestEntryId: ids[0],
    entries: ids.map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })),
  });
  const h = harness(t, url => {
    if (url.includes("/entries?")) return respond({ protocol: "hepi.v1", conversationId: "conv", oldestEntryId: "e1", hasMore: true,
      entries: ["e1", "e2"].map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
    if (url.endsWith("/state")) return respond(window(1, ["e3", "e4"]));
    return normal(url);
  });
  const first = h.mount();
  await h.pump(first);
  h.sources.at(-1).emit(streamFrame(window(2, ["e5", "e6"], "h2")));
  await h.pump(first);
  await first.out.loadContext("conv", null, "e5");
  await h.pump(first);
  h.sources.at(-1).emit(streamFrame(window(3, ["e6", "e7"], "h2")));
  await h.pump(first);
  assert.deepEqual(plain(first.out.entryIds), ["e1", "e2", "e5", "e6", "e7"]);
  first.unmount();
  const second = h.mount();
  await h.pump(second);
  assert.deepEqual(plain(second.out.entryIds), ["e1", "e2", "e5", "e6", "e7"], "an older bootstrap read cannot erase loaded history");
  h.sources.at(-1).emit(streamFrame(window(4, ["e7", "e8"], "h2")));
  await h.pump(second);
  assert.deepEqual(plain(second.out.entryIds), ["e1", "e2", "e5", "e6", "e7", "e8"], "new mount advances its acquisition sequence");
});

test("a landed target window joins the loaded prefix and never overlaps the accepted window", async (t) => {
  // The history owner's half of ticket 03, asserted where the transcript is decided rather than in the coordinator: a
  // jump's window enters through the same prefix state the sentinel's pages use, so one rule (`decidePrefix`) still says
  // what the reader's history becomes when the window moves. The cut that makes this safe is that an entry the
  // projection's own window carries is never contributed by the prefix — an overlapping prefix fails the prefix rule and
  // would drop every page the reader had loaded, turning a jump into a loss of history.
  const window = (revision, ids, head = "h1") => nativeFrame({
    revision, historyHead: head, hasMore: true, oldestEntryId: ids[0],
    entries: ids.map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })),
  });
  const landed = (ids) => ({
    conversationId: "conv", snapshot: "conv|h1|" + ids.at(-1), scope: "conv|h1", hasOlder: true, hasNewer: true,
    entries: ids.map(id => ({ id, message: { role: "user", content: id } })),
  });
  const h = harness(t, url => url.endsWith("/state") ? respond(window(1, ["e6", "e7"])) : normal(url));
  const m = h.mount();
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e6", "e7"], "the conversation opens on its window");

  m.out.landWindow("conv", landed(["e3", "e4", "e5", "e6", "e7"]));
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e3", "e4", "e5", "e6", "e7"], "the landed span is in history order in front of the window");
  const textOf = (message) => typeof message.content === "string" ? message.content : message.content[0].text;
  assert.deepEqual(plain(m.out.messages.map(textOf)), ["e3", "e4", "e5", "e6", "e7"], "and each landed entry is projected into the message the transcript renders");
  assert.equal(m.out.messages.length, new Set(m.out.entryIds).size, "no entry is contributed twice");

  // Landing the same window again — a retry after a lost answer, or the same block reached twice — changes nothing.
  m.out.landWindow("conv", landed(["e3", "e4", "e5", "e6", "e7"]));
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e3", "e4", "e5", "e6", "e7"], "a repeated landing repeats no history");

  // A landing that names only entries the window already carries contributes nothing, which is the case the coordinator
  // answers without a read for; and a window read for another conversation is refused by the owner, not merged.
  m.out.landWindow("conv", landed(["e6", "e7"]));
  m.out.landWindow("other", landed(["e1", "e2"]));
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e3", "e4", "e5", "e6", "e7"], "a landing of another conversation reaches this transcript as nothing");

  // The one event that ends a loaded prefix: the conversation re-baselines, and history paged *or* landed under the old
  // head is retired rather than mixed into a transcript of two heads.
  h.sources.at(-1).emit(streamFrame(window(2, ["c9", "e7"], "h2")));
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["c9", "e7"], "the re-baselined window states the transcript, and the landed prefix goes with the head it was read under");
});

test("a page loaded under an older head states nothing once the accepted context re-baselines", async (t) => {
  // The reader asks for a page of older history; the page's answer is delayed. While it is in flight the conversation
  // re-baselines — a compaction, the one event that ends a loaded prefix — and the accepted window arrives on the
  // stream. The page then lands: it describes history of a context the conversation has left, so neither the prefix it
  // would prepend, nor its pagination cursor, nor its "no older history" may be published. The synthetic head move here
  // is the wire fact the real backend publishes on a compaction (apps/server/test/history-window.test.ts, "a page never
  // crosses a head marker"); this test does not claim a live compaction ran.
  const older = deferredRead();
  // Both transports answer the backend's own native payload, so the hook must agree about them.
  const native = (revision, ids, head) => nativeFrame({ revision, historyHead: head, hasMore: true,
    oldestEntryId: ids[0], entries: ids.map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
  const window = (revision, ids, head) => frame({ revision, historyHead: head, hasMore: true,
    oldestEntryId: ids[0], entries: ids.map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
  const h = harness(t, url => url.includes("/entries?") ? older.promise
    : url.endsWith("/state") ? respond(native(1, ["e3", "e4"], "h1")) : normal(url));
  const m = h.mount();
  await h.pump(m);
  // The reader pages back under h1, exactly as the scroll sentinel does: the cursor is the accepted window's boundary.
  const paged = m.out.loadContext("conv", null, "e3");
  await h.pump(m);
  // The context re-baselines while the page is in flight: the stream publishes the new head with the window it kept.
  h.sources.at(-1).emit(streamFrame(window(2, ["c9", "e4", "e5"], "h2")));
  await h.pump(m);
  // The page was loaded under h1 and reaches the start of that context, so its own answer says "no older history".
  older.release({ protocol: "hepi.v1", conversationId: "conv", oldestEntryId: "e1", hasMore: false,
    entries: ["e1", "e2"].map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
  assert.equal(await paged, undefined, "the page read reports that it established no page");
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["c9", "e4", "e5"], "the re-baselined window is the transcript; the older context's page is not prepended");
  assert.equal(m.out.historyCursor, "c9", "the paging cursor is the accepted window's own boundary, not the abandoned page's");
  assert.equal(m.out.hasEarlierMessages, true, "the abandoned page's exhaustion does not state the new context's");
  assert.equal(m.out.data.context.oldestEntryId, "c9", "the accepted window keeps its own boundary");
});

test("stale HTTP reads cannot rewind transcript, history, failure or selected model", async (t) => {
  const stale = deferredRead();
  // The agent-state read answers the conversation's own snapshot, so it states what the conversation holds when it is
  // asked — the fresh window here. What must not rewind the surface is the **conversation read** that was taken before
  // it and lands after it: an older window of the same attachment, which the fold refuses.
  const current = nativeFrame({ revision: 2, text: "fresh", historyHead: "h2", failure: { reason: "no_model", message: "fresh failure" }, settings: { model: { provider: "p", modelId: "new" }, thinkingLevel: "high" } });
  // The first conversation read is the one that is held open and answers an older window; the fresh state read that a
  // refused read still takes answers the conversation as it is now.
  let reads = 0;
  const h = harness(t, url => !url.endsWith("/state") ? normal(url) : ++reads === 1 ? stale.promise : respond(current));
  const m = h.mount();
  await h.pump(m);
  const fresh = frame({ revision: 2, text: "fresh", historyHead: "h2", failure: { reason: "no_model", message: "fresh failure" }, settings: { model: { provider: "p", modelId: "new" }, thinkingLevel: "high" } });
  h.sources.at(-1).emit(streamFrame(fresh));
  await h.pump(m);
  // The delayed read answers the backend's own native snapshot, so it is the browser's projection that must refuse it.
  const older = nativeFrame({ text: "stale", failure: null, settings: { model: { provider: "p", modelId: "old" }, thinkingLevel: "off" } });
  stale.release(older);
  await h.pump(m);
  assert.deepEqual(plain(m.out.messages.map(message => message.content)), ["fresh"]);
  assert.equal(m.out.data.revision, 2);
  assert.equal(m.out.data.historyHead, "h2");
  assert.equal(m.out.activeLeafId, "e2");
  assert.deepEqual(plain(m.out.runFailure), { reason: "no_model", message: "fresh failure" });
  assert.equal(m.out.currentModel.modelId, "new");
  assert.equal(m.out.thinkingLevel, "high");
});

test("old independent state answers cannot overwrite a newer window or replacement attachment", async (t) => {
  for (const replaced of [false, true]) {
    const state = deferredRead();
    let reads = 0;
    const h = harness(t, url => !url.endsWith("/state") ? normal(url) : ++reads === 1 ? state.promise : respond(nativeFrame({
      revision: replaced ? 1 : 10, projectionId: replaced ? "Q-conv" : "P-conv", text: "fresh",
      queuedMessages: { steering: ["new"], followUp: [] },
      settings: { model: { provider: "p", modelId: "new" }, thinkingLevel: "high" },
    })));
    const m = h.mount();
    try {
      await h.pump(m);
      const fresh = frame({ revision: replaced ? 1 : 10, projectionId: replaced ? "Q-conv" : "P-conv", text: "fresh", queuedMessages: { steering: ["new"], followUp: [] }, settings: { model: { provider: "p", modelId: "new" }, thinkingLevel: "high" } });
      h.sources.at(-1).emit(streamFrame(fresh));
      await h.pump(m);
      state.release(nativeFrame({ busy: true, settings: { model: { provider: "p", modelId: "old" }, thinkingLevel: "low" } }));
      await h.pump(m);
      assert.equal(m.out.data.projectionId, fresh.projectionId);
      assert.equal(m.out.currentModel.modelId, "new");
      assert.equal(m.out.thinkingLevel, "high");
      assert.deepEqual(plain(m.out.queuedMessages), { steering: ["new"], followUp: [] });
      assert.equal(m.out.streamState.isStreaming, false);
      assert.equal(m.out.statusPhase ?? null, null);
    } finally { m.unmount(); }
  }
});

test("read refusal settles no submitted turn; recovery clears the error and stale stream data stays invisible", async (t) => {
  const h = harness(t, normal);
  const restored = [];
  const m = h.mount({ chatInputRef: { current: { restoreSubmission: (...args) => restored.push(args) } } });
  await h.pump(m);
  await m.out.handleSend("large answer");
  await h.pump(m);
  const source = h.sources.at(-1);
  source.emit({ type: "oversize", sessionId: "conv", reason: "frame_too_large", entryId: "77", bytes: 1922295, revision: 1 });
  await h.pump(m);
  assert.match(String(m.out.error), /frame_too_large/);
  assert.match(String(m.out.error), /77/);
  assert.equal(m.out.pendingSubmissions.length, 1);
  assert.deepEqual(restored, []);
  source.emit(streamFrame(frame({ revision: 2, text: "recovered" })));
  await h.pump(m);
  assert.equal(m.out.error ?? null, null);
  assert.equal(m.out.pendingSubmissions.length, 1);
  source.emit(streamFrame(frame({ revision: 1, text: "old", busy: true,
    run: { inputs: ["s1"] },
    liveMessage: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "pending" },
    liveTools: [{ callId: "c1", name: "bash", status: "running", output: "..." }],
  })));
  await h.pump(m);
  assert.deepEqual(plain(m.out.messages.map(message => message.content)), ["recovered"]);
  assert.deepEqual(plain(m.out.statusPhase), { kind: "preparing" }, "the unanswered local submission still prepares; the stale frame cannot start a run");
  assert.equal(m.out.streamState.streamingMessage ?? null, null);
  assert.deepEqual([...m.out.activeToolResults.keys()], []);
});

test("the foreground reports a live answer once", async (t) => {
  const sources = [], answers = [];
  const { delivery } = streamRegistry(t, {
    createSource(conversationId) {
      const source = { conversationId, readyState: 1, onmessage: null, onerror: null,
        message(event) { this.onmessage?.({ data: JSON.stringify(event) }); }, close() { this.readyState = 2; } };
      sources.push(source);
      queueMicrotask(() => source.message({ type: "connected", sessionId: conversationId }));
      return source;
    },
    onAnswered: notice => answers.push(notice),
  });
  const tones = [];
  const h = harness(t, normal);
  delivery.select("conv");
  delivery.nominate(["conv"]);
  const m = h.mount({
    subscribeAgentEvents: (id, listener) => delivery.subscribe(id, listener),
    onProjectionChange: (id, step) => delivery.handover(id, step),
    onLiveSettlement: notice => { const owner = delivery.settle(notice); if (owner) tones.push("surface"); return owner; },
    onAgentEnd() {},
  });
  await h.pump(m);
  await m.out.handleSend("finish");
  await h.pump(m);
  const submission = { protocol: "hepi.v1", conversationId: "conv", submissionId: "s1", type: "input", entryId: "e2" };
  for (const status of ["placed", "done", "done"]) {
    sources.at(-1).message({ type: "submission", sessionId: "conv", submission: { ...submission, status, ...(status === "done" ? { answerId: "a1" } : {}) } });
    await h.pump(m);
  }
  assert.deepEqual(tones, ["surface"]);
  assert.deepEqual(answers, []);
  m.unmount();
});

test("a new composer releases the stream it acquired before its session prop updates", async (t) => {
  const fresh = harness(t, url => url === "/api/conversations" && url === "/api/conversations" ? respond({ conversationId: "fresh" }) : normal(url));
  const releases = [];
  const composer = fresh.mount({ session: null, newSessionCwd: "/tmp", newSessionDraftKey: "fresh",
    subscribeAgentEvents: () => ({ ready: async () => {}, reconnect() {}, release: () => releases.push("fresh"), continuity: () => null }),
  });
  await fresh.pump(composer);
  await composer.out.handleSend("first prompt");
  await fresh.pump(composer);
  assert.deepEqual(releases, []);
  composer.unmount();
  assert.deepEqual(releases, ["fresh"]);
});

test("a surface joining a stream already in flight shows the window it was handed and continues it", async (t) => {
  // A background watch is already holding the conversation's stream, exactly as it is when the user selects a
  // conversation whose run the poll has been watching.
  const sources = [], answers = [];
  const { delivery } = streamRegistry(t, {
    createSource(conversationId) {
      const source = { conversationId, readyState: 1, onmessage: null, onerror: null,
        message(event) { this.onmessage?.({ data: JSON.stringify(event) }); }, close() { this.readyState = 2; } };
      sources.push(source);
      return source;
    },
    onAnswered: notice => answers.push(notice),
  });
  delivery.nominate(["conv"]);
  sources.at(-1).message({ type: "connected", sessionId: "conv" });
  sources.at(-1).message({ type: "frame", sessionId: "conv", event: "snapshot", data: nativeFrame({ revision: 1, text: "from the stream" }) });
  await new Promise(resolve => setImmediate(resolve));

  // The conversation read is held open, so the only thing that can put the transcript on screen is the stream itself:
  // a reader that had to wait for a read would be a reader that published nothing when the stream moved first.
  const read = deferredRead();
  const h = harness(t, url => url.endsWith("/state") ? read.promise : normal(url));
  delivery.select("conv");
  const m = h.mount({ subscribeAgentEvents: (id, listener) => delivery.subscribe(id, listener) });
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e1"], "the window the stream was holding is on screen before any read answers");
  assert.deepEqual(plain(m.out.messages.map(message => message.content)), ["from the stream"]);
  assert.equal(m.out.data.revision, 1);
  assert.equal(m.out.data.projectionId, "P-conv", "and it is the conversation's own attachment, not an empty one");

  // The next delta continues the handed window instead of replacing it with what the delta alone carried.
  const { entries, ...scalars } = nativeFrame({ revision: 1, text: "from the stream" });
  sources.at(-1).message({ type: "frame", sessionId: "conv", event: "state", data: {
    ...scalars, revision: 2, baseRevision: 1, oldestEntryId: "e1", hasMore: true,
    appended: [{ id: "e2", role: "assistant", text: "grown", message: { role: "assistant", content: "grown" } }],
  } });
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e1", "e2"], "the delta extended the transcript rather than replacing it");
  assert.deepEqual(plain(m.out.messages.map(message => message.content)), ["from the stream", "grown"]);
  assert.equal(m.out.data.revision, 2);
  read.release(nativeFrame({ revision: 2, text: "grown" }));
  await h.pump(m);
});


test("a remembered prefix is not restored over a window the stream already advanced past", async (t) => {
  // The bug this covers: the mount joins a stream that is already open — the background watch the poll kept, exactly
  // as the R7 handover leaves it — and that stream states its window before the mount's own reads answer. The
  // remembered view of the previous visit is then adopted, and it belongs to a **head the conversation has left**: the
  // pages the reader had loaded were paged under h1 while the stream is stating h2. Restoring them publishes an older
  // head's entries in front of a newer head's window — a transcript of two heads at once — and stamps the next page
  // read with the older one.
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  const held = deferredRead();
  const window = (revision, ids, head) => nativeFrame({ revision, historyHead: head, hasMore: true,
    oldestEntryId: ids[0], entries: ids.map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
  let later = false;
  const h = harness(t, url => url.includes("/entries?") ? respond({ protocol: "hepi.v1", conversationId: "conv", oldestEntryId: "e1", hasMore: true,
      entries: ["e1", "e2"].map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })) })
    : url.endsWith("/state") ? (later ? held.promise : respond(window(1, ["e3", "e4"], "h1"))) : normal(url));
  const first = h.mount();
  await h.pump(first);
  await first.out.loadContext("conv", null, "e3");
  await h.pump(first);
  assert.deepEqual(plain(first.out.entryIds), ["e1", "e2", "e3", "e4"], "the first visit paged older history in");
  first.unmount();

  // A stream for the same conversation is already open and has stated the re-baselined window before the mount.
  const sources = [];
  const { delivery } = streamRegistry(t, {
    createSource(conversationId) {
      const source = { conversationId, readyState: 1, onmessage: null, onerror: null,
        message(event) { this.onmessage?.({ data: JSON.stringify(event) }); }, close() { this.readyState = 2; } };
      sources.push(source);
      return source;
    },
  });
  delivery.nominate(["conv"]);
  sources.at(-1).message({ type: "connected", sessionId: "conv" });
  sources.at(-1).message({ type: "frame", sessionId: "conv", event: "snapshot", data: window(8, ["e8", "e9"], "h2") });
  await new Promise(resolve => setImmediate(resolve));
  delivery.select("conv");

  later = true;
  const second = h.mount({ subscribeAgentEvents: (id, listener) => delivery.subscribe(id, listener) });
  await h.pump(second);
  assert.deepEqual(plain(second.out.entryIds), ["e8", "e9"], "the accepted window is the transcript; the older head's pages are not restored in front of it");
  assert.equal(second.out.loading, false, "the accepted window is on screen without waiting for the read");
  assert.equal(second.out.data.historyHead, "h2", "the beside facts are the accepted statement's, not the remembered view's");
  assert.equal(second.out.data.revision, 8);
  assert.equal(second.out.hasEarlierMessages, true, "the accepted window's own pagination state is kept");
  assert.equal(sources.length, 1, "adopting the remembered view opens no second stream");

  // The read that was held open answers with the very window the stream stated: it restates it and changes nothing.
  held.release(window(8, ["e8", "e9"], "h2"));
  await h.pump(second);
  assert.deepEqual(plain(second.out.entryIds), ["e8", "e9"]);
  assert.equal(second.out.data.historyHead, "h2", "the head the conversation is on is not rewound by the read either");
});

test("a remembered window and its paged prefix come back when the head has not moved", async (t) => {
  // The other half of the same rule: a remembered view whose head is still the conversation's head is exactly what the
  // cache is for. It is drawn while the mount's reads are still in flight, and the pages the reader had loaded are
  // kept — and migrated — when the window advances, because the head they were loaded under did not move.
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  const window = (revision, ids, head) => nativeFrame({ revision, historyHead: head, hasMore: true,
    oldestEntryId: ids[0], entries: ids.map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
  let later = false;
  const held = deferredRead();
  const h = harness(t, url => url.includes("/entries?") ? respond({ protocol: "hepi.v1", conversationId: "conv", oldestEntryId: "e1", hasMore: true,
      entries: ["e1", "e2"].map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })) })
    : url.endsWith("/state") ? (later ? held.promise : respond(window(1, ["e3", "e4"], "h1"))) : normal(url));
  const first = h.mount();
  await h.pump(first);
  await first.out.loadContext("conv", null, "e3");
  await h.pump(first);
  first.unmount();

  later = true;
  const second = h.mount();
  await h.pump(second);
  assert.deepEqual(plain(second.out.entryIds), ["e1", "e2", "e3", "e4"], "the remembered window and its pages are on screen while the read is in flight");
  assert.equal(second.out.loading, false, "a remembered view is not a loading state");
  assert.equal(second.out.hasEarlierMessages, true);
  assert.equal(second.out.data.historyHead, "h1");

  // The window advances under the same head: the loaded entries the window evicted migrate into the prefix rather
  // than vanishing, and nothing is prepended twice.
  h.sources.at(-1).emit(streamFrame(window(2, ["e5", "e6"], "h1")));
  await h.pump(second);
  assert.deepEqual(plain(second.out.entryIds), ["e1", "e2", "e3", "e4", "e5", "e6"], "the same head keeps the pages the reader had loaded");
  held.release(window(2, ["e5", "e6"], "h1"));
  await h.pump(second);
  assert.deepEqual(plain(second.out.entryIds), ["e1", "e2", "e3", "e4", "e5", "e6"], "the read restating the accepted revision prepends nothing twice");
});


test("one load asks for the conversation's snapshot once, and transcript and composer come from that one answer", async (t) => {
  // The read and the state query answer the same native snapshot, so a load that asked for both sent the same payload
  // twice and projected it twice. What this states is the contract a caller relies on: one snapshot request per load,
  // the transcript and the composer's own fields read from it, and the composer fields only when the answer was the
  // conversation's current statement.
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  const h = harness(t, normal);
  const m = h.mount();
  await h.pump(m);
  const snapshots = () => h.requests.filter(r => r.method === "GET" && r.url === "/api/conversations/conv/state");
  assert.equal(snapshots().length, 1, "the mount reads the conversation once, and asks for no second copy of the same snapshot");
  assert.deepEqual(plain(m.out.entryIds), ["e1"], "the transcript is the accepted snapshot's");
  assert.equal(m.out.data.context.thinkingLevel, "off", "the composer's own level is read from that same answer");
  assert.equal(m.out.agentRunning, false);
  assert.equal(m.dirty, false, "hook settles");
});

test("a load whose read was refused still asks the conversation's own state rather than reusing the older window", async (t) => {
  // The one case the dedup must not swallow. A read the fold called older describes a window the surface has already
  // replaced — here because a stream the page already holds stated a newer one first — so its composer fields are not
  // the conversation's current ones. The fresh state read is the honest answer, exactly as it is for the transcript.
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  const held = deferredRead();
  const reads = [];
  const h = harness(t, url => {
    if (!url.endsWith("/state")) return normal(url);
    reads.push(url);
    return reads.length === 1 ? held.promise : respond(nativeFrame({ revision: 5, settings: { model: null, thinkingLevel: "high" } }));
  });

  // A stream for this conversation is already open and has stated revision 5 before the mount's own read answers.
  const sources = [];
  const { delivery } = streamRegistry(t, {
    createSource(conversationId) {
      const source = { conversationId, readyState: 1, onmessage: null, onerror: null,
        message(event) { this.onmessage?.({ data: JSON.stringify(event) }); }, close() { this.readyState = 2; } };
      sources.push(source);
      return source;
    },
  });
  delivery.nominate(["conv"]);
  sources.at(-1).message({ type: "connected", sessionId: "conv" });
  sources.at(-1).message({ type: "frame", sessionId: "conv", event: "snapshot", data: nativeFrame({ revision: 5, settings: { model: null, thinkingLevel: "high" } }) });
  await new Promise(resolve => setImmediate(resolve));
  delivery.select("conv");

  const m = h.mount({ subscribeAgentEvents: (id, listener) => delivery.subscribe(id, listener) });
  await h.pump(m);
  // The mount's read answers the older window, which the fold refuses; the composer is not handed its settings.
  held.release(nativeFrame({ revision: 1, settings: { model: null, thinkingLevel: "off" } }));
  await h.pump(m);
  assert.equal(m.out.data.revision, 5, "the accepted window is still the stream's");
  assert.equal(m.out.data.context.thinkingLevel, "high", "and the composer states that window's level, not the refused read's");
});


test("the conversation workflow is asked on the connection, never around it", async (t) => {
  // The hook is mounted inside one connection, and every read, page, submission and lease it performs is that
  // connection's request: its Gateway origin and its credential. A caller that reached the global `fetch` instead would
  // ask whatever origin happens to serve the document — the bundle's own, in the App — and present no credential at all.
  const h = harness(t, normal);
  const m = h.mount({ session: { id: "conv", cwd: "/tmp" } });
  await h.pump(m);
  const conversationPaths = h.requests.filter(request => request.url.startsWith("/api/conversations"));
  assert.ok(conversationPaths.length > 0, "the mount read its conversation");
  assert.deepEqual(conversationPaths.filter(request => request.viaClient !== true), [], "every conversation request went through the connection");
  assert.equal(h.clientRequests.filter(path => path.startsWith("/api/conversations")).length, conversationPaths.length, "and the connection is the only way the conversation was asked");
  // The catalogue is the connection's read too: it carries this Gateway's origin and this connection's credential, so a
  // relative `fetch("/api/models")` would be the page's own origin and no credential at all.
  const catalogueReads = h.requests.filter(request => request.url.startsWith("/api/models"));
  assert.ok(catalogueReads.length > 0, "the composer read its catalogue");
  assert.deepEqual(catalogueReads.filter(request => request.viaClient !== true), [], "the catalogue was read around the connection");

  await m.out.handleSend("hello");
  await h.pump(m);
  const submitted = h.requests.filter(request => request.url.endsWith("/messages"));
  assert.deepEqual(submitted.filter(request => request.viaClient !== true), [], "the submission went through the connection too");
  m.unmount();
});

// One connection's catalogue read is held open while a consumer of it comes and goes. The read is the connection's, so
// neither a StrictMode replay of the same composer nor another composer leaving may cancel it: the composer that is
// still showing must be handed the answer, from the one request both of them are waiting on.
for (const scenario of ["StrictMode replay", "another consumer leaving"]) {
  test(`a shared model read survives ${scenario}`, async (t) => {
    const held = Promise.withResolvers();
    let modelReads = 0;
    let requestSignal;
    const client = createClient({
      origin: "https://shared-models.example",
      credential: { kind: "bearer", token: "shared-device" },
      createSource: () => ({ close() {} }),
      fetch: async (url, init) => {
        if (String(url).includes("/api/models")) {
          modelReads++;
          requestSignal = init?.signal;
          await held.promise;
          if (requestSignal?.aborted) throw new DOMException("aborted", "AbortError");
          return respond({ models: { shared: "Shared" }, modelList: [{ provider: "p", id: "shared", name: "Shared" }] });
        }
        return respond(nativeFrame());
      },
    });
    t.after(() => client.dispose());
    const connection = workbenchConnection(client, { profile: "shared", backendId: "backend", accountScope: "account" });
    const h = harness(t, normal);
    const first = h.mount({}, connection);
    first.render();
    let survivor = first;
    if (scenario === "StrictMode replay") first.replayEffects();
    else {
      survivor = h.mount({}, connection);
      await h.pump(survivor);
      first.unmount();
    }
    await h.pump(survivor);
    assert.equal(modelReads, 1, "the consumers share one connection-owned model request");
    assert.equal(requestSignal.aborted, false, "one consumer's exit cancelled the shared read");
    held.resolve();
    await h.pump(survivor);
    assert.deepEqual(plain(survivor.out.modelList.map(model => model.id)), ["shared"], "the surviving composer was not handed the shared answer");
  });
}

test("disposing the connection retires its shared model read and no late answer lands", async (t) => {
  const held = Promise.withResolvers();
  let modelReads = 0;
  let requestSignal;
  const client = createClient({
    origin: "https://disposed-models.example",
    credential: { kind: "bearer", token: "disposed-device" },
    createSource: () => ({ close() {} }),
    fetch: async (url, init) => {
      if (String(url).includes("/api/models")) {
        modelReads++;
        requestSignal = init?.signal;
        await held.promise;
        if (requestSignal?.aborted) throw new DOMException("aborted", "AbortError");
        return respond({ models: { stale: "Stale" }, modelList: [{ provider: "p", id: "stale", name: "Stale" }] });
      }
      return respond(nativeFrame());
    },
  });
  const connection = workbenchConnection(client, { profile: "gone", backendId: "backend", accountScope: "account" });
  const h = harness(t, normal);
  const m = h.mount({}, connection);
  m.render();
  await h.pump(m);
  assert.equal(modelReads, 1, "the composer read its catalogue once");

  // The connection goes away while its catalogue read is on the wire: the read belongs to it, so disposal ends it
  // rather than leaving it to answer into a page that is no longer that connection's.
  client.dispose();
  assert.equal(requestSignal.aborted, true, "disposal left the connection's own read on the wire");
  held.resolve();
  await h.pump(m);
  assert.deepEqual(plain(m.out.modelList), [], "a late catalogue from a disposed connection landed on the composer");
  assert.equal(m.out.modelError, null, "the retired read was reported as a failure of this composer's own load");
});

test("the model catalogue is read through the connection, and cached per connection rather than per folder", async (t) => {
  // The catalogue is read through the real client, so what the assertions see is the origin and the credential a
  // production composer presents: a fetch of a relative /api/models would be the App bundle's own origin and no
  // credential at all. Two connections hold the same folder path and must not share an answer or an in-flight read,
  // because the folder is not what decides whose catalogue it is.
  const seen = [];
  const entry = (provider, id) => ({ id, name: id.toUpperCase(), provider });
  const clientFor = (origin, token, models, hold) => createClient({
    origin,
    credential: { kind: "bearer", token },
    createSource: () => ({ close() {} }),
    fetch: async (url, init) => {
      const target = String(url);
      seen.push({ target, authorization: new Headers(init?.headers).get("authorization") });
      if (target.includes("/api/models")) {
        if (hold) await hold.promise;
        return respond({ models: Object.fromEntries(models.map(model => [model.id, model.name])), modelList: models });
      }
      return target.endsWith("/state") ? respond(nativeFrame()) : respond({});
    },
  });
  const hold = Promise.withResolvers();
  const connectionA = workbenchConnection(clientFor("https://gateway-a.example", "token-a", [entry("alpha", "a1")], hold), { profile: "profile-a", backendId: "backend-A", accountScope: "account-A" });
  const connectionB = workbenchConnection(clientFor("https://gateway-b.example", "token-b", [entry("beta", "b1")], null), { profile: "profile-b", backendId: "backend-B", accountScope: "account-B" });
  t.after(() => { connectionA.client.dispose(); connectionB.client.dispose(); });
  const h = harness(t, normal);
  const session = { id: "conv", cwd: "/work" };
  const readsFor = (origin) => seen.filter(request => request.target.startsWith(origin + "/") && request.target.includes("/api/models"));

  // The first connection's catalogue read is held open, exactly as it is while the user switches connection.
  const first = h.mount({ session }, connectionA);
  await h.pump(first);
  assert.equal(readsFor("https://gateway-a.example").length, 1, "the composer read its catalogue once");
  assert.equal(readsFor("https://gateway-a.example")[0].target, "https://gateway-a.example/api/models?cwd=%2Fwork", "the read resolved against the connection's own Gateway, not the page's");
  assert.equal(readsFor("https://gateway-a.example")[0].authorization, "Bearer token-a", "and presented that connection's own bearer");

  // The page switches to another Backend and account while the first read is still in flight. The new composer asks its
  // own Gateway: it must not join the first connection's request, and the first answer must not land on it.
  const second = h.mount({ session }, connectionB);
  await h.pump(second);
  assert.equal(readsFor("https://gateway-b.example").length, 1, "the second connection joined the first connection's in-flight read");
  assert.equal(readsFor("https://gateway-b.example")[0].authorization, "Bearer token-b");
  hold.resolve();
  await h.pump(first);
  await h.pump(second);
  assert.deepEqual(plain(first.out.modelList.map(model => model.id)), ["a1"]);
  assert.deepEqual(plain(second.out.modelList.map(model => model.id)), ["b1"], "the first connection's late answer landed on the second");

  // The cache is scoped, not shared by folder: each connection is served its own catalogue and neither asks again.
  const again = h.mount({ session }, connectionA);
  await h.pump(again);
  const other = h.mount({ session }, connectionB);
  await h.pump(other);
  assert.equal(readsFor("https://gateway-a.example").length, 1, "the first connection's catalogue did not come from its own cache");
  assert.equal(readsFor("https://gateway-b.example").length, 1, "the second connection's catalogue did not come from its own cache");
  assert.deepEqual(plain(again.out.modelList.map(model => model.id)), ["a1"]);
  assert.deepEqual(plain(other.out.modelList.map(model => model.id)), ["b1"]);
});

/**
 * A read that did not answer is a state the surface can recover from, and the recovery is a read.
 *
 * Three properties are what make the recovery honest, and each is asserted here rather than in the component that draws
 * the panel: the failure is classified (so the surface offers a step that can work), the conversation's own content is
 * not discarded by a read that failed after it was accepted, and a Retry re-reads the conversation instead of resending
 * anything the reader had already sent.
 */
test("a failed read is classified, keeps the accepted window, and Retry re-reads without resending", async (t) => {
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  // The first read answers, the second fails at the transport, and the third answers again: the same mount sees a good
  // conversation, a lost read, and the recovery from it.
  let stateReads = 0;
  let failNext = false;
  const h = harness(t, (url, init) => {
    if (!url.endsWith("/state")) return normal(url, init);
    stateReads += 1;
    if (failNext) { failNext = false; throw new TypeError("Failed to fetch"); }
    return respond(nativeFrame());
  });
  const m = h.mount();
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e1"]);
  assert.equal(m.out.readFailure ?? null, null, "a read that answered states no failure");

  // The conversation stops answering. The surface states the classified failure — a read that never answered, which is
  // the kind a Retry can help with — and the transcript the conversation already stated stays exactly as it was.
  failNext = true;
  await m.out.retryRead();
  await h.pump(m);
  assert.equal(m.out.readFailure.kind, "unreachable", "a transport failure is a read that may answer next time");
  assert.deepEqual(plain(m.out.entryIds), ["e1"], "the accepted window is not discarded by a failed read");

  // The Retry is a read: one more conversation snapshot, and no submission, control action or upload beside it.
  const before = h.requests.length;
  const writesBefore = h.requests.filter(r => r.method !== "GET").length;
  await m.out.retryRead();
  await h.pump(m);
  const sent = h.requests.slice(before);
  assert.deepEqual(sent.map(r => r.method + " " + r.url), ["GET /api/conversations/conv/state"], "the recovery is one read and nothing else");
  assert.equal(h.requests.filter(r => r.method !== "GET").length, writesBefore, "no mutation was resent by the recovery");
  assert.equal(m.out.readFailure ?? null, null, "the read that answered is the recovery from the one that did not");
  assert.ok(stateReads >= 3);
  m.unmount();
});

/** A conversation the Backend says is gone is answered, not retried: the surface is told which state it is in. */
test("a conversation the Backend no longer has is a missing read, not a transport one", async (t) => {
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  let gone = false;
  const h = harness(t, (url, init) => {
    if (!url.endsWith("/state")) return normal(url, init);
    if (gone) return respond({ error: "not_found" }, 404);
    return respond(nativeFrame());
  });
  const m = h.mount();
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e1"]);

  gone = true;
  await m.out.retryRead();
  await h.pump(m);
  assert.equal(m.out.readFailure.kind, "missing", "the Backend stated the row is gone, which is not a lost answer");
  // The view the read could not replace is kept: the reader's place and draft are not thrown away by a refused refresh.
  assert.deepEqual(plain(m.out.entryIds), ["e1"]);
  m.unmount();
});

/**
 * A locate read that fails is not "the entry is not in this branch".
 *
 * The distinction is the whole reason the page read reports its own failure instead of answering `undefined` twice: a
 * navigation that could not read has proved nothing about the entry, so it must be retryable, while one that read every
 * page and did not find it has answered the question.
 */
test("a page read that fails reports its failure instead of exhausting the navigation", async (t) => {
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  let failPage = false;
  const h = harness(t, (url, init) => {
    if (url.includes("/entries?")) {
      if (failPage) throw new TypeError("Failed to fetch");
      return respond({ protocol: "hepi.v1", conversationId: "conv", oldestEntryId: "e1", hasMore: true,
        entries: ["e1", "e2"].map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
    }
    if (url.endsWith("/state")) return respond(nativeFrame({ oldestEntryId: "e3", entries: [
      { id: "e3", role: "user", text: "e3", message: { role: "user", content: "e3" } },
    ] }));
    return normal(url, init);
  });
  const m = h.mount();
  await h.pump(m);

  const failures = [];
  failPage = true;
  const page = await m.out.loadContext("conv", null, "e3", { onReadFailure: (failure) => failures.push(failure) });
  await h.pump(m);
  assert.equal(page, undefined, "a page that failed establishes no page");
  assert.equal(failures.length, 1, "the caller is told the page failed rather than left to infer it from undefined");
  assert.equal(failures[0].kind, "unreachable");
  assert.deepEqual(plain(m.out.entryIds), ["e3"], "a failed page prepends nothing");

  // The same read that answers prepends the page as it always did.
  failPage = false;
  const answered = await m.out.loadContext("conv", null, "e3");
  await h.pump(m);
  assert.deepEqual(plain(answered.entryIds), ["e1", "e2"]);
  assert.deepEqual(plain(m.out.entryIds), ["e1", "e2", "e3"]);
  m.unmount();
});

