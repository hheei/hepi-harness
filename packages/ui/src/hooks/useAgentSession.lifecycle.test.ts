import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";
import type { AgentEventSourceLike, AgentEventSubscription } from "@hepi/session/browser";
import type { ServerSnapshot } from "@hepi/protocol";
import type { AgentMessage, SessionInfo } from "../lib/types.ts";
import type { ReadFailure } from "../lib/read-recovery.ts";
import type { ChatInputHandle } from "../components/ChatInput.tsx";
import type { ReloadOutcome } from "./useAgentSession.ts";

const webRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild") as { buildSync: (options: Record<string, unknown>) => { outputFiles: { text: string }[] } };
// The same resolution the app uses: the modules under test import through the `@/` alias.
const jiti = (name: string) => createJiti(import.meta.url, { alias: { "@": webRoot } }).import(name);
const { CompletionDelivery } = await createJiti(import.meta.url, { alias: { "@": webRoot } }).import<typeof import("../lib/completion-delivery.ts")>("../lib/completion-delivery.ts");
// The registry reads the connection's stream; the stream owner here is the real one, so only the socket is synthetic.
const { AgentEventConnection } = await createJiti(import.meta.url, { alias: { "@": webRoot } }).import<typeof import("@hepi/session/browser")>("@hepi/session/browser");
// A case about the shared catalogue read mounts the real client, so the origin, the credential and the disposal it
// states are the ones production states.
const { createClient } = await createJiti(import.meta.url, { alias: { "@": webRoot } }).import<typeof import("../client.ts")>("../client.ts");
// A connection is assembled in one place and its conversation API with it, so the value a mount is inside here is that
// assembly rather than a hand-built lookalike.
const { workbenchConnection } = await createJiti(import.meta.url, { alias: { "@": webRoot } }).import<typeof import("../lib/workbench-scope.ts")>("../lib/workbench-scope.ts");

/** What one mount of the hook states, as the hook itself states it. */
type AgentSession = ReturnType<typeof import("./useAgentSession.ts").useAgentSession>;
/** The options a mount is given, minus the stream seam every mount here supplies. */
type MountOptions = Partial<Parameters<typeof import("./useAgentSession.ts").useAgentSession>[0]>;
/** One frame as the backend publishes it: a complete window, or an advance on one. */
type NativeSnapshot = ServerSnapshot<AgentMessage>;

/** One request the sandbox's `fetch` was asked for, and whether it came through the connection. */
type Request = { url: string; method: string; body: Record<string, unknown> | undefined; viaClient: boolean };
/** One response the sandbox's `fetch` answers, in the shape the connection's own reads consume. */
type StubResponse = { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> };
/** One conversation's stream, as the sandbox's own `EventSource` delivers it. */
type Source = { url: string; readyState: number; onmessage: ((event: { data: string }) => void) | null; close(): void; emit(event: unknown): void };
/** One stream the harness's registry opened, driven from the case through `message`. */
type RegistrySource = { conversationId: string; readyState: number; onmessage: ((event: { data: string }) => void) | null; onerror: ((event: Event) => void) | null; message(event: unknown): void; close(): void };
/** One mounted hook, as the cases drive it: a render, the effects of that render, and the teardown. */
type Mount = {
  options: MountOptions & { subscribeAgentEvents: (conversationId: string, listener: (event: unknown) => void) => AgentEventSubscription<AgentMessage> };
  connection: ReturnType<typeof workbenchConnection>;
  slots: Slot[];
  index: number;
  effects: (() => void)[];
  dirty: boolean;
  render(): void;
  replayEffects(): void;
  /** Re-render this same mount inside another connection, as the provider's replacement does. */
  switchConnection(connection: ReturnType<typeof workbenchConnection>): void;
  unmount(): void;
  readonly out: AgentSession;
};
/** One hook slot: what state it holds, the deps it was installed with, and the cleanup it must be released by. */
type Slot = { deps?: readonly unknown[]; effect?: () => (() => void) | undefined; cleanup?: () => void; value?: unknown; current?: unknown };

/**
 * One completion registry over the real stream owner.
 *
 * The registry is a reader of the connection's stream rather than the owner of one, so these cases state the connection
 * the page would hold and only the socket below it is synthetic: the same assembly the shell builds, with the real
 * `AgentEventConnection` and the real fold.
 */
function streamRegistry(t: TestContext, { createSource, onAnswered = () => {} }: {
  createSource: (conversationId: string) => RegistrySource;
  onAnswered?: (notice: { readonly conversationId: string; readonly answerKey: string }) => void;
}) {
  const connection = new AgentEventConnection({ createSource, readinessTimeoutMs: 1000, reconnectDelayMs: 1000, onUnexpectedError: () => {} });
  const delivery = new CompletionDelivery({
    subscribe: (conversationId: string, listener: (event: import("@hepi/session/browser").AgentEventLike) => void) => connection.subscribe(conversationId, listener),
    lookup: async () => null,
    onAnswered,
  });
  t.after(() => { delivery.close(); connection.close(); });
  return { delivery, connection };
}
// The remembered view is page memory shared by every mount in this process, so a test states what it starts from.
const cache = await jiti("../lib/session-view-cache.ts") as typeof import("../lib/session-view-cache.ts");
/** The connection this mount is inside: every scoped store the hook reaches keys by this same string. */
const TEST_SCOPE = "test|backend|account";
const hookBundle = buildSync({
  entryPoints: [path.join(webRoot, "hooks", "useAgentSession.ts")], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["react"], alias: { "@": webRoot },
}).outputFiles[0].text;
/** A settled copy of one hook value: what the surface states, with no prototype from the sandbox it was built in. */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const respond = (body: unknown, status = 200): StubResponse => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
/** The same answer as the platform states it: a connection's `fetch` is a browser's own, so its answers are responses. */
const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A stream no case drives: the factory's return for a connection whose socket is not what that case is about. */
const inertSource = (): AgentEventSourceLike => ({ readyState: 1, onmessage: null, onerror: null, close() {} });
/** The last item a case expects: a stream it just opened, or the answer it is waiting on. */
const at = <T,>(items: readonly T[]): T => { const value = items.at(-1); assert.ok(value, "the case expects a value"); return value; };
/** One listed conversation, as the shell hands it to a mount. */
const sessionInfo = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  path: "/tmp/conv", id: "conv", cwd: "/tmp", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 0, firstMessage: "", ...overrides,
});
/** A composer ref that records what a refusal put back, standing in for the surface's own handle. */
const restoring = (into: Parameters<ChatInputHandle["restoreSubmission"]>[]): { current: ChatInputHandle } => ({
  current: { restoreSubmission: (...args) => { into.push(args); } } as ChatInputHandle,
});
/** The conversation a mount holds. A mount that states none is a mount whose read has not answered. */
const dataOf = (m: Mount): NonNullable<AgentSession["data"]> => { const value = m.out.data; assert.ok(value, "the mount holds its conversation"); return value; };
/** The model a mount would show, which is stated once the conversation and its catalogue have answered. */
const modelOf = (m: Mount): NonNullable<AgentSession["currentModel"]> => { const value = m.out.currentModel; assert.ok(value, "the mount holds its model"); return value; };
/** The classified read failure a mount states; the cases that read it are the ones that saw one. */
const failureOf = (m: Mount): ReadFailure => { const value = m.out.readFailure; assert.ok(value, "the mount states its read failure"); return value; };
/** One request's own body, as the case that recorded it stated. */
const bodyOf = (request: Request): Record<string, unknown> => { assert.ok(request.body, "the request carried a body"); return request.body; };
/** The text each message states, which is what a transcript row shows. */
const texts = (messages: readonly AgentMessage[]): unknown[] => [...messages].map(message => ("content" in message ? plain(message.content) : undefined));
const same = <T,>(left: readonly T[] | undefined, right: readonly T[] | undefined): boolean =>
  Boolean(left && right) && left!.length === right!.length && left!.every((value, index) => Object.is(value, right![index]));
const options: MountOptions = { session: { path: "/tmp/conv", id: "conv", cwd: "/tmp", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 0, firstMessage: "" }, newSessionCwd: null, newSessionDraftKey: null };
const nativeFrame = ({ revision = 1, projectionId = "P-conv", text = "initial", ...rest }: Partial<NativeSnapshot> & { text?: string } = {}): NativeSnapshot => ({
  protocol: "hepi.v1", conversationId: "conv", projectionId, revision, run: null, submissions: [], busy: false, partial: "",
  liveTools: [], toolNames: [], extensions: [], liveMessage: undefined,
  settings: { model: null, thinkingLevel: "off" }, queuedMessages: { steering: [], followUp: [] }, queuedItems: [],
  control: { state: "allowed", revision: 1 },
  historyRevision: "rev-" + revision, historyHead: "h1", hasMore: true, oldestEntryId: "e" + revision,
  entries: [{ id: "e" + revision, role: "user", text, message: { role: "user", content: text } }],
  failure: null, ...rest,
});

/** One frame as the stream publishes it: the backend's own native payload, under the name the backend gave it. */
const frame = (overrides: Partial<NativeSnapshot> & { text?: string }): NativeSnapshot => nativeFrame(overrides);

/**
 * One frame's worth of stream, as the browser's transport delivers it: the event name plus the native payload. The
 * hook folds it with the shared reducer and projects the held state, exactly as it does for a real stream.
 */
const streamFrame = (snapshot: NativeSnapshot, event = "snapshot") => ({ type: "frame", sessionId: "conv", event, data: snapshot });
function deferredRead() {
  const pending = Promise.withResolvers<StubResponse>();
  return {
    promise: pending.promise,
    release: (body: unknown) => pending.resolve(respond(body)),
    /** The same read answering a refusal: the status is the Backend's own answer, as a real response states it. */
    releaseAt: (body: unknown, status: number) => pending.resolve(respond(body, status)),
    /** The same read answering the way a transport failure does, so a caller sees the rejection it would see. */
    reject: (cause: unknown) => pending.reject(cause),
  };
}

// Run the actual bundled hook with independent React and transport state per fixture.
function harness(t: TestContext, responder: (url: string, init: RequestInit | undefined, body: Record<string, unknown> | undefined) => StubResponse | Promise<StubResponse>) {
  const requests: Request[] = [], sources: Source[] = [];
  /**
   * Every timer this hook scheduled, in order.
   *
   * A pending timer is a resource: it outlives the render that made it and fires against whatever the surface holds by
   * then. The cases that state a notice read it to prove the toast's clock is not one of this hook's — a conversation
   * handed to the background must not be holding a countdown for a toast nobody is drawing (acceptance C7).
   */
  const timers: { ms: number }[] = [];
  // Every conversation request this hook makes is the connection's own. The client below is the only way to reach the
  // sandbox's `fetch`, so a request recorded without it is a surface that reached around the connection.
  const clientRequests: string[] = [];
  let inClient = false;
  let current: Mount | null = null;
  const react = {
    useState(initial: unknown) {
      const mount = current;
      assert.ok(mount, "a hook ran outside a render");
      const index = mount.index++;
      if (!(index in mount.slots)) mount.slots[index] = { value: typeof initial === "function" ? (initial as () => unknown)() : initial };
      return [mount.slots[index].value, (next: unknown) => {
        const value = typeof next === "function" ? (next as (previous: unknown) => unknown)(mount.slots[index].value) : next;
        if (!Object.is(value, mount.slots[index].value)) { mount.slots[index].value = value; mount.dirty = true; }
      }];
    },
    useRef(initial: unknown) { const m = current; assert.ok(m, "a hook ran outside a render"); const i = m.index++; return m.slots[i] ?? (m.slots[i] = { current: initial }); },
    useMemo(factory: () => unknown, deps?: readonly unknown[]) {
      const m = current;
      assert.ok(m, "a hook ran outside a render");
      const i = m.index++;
      if (!m.slots[i] || !same(m.slots[i].deps, deps)) m.slots[i] = { deps, value: factory() };
      return m.slots[i].value;
    },
    useCallback(callback: unknown, deps?: readonly unknown[]) { return react.useMemo(() => callback, deps); },
    useEffect(effect: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const m = current;
      assert.ok(m, "a hook ran outside a render");
      const i = m.index++;
      if (!m.slots[i] || !same(m.slots[i].deps, deps)) {
        const previous = m.slots[i];
        const slot = m.slots[i] = { deps, cleanup: previous?.cleanup, effect };
        m.effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
      }
    },
    useLayoutEffect(effect: () => (() => void) | undefined, deps?: readonly unknown[]) { return react.useEffect(effect, deps); },
    // The hook reads the connection it is mounted inside. A mount here is a mount inside one scope, so the only context
    // in this closure is that one: the stores the hook reaches are keyed by it, and a case about the cache states the
    // same key.
    createContext: () => ({}),
    // The connection the hook is inside. Its client is the one seam every conversation request, page, submission lookup
    // and lease goes through, so the harness states it as the transport the sandbox's `fetch` answers — the same shape
    // the real client has, with no origin of its own to resolve.
    useContext: () => current?.connection,
    useReducer(reducer: (state: unknown, action: unknown) => unknown, initial: unknown) {
      const [value, set] = react.useState(initial) as [unknown, (next: unknown) => void];
      return [value, (action: unknown) => set((previous: unknown) => reducer(previous, action))];
    },
  };
  class SandboxSource implements Source {
    readyState = 1;
    onmessage: ((event: { data: string }) => void) | null = null;
    readonly url: string;
    constructor(url: string) { this.url = url; sources.push(this); queueMicrotask(() => this.emit({ type: "connected" })); }
    close() { this.readyState = 2; }
    emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
  }
  const sandbox: Record<string, unknown> = {
    module: { exports: {} as Record<string, unknown> }, exports: {}, require: (name: string) => name === "react" ? react : require(name), console,
    URLSearchParams, URL, AbortController, DOMException, crypto: globalThis.crypto, queueMicrotask, EventSource: SandboxSource,
    document: { visibilityState: "visible", title: "", addEventListener() {}, removeEventListener() {} }, navigator: {},
    setTimeout: (handler: () => void, ms?: number) => { timers.push({ ms: ms ?? 0 }); void handler; return timers.length; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url), body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url: target, method: init?.method ?? "GET", body, viaClient: inClient });
      if (target.startsWith("/api/models")) return respond({ models: {}, modelList: [] });
      return responder(target, init, body);
    },
  };
  vm.runInNewContext(hookBundle, sandbox);
  const subscribeAgentEvents = (id: string, listener: (event: unknown) => void) => {
    const source = new SandboxSource("/api/conversations/" + id + "/events");
    source.onmessage = message => listener(JSON.parse(message.data));
    return { ready: async () => {}, reconnect() {}, release: () => source.close(), continuity: () => null };
  };
  // The connection a mount inside this sandbox holds unless the case states its own. Its client answers the sandbox's
  // `fetch`, so a request recorded without it is a surface that reached around the connection. The value is built once
  // per mount and handed back unchanged: a store or an effect that keys by the connection must see one connection, not
  // a fresh object per render.
  // A second connection: the switch case. It is a different Backend, a different account and a different client, so it is
  // a different conversation API and a different scope — the identity a late answer must be refused against.
  const anotherConnection = (t: TestContext) => {
    const client = createClient({
      origin: "https://gateway-b.example",
      credential: { kind: "bearer", token: "token-b" },
      createSource: inertSource,
      fetch: async (url: string | URL | Request, init?: RequestInit) => (sandbox.fetch as typeof globalThis.fetch)(String(url), init),
    } as never);
    t.after(() => client.dispose());
    return workbenchConnection(client as never, { profile: "profile-b", backendId: "backend-B", accountScope: "account-B" });
  };
  const defaultConnection = () => workbenchConnection({
    origin: "",
    request: (requestPath: string, init?: RequestInit) => {
      clientRequests.push(String(requestPath));
      inClient = true;
      return (sandbox.fetch as typeof globalThis.fetch)(requestPath, init).finally(() => { inClient = false; });
    },
    // The client's own JSON read, as the real one is built: one request, and a refusal carrying its status.
    readJson: async <T,>(requestPath: string, init?: RequestInit): Promise<T> => {
      clientRequests.push(String(requestPath));
      inClient = true;
      const response = await (sandbox.fetch as typeof globalThis.fetch)(requestPath, init).finally(() => { inClient = false; });
      const body = await response.json().catch(() => ({})) as { error?: unknown };
      if (!response.ok) {
        const error: Error & { status?: number } = new Error(typeof body.error === "string" && body.error !== "" ? body.error : "HTTP " + response.status);
        error.status = response.status;
        throw error;
      }
      return body as T;
    },
  } as unknown as Parameters<typeof workbenchConnection>[0], { profile: "test", backendId: "backend", accountScope: "account" });
  const useAgentSession = (sandbox.module as { exports: Record<string, unknown> }).exports.useAgentSession as (given: Mount["options"]) => AgentSession;
  return {
    requests, sources, clientRequests, timers, anotherConnection,
    mount(extra: MountOptions = {}, connection = defaultConnection()): Mount {
      let unmounted = false;
      const m = {
        options: { subscribeAgentEvents, ...options, ...extra } as Mount["options"], connection, slots: [] as Slot[], index: 0, effects: [] as (() => void)[], dirty: true,
        stored: null as AgentSession | null,
        render() {
          current = m as unknown as Mount; m.index = 0; m.effects = []; m.dirty = false;
          m.stored = useAgentSession(m.options);
          for (const effect of m.effects) effect();
        },
        // StrictMode mounts an effect twice: the same slot is cleaned up and run again. Replaying every effect is that
        // sequence, with the render that installed it left in place.
        replayEffects() {
          for (const slot of m.slots) slot?.cleanup?.();
          for (const slot of m.slots) if (slot?.effect) slot.cleanup = slot.effect();
        },
        // A connection switch: the provider above this mount states a new connection and the tree re-renders inside it.
        // The shell is **not** remounted — only the provider is keyed by the connection's scope — so this is the same
        // hook instance rendering again with a different `connection` in context, which is what makes a read that is
        // still in flight belong to the connection that was replaced.
        switchConnection(connection: ReturnType<typeof workbenchConnection>) {
          (m as unknown as { connection: ReturnType<typeof workbenchConnection> }).connection = connection;
          m.render();
        },
        unmount() { if (!unmounted) { unmounted = true; for (const slot of m.slots) slot?.cleanup?.(); } },
      } as Omit<Mount, "out"> & { stored: AgentSession | null };
      Object.defineProperty(m, "out", { get: () => { assert.notEqual(m.stored, null, "the hook has not rendered"); return m.stored as AgentSession; } });
      t.after(() => (m as unknown as Mount).unmount());
      return m as unknown as Mount;
    },
    async pump(m: Mount) {
      for (let i = 0; i < 60; i++) { if (m.dirty) m.render(); await Promise.resolve(); }
      assert.equal(m.dirty, false, "hook settles");
    },
  };
}
// The reads answer the backend's own native snapshot, which is what the hook now projects; the agent-state fields
// the composer reads are the snapshot's own scalars.
const normal = (url: string, init?: RequestInit): Promise<StubResponse> => url.endsWith("/state") ? Promise.resolve(respond(nativeFrame()))
  : url.endsWith("/messages") || url.endsWith("/busy") ? Promise.resolve(respond({ submissionId: "s1", control: { state: "allowed", revision: 1 } }))
    : url === "/api/conversations" && init?.method === "POST" ? Promise.resolve(respond({ conversationId: "conv" }))
      : Promise.resolve(respond({ success: true, data: { submissionId: "s1" } }));
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
  const tones: string[] = [];
  const m = h.mount({ onAgentEnd: () => tones.push("end") });
  await h.pump(m);
  await m.out.handleSend("recover this");
  await h.pump(m);
  const sent = h.requests.find(r => r.method === "POST" && r.body?.type === "conversation.submit");
  assert.ok(sent, "actual hook dispatches a prompt");
  assert.equal(m.out.pendingSubmissions.length, 1);
  // The stream the surface joined is the public seam: a resync arrives through it exactly as the backend states one.
  at(h.sources).emit({ type: "resync", sessionId: "conv" });
  await h.pump(m);
  const lookups = h.requests.filter(r => r.url.includes("/submissions?"));
  assert.equal(lookups.length, 1);
  assert.equal(new URL(lookups[0].url, "http://web").searchParams.get("requestId"), bodyOf(sent).requestId);
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
  const tones: string[] = [];
  const m = h.mount({ onAgentEnd: () => tones.push("end") });
  await h.pump(m);
  const sending = m.out.handleSend("raced turn");
  await h.pump(m);
  const staged = h.requests.find(r => r.method === "POST" && r.body?.type === "conversation.submit");
  assert.ok(staged, "the hook dispatched a prompt");
  assert.equal(m.out.pendingSubmissions.length, 1, "the turn is staged while its answer is in flight");
  // The stream reconnects and states the window in which the turn is already committed.
  at(h.sources).emit({ type: "connected", sessionId: "conv" });
  at(h.sources).emit(streamFrame(nativeFrame({ revision: 4, entries: [
    { id: "e1", role: "user", text: "raced turn", message: { role: "user", content: "raced turn" } },
    { id: "e2", role: "assistant", text: "answer", message: { role: "assistant", content: [{ type: "text", text: "answer" }], model: "m", provider: "p" } },
  ] })));
  await h.pump(m);
  assert.equal(m.out.pendingSubmissions.length, 1, "the reconnect's sweep has nothing to ask about while the turn is staged");
  prompt.release({ submissionId: "s1" });
  await sending;
  await h.pump(m);
  const lookups = h.requests.filter(r => r.url.includes("/submissions?"));
  assert.equal(lookups.length, 1, "the receipt leaves the turn's own submission as the one question owed");
  assert.equal(new URL(lookups[0].url, "http://web").searchParams.get("requestId"), bodyOf(staged).requestId);
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
  at(h.sources).emit(streamFrame({ ...nativeFrame({ revision: 4, entries: [
    { id: "e1", role: "user", text: "first prompt", message: { role: "user", content: "first prompt" } },
    { id: "e2", role: "assistant", text: "answer", message: { role: "assistant", content: [{ type: "text", text: "answer" }], model: "m", provider: "p" } },
  ] }), conversationId: "fresh" }));
  await h.pump(m);
  assert.equal(m.out.pendingSubmissions.length, 1, "the committed window alone does not settle a staged turn");
  prompt.release({ submissionId: "s9" });
  await sending;
  await h.pump(m);
  const lookups = h.requests.filter(r => r.url.includes("/submissions?"));
  assert.equal(lookups.length, 1, "the receipt asks about its own submission exactly once");
  assert.equal(new URL(lookups[0].url, "http://web").searchParams.get("requestId"), bodyOf(staged).requestId);
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
    const restored: Parameters<ChatInputHandle["restoreSubmission"]>[] = [];
    const m = h.mount({
      ...(kind === "creation" ? { session: null, newSessionCwd: "/tmp", newSessionDraftKey: "failed" } : {}),
      chatInputRef: restoring(restored),
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
        assert.deepEqual(plain(bodyOf(queued[0]).images), [{ type: "image", data: "AQID", mimeType: "image/png" }], kind);
      }
      assert.deepEqual(plain(m.out.pendingSubmissions), [], kind);
      assert.equal(restored.length, 1, kind);
      assert.equal(restored[0][0], "keep me", kind);
      assert.deepEqual(plain(restored[0][1]), [{ data: "AQID", mimeType: "image/png" }], kind);
      // The refusal the Backend stated is what the surface shows, whichever route carried it.
      assert.ok(plain(m.out.notices).some(n => n.type === "error" && n.message.includes(kind === "creation" ? "unavailable" : "bad image")), kind);
      // The notice is a fact this hook states and nothing more: the toast it becomes is drawn by the shelf, so no
      // countdown of its own is scheduled here. A hook that timed it would leave that clock running when the
      // conversation is handed over to the background, which is the resource the ticket takes out of this owner.
      assert.deepEqual(h.timers.map(timer => timer.ms).filter(ms => ms >= 180 && ms <= 5000), [],
        kind + ": the conversation schedules no notice countdown, and no exit animation: " + JSON.stringify(h.timers));
    } finally { m.unmount(); }
  }
});

test("a shell draft is refused on every send path with nothing staged, and ordinary turns still go", async (t) => {
  const h = harness(t, (url, init) => normal(url, init));
  const restored: Parameters<ChatInputHandle["restoreSubmission"]>[] = [];
  const m = h.mount({ chatInputRef: restoring(restored) });
  await h.pump(m);
  const prompts = () => h.requests.filter(r => r.method === "POST" && (r.body?.type === "conversation.submit" || r.url.endsWith("/busy")));

  await m.out.handleSend("!pwd");
  await h.pump(m);
  assert.equal(prompts().length, 0, "an idle shell draft is not dispatched");
  assert.deepEqual(plain(m.out.pendingSubmissions), [], "and nothing is staged for it");
  assert.ok(plain(m.out.notices).some(n => n.type === "warning" && n.message.includes("shell commands")), "the refusal is stated");

  at(h.sources).emit(streamFrame(frame({ revision: 2, busy: true, run: { inputs: ["s1"] },
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
  const window = (revision: number, ids: string[], head = "h1") => frame({
    revision, historyHead: head, oldestEntryId: ids[0],
    entries: ids.map((id: string) => ({ id, role: "user", text: id, message: { role: "user", content: id } })),
  });
  const h = harness(t, url => {
    if (url.includes("/entries?")) return respond({ protocol: "hepi.v1", conversationId: "conv", oldestEntryId: "e1", hasMore: true,
      entries: ["e1", "e2"].map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
    if (url.endsWith("/state")) return respond(window(1, ["e3", "e4"]));
    return normal(url);
  });
  const first = h.mount();
  await h.pump(first);
  at(h.sources).emit(streamFrame(window(2, ["e5", "e6"], "h2")));
  await h.pump(first);
  await first.out.loadContext("conv", null, "e5");
  await h.pump(first);
  at(h.sources).emit(streamFrame(window(3, ["e6", "e7"], "h2")));
  await h.pump(first);
  assert.deepEqual(plain(first.out.entryIds), ["e1", "e2", "e5", "e6", "e7"]);
  first.unmount();
  const second = h.mount();
  await h.pump(second);
  assert.deepEqual(plain(second.out.entryIds), ["e1", "e2", "e5", "e6", "e7"], "an older bootstrap read cannot erase loaded history");
  at(h.sources).emit(streamFrame(window(4, ["e7", "e8"], "h2")));
  await h.pump(second);
  assert.deepEqual(plain(second.out.entryIds), ["e1", "e2", "e5", "e6", "e7", "e8"], "new mount advances its acquisition sequence");
});

test("a window that moves publishes its prefix in the same update, with no effect catching up a render later", async (t) => {
  // The bug this covers: the window was published by the accepted-facts receiver and the prefix was decided by a React
  // effect that compared the previous view with the new one, so for one render the transcript drew the advanced window
  // without the entries it had evicted from the reader's loaded history — and a reader scrolled back lost the message
  // they were reading until the next commit. The readout publishes both from the same accepted statement, so **one**
  // render after the frame is enough: no pump, no effect replay.
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  const window = (revision: number, ids: string[], head = "h1") => nativeFrame({ revision, historyHead: head, hasMore: true,
    oldestEntryId: ids[0], entries: ids.map((id: string) => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
  const h = harness(t, url => url.includes("/entries?") ? respond({ protocol: "hepi.v1", conversationId: "conv", oldestEntryId: "e1", hasMore: true,
      entries: ["e1", "e2"].map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })) })
    : url.endsWith("/state") ? respond(window(1, ["e3", "e4"])) : normal(url));
  const m = h.mount();
  await h.pump(m);
  await m.out.loadContext("conv", null, "e3");
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e1", "e2", "e3", "e4"], "the reader paged older history in");

  // The window advances under the same head, evicting e3 while it was loaded. Exactly one render follows.
  at(h.sources).emit(streamFrame(window(2, ["e4", "e5"])));
  m.render();
  assert.deepEqual(plain(m.out.entryIds), ["e1", "e2", "e3", "e4", "e5"], "the evicted entry is already in the prefix in that same update");
  assert.deepEqual(texts(m.out.messages), ["e1", "e2", "e3", "e4", "e5"], "and each entry is drawn once, in transcript order");
  assert.equal(new Set(plain(m.out.entryIds)).size, 5, "no entry is contributed twice");
  m.unmount();
});

test("a page that reached the start of history keeps the sentinel closed while frames keep arriving", async (t) => {
  // The sentinel the surface reads is `hasEarlierMessages`. Once a page has answered "no older history", an advancing
  // window must not re-open it: the window's own `hasMore` describes what lies behind its oldest entry, not behind the
  // pages in front of it, so restating it would send the reader back to the same oldest page on every live frame.
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  const window = (revision: number, ids: string[]) => nativeFrame({ revision, historyHead: "h1", hasMore: true,
    oldestEntryId: ids[0], entries: ids.map((id: string) => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
  const h = harness(t, url => url.includes("/entries?") ? respond({ protocol: "hepi.v1", conversationId: "conv", oldestEntryId: "e1", hasMore: false,
      entries: ["e1", "e2"].map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })) })
    : url.endsWith("/state") ? respond(window(1, ["e3", "e4"])) : normal(url));
  const m = h.mount();
  await h.pump(m);
  assert.equal(m.out.hasEarlierMessages, true, "the accepted window states older history exists");
  await m.out.loadContext("conv", null, "e3");
  await h.pump(m);
  assert.equal(m.out.hasEarlierMessages, false, "the page reached the start of history");
  at(h.sources).emit(streamFrame(window(2, ["e4", "e5"])));
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e1", "e2", "e3", "e4", "e5"], "the page it kept is still on screen");
  assert.equal(m.out.hasEarlierMessages, false, "and the sentinel stays closed over the history the reader already exhausted");
  m.unmount();
});

test("a landed target window joins the loaded prefix and never overlaps the accepted window", async (t) => {
  // The history owner's half of ticket 03, asserted where the transcript is decided rather than in the coordinator: a
  // jump's window enters through the same prefix state the sentinel's pages use, so one rule (`decidePrefix`) still says
  // what the reader's history becomes when the window moves. The cut that makes this safe is that an entry the
  // projection's own window carries is never contributed by the prefix — an overlapping prefix fails the prefix rule and
  // would drop every page the reader had loaded, turning a jump into a loss of history.
  const window = (revision: number, ids: string[], head = "h1") => nativeFrame({
    revision, historyHead: head, hasMore: true, oldestEntryId: ids[0],
    entries: ids.map((id: string) => ({ id, role: "user", text: id, message: { role: "user", content: id } })),
  });
  const landed = (ids: string[]) => ({
    conversationId: "conv", snapshot: "conv|h1|" + ids.at(-1), scope: "conv|h1", hasOlder: true, hasNewer: true,
    entries: ids.map((id: string) => ({ id, message: { role: "user", content: id } })),
  });
  const h = harness(t, url => url.endsWith("/state") ? respond(window(1, ["e6", "e7"])) : normal(url));
  const m = h.mount();
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e6", "e7"], "the conversation opens on its window");

  m.out.landWindow("conv", landed(["e3", "e4", "e5", "e6", "e7"]));
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e3", "e4", "e5", "e6", "e7"], "the landed span is in history order in front of the window");
  const textOf = (message: AgentMessage): unknown => ("content" in message ? plain(message.content) : undefined);
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
  at(h.sources).emit(streamFrame(window(2, ["c9", "e7"], "h2")));
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
  const native = (revision: number, ids: string[], head: string) => nativeFrame({ revision, historyHead: head, hasMore: true,
    oldestEntryId: ids[0], entries: ids.map((id: string) => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
  const window = (revision: number, ids: string[], head: string) => frame({ revision, historyHead: head, hasMore: true,
    oldestEntryId: ids[0], entries: ids.map((id: string) => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
  const h = harness(t, url => url.includes("/entries?") ? older.promise
    : url.endsWith("/state") ? respond(native(1, ["e3", "e4"], "h1")) : normal(url));
  const m = h.mount();
  await h.pump(m);
  // The reader pages back under h1, exactly as the scroll sentinel does: the cursor is the accepted window's boundary.
  const paged = m.out.loadContext("conv", null, "e3");
  await h.pump(m);
  // The context re-baselines while the page is in flight: the stream publishes the new head with the window it kept.
  at(h.sources).emit(streamFrame(window(2, ["c9", "e4", "e5"], "h2")));
  await h.pump(m);
  // The page was loaded under h1 and reaches the start of that context, so its own answer says "no older history".
  older.release({ protocol: "hepi.v1", conversationId: "conv", oldestEntryId: "e1", hasMore: false,
    entries: ["e1", "e2"].map(id => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
  assert.equal(await paged, undefined, "the page read reports that it established no page");
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["c9", "e4", "e5"], "the re-baselined window is the transcript; the older context's page is not prepended");
  assert.equal(m.out.historyCursor, "c9", "the paging cursor is the accepted window's own boundary, not the abandoned page's");
  assert.equal(m.out.hasEarlierMessages, true, "the abandoned page's exhaustion does not state the new context's");
  assert.equal(dataOf(m).context.oldestEntryId, "c9", "the accepted window keeps its own boundary");
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
  at(h.sources).emit(streamFrame(fresh));
  await h.pump(m);
  // The delayed read answers the backend's own native snapshot, so it is the browser's projection that must refuse it.
  const older = nativeFrame({ text: "stale", failure: null, settings: { model: { provider: "p", modelId: "old" }, thinkingLevel: "off" } });
  stale.release(older);
  await h.pump(m);
  assert.deepEqual(texts(m.out.messages), ["fresh"]);
  assert.equal(dataOf(m).revision, 2);
  assert.equal(dataOf(m).historyHead, "h2");
  assert.equal(m.out.activeLeafId, "e2");
  assert.deepEqual(plain(m.out.runFailure), { reason: "no_model", message: "fresh failure" });
  assert.equal(modelOf(m).modelId, "new");
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
      at(h.sources).emit(streamFrame(fresh));
      await h.pump(m);
      state.release(nativeFrame({ busy: true, settings: { model: { provider: "p", modelId: "old" }, thinkingLevel: "low" } }));
      await h.pump(m);
      assert.equal(dataOf(m).projectionId, fresh.projectionId);
      assert.equal(modelOf(m).modelId, "new");
      assert.equal(m.out.thinkingLevel, "high");
      assert.deepEqual(plain(m.out.queuedMessages), { steering: ["new"], followUp: [] });
      assert.equal(m.out.streamState.isStreaming, false);
      assert.equal(m.out.statusPhase ?? null, null);
    } finally { m.unmount(); }
  }
});

test("read refusal settles no submitted turn; recovery clears the error and stale stream data stays invisible", async (t) => {
  const h = harness(t, normal);
  const restored: Parameters<ChatInputHandle["restoreSubmission"]>[] = [];
  const m = h.mount({ chatInputRef: restoring(restored) });
  await h.pump(m);
  await m.out.handleSend("large answer");
  await h.pump(m);
  const source = at(h.sources);
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
    liveMessage: { role: "assistant", content: [{ type: "text", text: "partial" }], model: "m", provider: "p", stopReason: "pending" },
    liveTools: [{ callId: "c1", name: "bash", status: "running", output: "..." }],
  })));
  await h.pump(m);
  assert.deepEqual(texts(m.out.messages), ["recovered"]);
  assert.deepEqual(plain(m.out.statusPhase), { kind: "preparing" }, "the unanswered local submission still prepares; the stale frame cannot start a run");
  assert.equal(m.out.streamState.streamingMessage ?? null, null);
  assert.deepEqual([...m.out.activeToolResults.keys()], []);
});

test("the foreground reports a live answer once", async (t) => {
  const sources: RegistrySource[] = [], answers: { readonly conversationId: string; readonly answerKey: string }[] = [];
  const { delivery } = streamRegistry(t, {
    createSource(conversationId) {
      const source: RegistrySource = { conversationId, readyState: 1, onmessage: null, onerror: null,
        message(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>); }, close() { this.readyState = 2; } };
      sources.push(source);
      queueMicrotask(() => source.message({ type: "connected", sessionId: conversationId }));
      return source;
    },
    onAnswered: notice => answers.push(notice),
  });
  const tones: string[] = [];
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
    at(sources).message({ type: "submission", sessionId: "conv", submission: { ...submission, status, ...(status === "done" ? { answerId: "a1" } : {}) } });
    await h.pump(m);
  }
  assert.deepEqual(tones, ["surface"]);
  assert.deepEqual(answers, []);
  m.unmount();
});

test("a new composer releases the stream it acquired before its session prop updates", async (t) => {
  const fresh = harness(t, url => url === "/api/conversations" && url === "/api/conversations" ? respond({ conversationId: "fresh" }) : normal(url));
  const releases: string[] = [];
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
  const sources: RegistrySource[] = [], answers: { readonly conversationId: string; readonly answerKey: string }[] = [];
  const { delivery } = streamRegistry(t, {
    createSource(conversationId) {
      const source: RegistrySource = { conversationId, readyState: 1, onmessage: null, onerror: null,
        message(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>); }, close() { this.readyState = 2; } };
      sources.push(source);
      return source;
    },
    onAnswered: notice => answers.push(notice),
  });
  delivery.nominate(["conv"]);
  at(sources).message({ type: "connected", sessionId: "conv" });
  at(sources).message({ type: "frame", sessionId: "conv", event: "snapshot", data: nativeFrame({ revision: 1, text: "from the stream" }) });
  await new Promise(resolve => setImmediate(resolve));

  // The conversation read is held open, so the only thing that can put the transcript on screen is the stream itself:
  // a reader that had to wait for a read would be a reader that published nothing when the stream moved first.
  const read = deferredRead();
  const h = harness(t, url => url.endsWith("/state") ? read.promise : normal(url));
  delivery.select("conv");
  const m = h.mount({ subscribeAgentEvents: (id, listener) => delivery.subscribe(id, listener) });
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e1"], "the window the stream was holding is on screen before any read answers");
  assert.deepEqual(texts(m.out.messages), ["from the stream"]);
  assert.equal(dataOf(m).revision, 1);
  assert.equal(dataOf(m).projectionId, "P-conv", "and it is the conversation's own attachment, not an empty one");

  // The next delta continues the handed window instead of replacing it with what the delta alone carried.
  const { entries, ...scalars } = nativeFrame({ revision: 1, text: "from the stream" });
  at(sources).message({ type: "frame", sessionId: "conv", event: "state", data: {
    ...scalars, revision: 2, baseRevision: 1, oldestEntryId: "e1", hasMore: true,
    appended: [{ id: "e2", role: "assistant", text: "grown", message: { role: "assistant", content: "grown" } }],
  } });
  await h.pump(m);
  assert.deepEqual(plain(m.out.entryIds), ["e1", "e2"], "the delta extended the transcript rather than replacing it");
  assert.deepEqual(texts(m.out.messages), ["from the stream", "grown"]);
  assert.equal(dataOf(m).revision, 2);
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
  const window = (revision: number, ids: string[], head: string) => nativeFrame({ revision, historyHead: head, hasMore: true,
    oldestEntryId: ids[0], entries: ids.map((id: string) => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
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
  const sources: RegistrySource[] = [];
  const { delivery } = streamRegistry(t, {
    createSource(conversationId) {
      const source: RegistrySource = { conversationId, readyState: 1, onmessage: null, onerror: null,
        message(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>); }, close() { this.readyState = 2; } };
      sources.push(source);
      return source;
    },
  });
  delivery.nominate(["conv"]);
  at(sources).message({ type: "connected", sessionId: "conv" });
  at(sources).message({ type: "frame", sessionId: "conv", event: "snapshot", data: window(8, ["e8", "e9"], "h2") });
  await new Promise(resolve => setImmediate(resolve));
  delivery.select("conv");

  later = true;
  const second = h.mount({ subscribeAgentEvents: (id, listener) => delivery.subscribe(id, listener) });
  await h.pump(second);
  assert.deepEqual(plain(second.out.entryIds), ["e8", "e9"], "the accepted window is the transcript; the older head's pages are not restored in front of it");
  assert.equal(second.out.loading, false, "the accepted window is on screen without waiting for the read");
  assert.equal(dataOf(second).historyHead, "h2", "the beside facts are the accepted statement's, not the remembered view's");
  assert.equal(dataOf(second).revision, 8);
  assert.equal(second.out.hasEarlierMessages, true, "the accepted window's own pagination state is kept");
  assert.equal(sources.length, 1, "adopting the remembered view opens no second stream");

  // The read that was held open answers with the very window the stream stated: it restates it and changes nothing.
  held.release(window(8, ["e8", "e9"], "h2"));
  await h.pump(second);
  assert.deepEqual(plain(second.out.entryIds), ["e8", "e9"]);
  assert.equal(dataOf(second).historyHead, "h2", "the head the conversation is on is not rewound by the read either");
});

test("a remembered window and its paged prefix come back when the head has not moved", async (t) => {
  // The other half of the same rule: a remembered view whose head is still the conversation's head is exactly what the
  // cache is for. It is drawn while the mount's reads are still in flight, and the pages the reader had loaded are
  // kept — and migrated — when the window advances, because the head they were loaded under did not move.
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  const window = (revision: number, ids: string[], head: string) => nativeFrame({ revision, historyHead: head, hasMore: true,
    oldestEntryId: ids[0], entries: ids.map((id: string) => ({ id, role: "user", text: id, message: { role: "user", content: id } })) });
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
  assert.equal(dataOf(second).historyHead, "h1");

  // The window advances under the same head: the loaded entries the window evicted migrate into the prefix rather
  // than vanishing, and nothing is prepended twice.
  at(h.sources).emit(streamFrame(window(2, ["e5", "e6"], "h1")));
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
  assert.equal(dataOf(m).context.thinkingLevel, "off", "the composer's own level is read from that same answer");
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
  const sources: RegistrySource[] = [];
  const { delivery } = streamRegistry(t, {
    createSource(conversationId) {
      const source: RegistrySource = { conversationId, readyState: 1, onmessage: null, onerror: null,
        message(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>); }, close() { this.readyState = 2; } };
      sources.push(source);
      return source;
    },
  });
  delivery.nominate(["conv"]);
  at(sources).message({ type: "connected", sessionId: "conv" });
  at(sources).message({ type: "frame", sessionId: "conv", event: "snapshot", data: nativeFrame({ revision: 5, settings: { model: null, thinkingLevel: "high" } }) });
  await new Promise(resolve => setImmediate(resolve));
  delivery.select("conv");

  const m = h.mount({ subscribeAgentEvents: (id, listener) => delivery.subscribe(id, listener) });
  await h.pump(m);
  // The mount's read answers the older window, which the fold refuses; the composer is not handed its settings.
  held.release(nativeFrame({ revision: 1, settings: { model: null, thinkingLevel: "off" } }));
  await h.pump(m);
  assert.equal(dataOf(m).revision, 5, "the accepted window is still the stream's");
  assert.equal(dataOf(m).context.thinkingLevel, "high", "and the composer states that window's level, not the refused read's");
});


test("the conversation workflow is asked on the connection, never around it", async (t) => {
  // The hook is mounted inside one connection, and every read, page, submission and lease it performs is that
  // connection's request: its Gateway origin and its credential. A caller that reached the global `fetch` instead would
  // ask whatever origin happens to serve the document — the bundle's own, in the App — and present no credential at all.
  const h = harness(t, normal);
  const m = h.mount({ session: sessionInfo() });
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
    const held = Promise.withResolvers<void>();
    let modelReads = 0;
    let requestSignal: AbortSignal | undefined;
    const client = createClient({
      origin: "https://shared-models.example",
      credential: { kind: "bearer", token: "shared-device" },
      createSource: inertSource,
      fetch: async (url, init) => {
        if (String(url).includes("/api/models")) {
          modelReads++;
          requestSignal = init?.signal ?? undefined;
          await held.promise;
          if (requestSignal?.aborted) throw new DOMException("aborted", "AbortError");
          return jsonResponse({ models: { shared: "Shared" }, modelList: [{ provider: "p", id: "shared", name: "Shared" }] });
        }
        return jsonResponse(nativeFrame());
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
    assert.equal(requestSignal?.aborted, false, "one consumer's exit cancelled the shared read");
    held.resolve();
    await h.pump(survivor);
    assert.deepEqual(plain(survivor.out.modelList.map(model => model.id)), ["shared"], "the surviving composer was not handed the shared answer");
  });
}

test("disposing the connection retires its shared model read and no late answer lands", async (t) => {
  const held = Promise.withResolvers<void>();
  let modelReads = 0;
  let requestSignal: AbortSignal | undefined;
  const client = createClient({
    origin: "https://disposed-models.example",
    credential: { kind: "bearer", token: "disposed-device" },
    createSource: inertSource,
    fetch: async (url, init) => {
      if (String(url).includes("/api/models")) {
        modelReads++;
        requestSignal = init?.signal ?? undefined;
        await held.promise;
        if (requestSignal?.aborted) throw new DOMException("aborted", "AbortError");
        return jsonResponse({ models: { stale: "Stale" }, modelList: [{ provider: "p", id: "stale", name: "Stale" }] });
      }
      return jsonResponse(nativeFrame());
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
  assert.equal(requestSignal?.aborted, true, "disposal left the connection's own read on the wire");
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
  const seen: { target: string; authorization: string | null }[] = [];
  const entry = (provider: string, id: string) => ({ id, name: id.toUpperCase(), provider });
  const clientFor = (origin: string, token: string, models: { id: string; name: string; provider: string }[], hold: Promise<void> | null) => createClient({
    origin,
    credential: { kind: "bearer", token },
    createSource: inertSource,
    fetch: async (url, init) => {
      const target = String(url);
      seen.push({ target, authorization: new Headers(init?.headers).get("authorization") });
      if (target.includes("/api/models")) {
        if (hold) await hold;
        return jsonResponse({ models: Object.fromEntries(models.map(model => [model.id, model.name])), modelList: models });
      }
      return jsonResponse(target.endsWith("/state") ? nativeFrame() : {});
    },
  });
  const hold = Promise.withResolvers<void>();
  const connectionA = workbenchConnection(clientFor("https://gateway-a.example", "token-a", [entry("alpha", "a1")], hold.promise), { profile: "profile-a", backendId: "backend-A", accountScope: "account-A" });
  const connectionB = workbenchConnection(clientFor("https://gateway-b.example", "token-b", [entry("beta", "b1")], null), { profile: "profile-b", backendId: "backend-B", accountScope: "account-B" });
  t.after(() => { connectionA.client.dispose(); connectionB.client.dispose(); });
  const h = harness(t, normal);
  const session = sessionInfo({ cwd: "/work" });
  const readsFor = (origin: string) => seen.filter(request => request.target.startsWith(origin + "/") && request.target.includes("/api/models"));

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
  assert.equal(failureOf(m).kind, "unreachable", "a transport failure is a read that may answer next time");
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
  assert.equal(failureOf(m).kind, "missing", "the Backend stated the row is gone, which is not a lost answer");
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

  const failures: ReadFailure[] = [];
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
  assert.deepEqual(plain(answered?.entryIds), ["e1", "e2"]);
  assert.deepEqual(plain(m.out.entryIds), ["e1", "e2", "e3"]);
  m.unmount();
});


test("an explicit reload is one operation on the conversation, not a new attachment", async (t) => {
  // Settings › General changes the runtime's tool configuration and asks the conversation to pick it up. That request
  // reaches this surface as its own registered operation: the Backend's reload route, then this conversation's read.
  // What it must not be is a remount — a new attachment would leave a new stream, a new projection and a reader who lost
  // their place — so the stream this mount joined is asserted to be the only one it ever opened.
  const h = harness(t, normal);
  const reloads: ((() => Promise<ReloadOutcome>) | null)[] = [];
  const m = h.mount({ onConversationReloadChange: (reload) => reloads.push(reload) });
  await h.pump(m);
  const reload = reloads.at(-1);
  assert.ok(reload, "the surface registers its own reload for the surfaces outside the chat");
  const sourcesBefore = h.sources.length;
  const readsBefore = h.requests.filter(r => r.url.endsWith("/state")).length;

  await reload();
  await h.pump(m);
  const sent = h.requests.slice(-3);
  assert.ok(sent.some(r => r.method === "POST" && r.url === "/api/conversations/conv/reload"), "the reload is the Backend's own route: " + JSON.stringify(sent.map(r => r.method + " " + r.url)));
  assert.equal(h.requests.filter(r => r.url.endsWith("/state")).length, readsBefore + 1, "and exactly one read states it");
  assert.equal(h.sources.length, sourcesBefore, "no new stream was opened: the same conversation is still the one on screen");
  assert.ok(plain(m.out.notices).some(notice => notice.message.includes("Reloaded")), "the reload reports what it reloaded");

  // Leaving is the cleanup of the registration, so a surface that asks after this conversation is gone does nothing.
  m.unmount();
  assert.equal(reloads.at(-1), null, "the registration is withdrawn with the surface");
});

/**
 * What a reload says it did is what the read after it established, not what the reload route answered.
 *
 * The Backend's route is a fact about the runtime's resources; the surface's claim is a fact about the conversation.
 * A read that answered and was accepted is a reload this conversation picked up, and the numbers it named are the ones
 * named. A read that could not answer is a failure — and one that no longer has the conversation at all is the missing
 * one — so neither is reported as a success, and a notice is never the only thing standing between the reader and the
 * truth of what happened.
 */
test("a reload reports what the read after it established, and a read that failed is not a success", async (t) => {
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  // The reload route always answers, so what differs between the cases is the read that follows it: a window, the
  // Backend's own not_found, a read the Backend refused, and one that never answered. The last two are both failures but
  // not the same failure, which is exactly why a bare null could not state them.
  for (const answer of ["accepted", "missing", "refused", "failure"] as const) {
    const h = harness(t, (url, init) => {
      if (url === "/api/conversations/conv/reload") return respond({ resources: { skills: 3, prompts: 2 } });
      if (!url.endsWith("/state")) return normal(url, init);
      if (answer === "accepted") return respond(nativeFrame({ revision: 9, text: "the reloaded conversation" }));
      if (answer === "missing") return respond({ error: "not_found" }, 404);
      if (answer === "refused") return respond({ error: "the projection is unreadable" }, 422);
      throw new TypeError("Failed to fetch");
    });
    const reloads: ((() => Promise<ReloadOutcome>) | null)[] = [];
    const m = h.mount({ onConversationReloadChange: (reload) => reloads.push(reload) });
    await h.pump(m);
    const reload = reloads.at(-1);
    assert.ok(reload, "the surface registers its own reload");
    const reloadsBefore = h.requests.filter(r => r.url === "/api/conversations/conv/reload").length;
    const outcome = plain(await reload());
    await h.pump(m);
    // One reload route, asked by this operation alone: the surface that triggered it does not ask for a second one.
    assert.equal(h.requests.filter(r => r.url === "/api/conversations/conv/reload").length, reloadsBefore + 1,
      answer + ": the Backend's reload route was asked exactly once");
    // The operation states its outcome to the caller as well as to the reader: a surface outside the chat that awaits it
    // — a definitions panel asking for a refresh — has to be able to tell a reload this conversation picked up from one
    // that failed, rather than reading a resolved promise as a success.
    assert.equal(outcome.status, answer === "accepted" ? "reloaded" : "failed", answer + ": the caller reads what the operation established: " + JSON.stringify(outcome));
    const notice = plain(m.out.notices).at(-1);
    assert.ok(notice, answer + ": the reload reports what happened");
    if (answer === "accepted") {
      assert.match(notice.message, /3 skills and 2 prompts/, answer + ": the resources the read's own answer named");
      assert.equal(notice.type, "success");
      assert.deepEqual(texts(m.out.messages), ["the reloaded conversation"], answer + ": and the read's window is on screen");
    } else {
      assert.equal(notice.type, "error", answer + ": a read that could not answer is not a success");
      // Which failure it was is the read's own classification, so the sentence names the right one: a row the Backend
      // says is gone, a read the Backend refused and one that never answered are three states with three next steps.
      const expected = answer === "missing" ? /no longer exists/ : answer === "refused" ? /could not be re-read/ : /could not be reached/;
      assert.match(notice.message, expected, answer + ": " + notice.message);
      assert.ok(!/3 skills/.test(notice.message), answer + ": the numbers of a read that never happened are not claimed");
    }
    m.unmount();
  }
});

/**
 * A reload route that rejects is a failure the operation states, not a rejection its caller has to catch.
 *
 * Settings › General awaits the reload it triggers, and the `/reload` command is a surface that has already finished its
 * own work by then. Neither can catch what this operation throws at them — one would show an unhandled rejection and the
 * other a generic command failure — so the route's own rejection is answered where the operation is, as the same kind of
 * statement a read that failed produces. Nothing is claimed about the conversation: the route that never answered said
 * nothing about it, and the resources it would have named are not named.
 */
test("a reload route that rejects is reported, and no read is asked for what it never changed", async (t) => {
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  const h = harness(t, (url, init) => {
    if (url === "/api/conversations/conv/reload") return respond({ error: "the runtime is restarting" }, 503);
    return normal(url, init);
  });
  const reloads: ((() => Promise<ReloadOutcome>) | null)[] = [];
  const m = h.mount({ onConversationReloadChange: (reload) => reloads.push(reload) });
  await h.pump(m);
  const reload = reloads.at(-1);
  assert.ok(reload, "the surface registers its own reload");
  const readsBefore = h.requests.filter(r => r.url.endsWith("/state")).length;
  // The caller awaits the operation exactly as Settings does. It must settle rather than reject: an unhandled rejection
  // is the bug this covers, and it would surface here as a thrown call rather than as a notice.
  await reload();
  await h.pump(m);
  const notice = plain(m.out.notices).at(-1);
  assert.ok(notice, "a rejected reload states what happened");
  assert.equal(notice.type, "error", "a route that never answered is not a success");
  assert.match(notice.message, /Reload failed/, "the sentence is the route's failure: " + notice.message);
  assert.equal(h.requests.filter(r => r.url.endsWith("/state")).length, readsBefore,
    "and no read was asked for a change that never happened");
  m.unmount();
});

/**
 * A reload that lands after the connection was replaced claims nothing about the surface that replaced it.
 *
 * The route and the read belong to one connection and one conversation. A switch while they were in flight makes both
 * of them facts about a client nothing shows, so the operation must not state an outcome — a notice here would be the
 * replaced connection's answer dressed as the current one's.
 */
test("a reload whose read answers after a connection switch states nothing", async (t) => {
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  const stale = deferredRead();
  let reads = 0;
  const h = harness(t, (url, init) => {
    if (url === "/api/conversations/conv/reload") return respond({ resources: { skills: 4, prompts: 1 } });
    if (!url.endsWith("/state")) return normal(url, init);
    return ++reads === 1 ? stale.promise : respond(nativeFrame({ text: "the new connection" }));
  });
  const reloads: ((() => Promise<ReloadOutcome>) | null)[] = [];
  const m = h.mount({ onConversationReloadChange: (reload) => reloads.push(reload) });
  await h.pump(m);
  const reload = reloads.at(-1);
  assert.ok(reload, "the surface registers its own reload");
  // The reload is asked, and its read is the one still in flight when the connection is replaced underneath it.
  const pending = reload();
  await h.pump(m);
  m.switchConnection(h.anotherConnection(t));
  await h.pump(m);
  const noticesBefore = plain(m.out.notices).length;
  stale.release(nativeFrame({ revision: 9, text: "the replaced connection's answer" }));
  await pending;
  await h.pump(m);
  assert.equal(plain(m.out.notices).length, noticesBefore,
    "the replaced connection's reload states nothing: " + JSON.stringify(plain(m.out.notices).slice(noticesBefore)));
  assert.deepEqual(texts(m.out.messages), ["the new connection"], "and the new connection's own read is what is on screen");
  m.unmount();
});

/**
 * A read the fold refused is not a read that established the conversation, whatever the auxiliary state read says.
 *
 * The transcript and the composer state are two reads, and only the first is ordered by the fold. A refused window is an
 * older statement of a conversation the surface already shows a newer one of; letting the state read answer on its own
 * and calling the pair "accepted" is how a reload comes to claim it reloaded a conversation whose window the surface
 * had just rejected. A refusal therefore ends the read, and the state query is not made on its behalf.
 */
test("a reload whose window the fold refused claims nothing, and asks for no state of it", async (t) => {
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  // The mount's own read answers revision 9; every read after it answers revision 1, an older window of the same
  // conversation. That is a refusal the fold makes, not a failure the transport reports, and it is what the probe this
  // case comes from reproduced: three reads, and a success notice naming resources of a reload nothing established.
  let reads = 0;
  const h = harness(t, (url, init) => url === "/api/conversations/conv/reload"
    ? respond({ resources: { skills: 3, prompts: 2 } })
    : !url.endsWith("/state") ? normal(url, init)
      : respond(nativeFrame({ revision: ++reads === 1 ? 9 : 1, text: reads === 1 ? "current" : "old" })));
  const reloads: ((() => Promise<ReloadOutcome>) | null)[] = [];
  const m = h.mount({ onConversationReloadChange: (reload) => reloads.push(reload) });
  await h.pump(m);
  const reload = reloads.at(-1);
  assert.ok(reload, "the surface registers its own reload");
  const noticesBefore = plain(m.out.notices).length;
  const readsBefore = h.requests.filter(r => r.url.endsWith("/state")).length;

  await reload();
  await h.pump(m);

  assert.equal(plain(m.out.notices).length, noticesBefore,
    "a window the fold refused is not a reload this conversation picked up: " + JSON.stringify(plain(m.out.notices).slice(noticesBefore)));
  assert.equal(h.requests.filter(r => r.url.endsWith("/state")).length, readsBefore + 1,
    "and the refused read is the whole read: no state was asked for on behalf of the window nothing accepted");
  assert.deepEqual(texts(m.out.messages), ["current"],
    "the transcript still states the newer window the fold kept: " + JSON.stringify(texts(m.out.messages)));
  m.unmount();
});

/**
 * A reload route that answers after the connection was replaced is the replaced connection's answer.
 *
 * The route belongs to the client that sent it. A switch while it is in flight makes its rejection — a host that is
 * restarting, a credential that expired — a fact about a Backend the surface no longer shows, so stating it as the
 * current connection's failure would put one host's outage on another host's chat. The fence the read already gets is
 * applied before the notice, and the replaced reload asks for no read at all.
 */
test("a reload route that rejects after a connection switch states nothing on the surface that replaced it", async (t) => {
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  const stale = deferredRead();
  const h = harness(t, (url, init) => url === "/api/conversations/conv/reload" ? stale.promise : normal(url, init));
  const reloads: ((() => Promise<ReloadOutcome>) | null)[] = [];
  const m = h.mount({ onConversationReloadChange: (reload) => reloads.push(reload) });
  await h.pump(m);
  const reload = reloads.at(-1);
  assert.ok(reload, "the surface registers its own reload");
  // The reload is asked, and its route is the one still in flight when the connection is replaced underneath it.
  const pending = reload();
  await h.pump(m);
  m.switchConnection(h.anotherConnection(t));
  await h.pump(m);
  const noticesBefore = plain(m.out.notices).length;
  const readsBefore = h.requests.filter(r => r.url.endsWith("/state")).length;

  stale.releaseAt({ error: "old host restarting" }, 503);
  await pending;
  await h.pump(m);

  assert.equal(plain(m.out.notices).length, noticesBefore,
    "the replaced connection's route failure is not this surface's failure: " + JSON.stringify(plain(m.out.notices).slice(noticesBefore)));
  assert.equal(h.requests.filter(r => r.url.endsWith("/state")).length, readsBefore,
    "and the replaced connection's reload asks for no read of the conversation it no longer shows");
  m.unmount();
});

/**
 * One `/reload` is one notice.
 *
 * The operation states what it established, and the command line is a caller of that operation rather than a second
 * reporter of it. Two surfaces stating the same outcome is how a single reload reads as two — and how the composer,
 * told twice, reports a failure the operation had already reported once.
 */
test("a /reload command states its outcome once, for a success and for a failure", async (t) => {
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  for (const answer of ["reloaded", "failed"] as const) {
    const h = harness(t, (url, init) => {
      if (url === "/api/conversations/conv/reload") {
        return answer === "reloaded" ? respond({ resources: { skills: 3, prompts: 2 } }) : respond({ error: "the runtime is restarting" }, 503);
      }
      return normal(url, init);
    });
    const m = h.mount();
    await h.pump(m);
    const noticesBefore = plain(m.out.notices).length;

    const result = await m.out.handleBuiltinSlashCommand("/reload");
    await h.pump(m);

    assert.equal(result.handled, true, answer + ": the command is the built-in's");
    const stated = plain(m.out.notices).slice(noticesBefore);
    assert.equal(stated.length, 1, answer + ": one reload is one notice: " + JSON.stringify(stated));
    if (answer === "reloaded") {
      assert.equal(stated[0].type, "success", "and it is the operation's success");
      assert.match(stated[0].message, /3 skills and 2 prompts/, "naming the resources the read established");
    } else {
      assert.equal(stated[0].type, "error", "and it is the operation's failure");
      assert.match(stated[0].message, /Reload failed/, "stated once, by the operation that owns it");
      // The result still carries the failure, so the composer keeps the text that asked for it. The command's error is
      // a signal to its caller, not a second report to the reader.
      assert.ok(result.handled && result.error, "the command line still hears that it failed");
    }
    m.unmount();
  }
});

/**
 * A read outlives the connection it was asked through, and the connection is what makes its answer stale.
 *
 * Two connections can hold a conversation with the **same** id — the durable ids are only unique inside one Backend — so
 * "is this still the same conversation?" is not the question that decides whether an answer may publish. A switch
 * replaces the client and its conversation API, and the read that was in flight then answers from the connection the
 * surface no longer shows. Every way that read can answer is covered, because all of them publish: a snapshot, the
 * `null` a `not_found` answers with, and a transport failure.
 */
test("a read that answers after a connection switch publishes nothing, whatever its conversation id says", async (t) => {
  cache.deleteSessionViewSnapshot(TEST_SCOPE, "conv");
  // One held read per outcome, each answered the way a real one would be: a window, the Backend's own not_found, and a
  // transport failure. Every one of them is the same conversation id, so a conversation-id fence passes them all.
  for (const answer of ["snapshot", "missing", "failure"] as const) {
    const stale = deferredRead();
    let reads = 0;
    const h = harness(t, url => !url.endsWith("/state") ? normal(url) : ++reads === 1 ? stale.promise : respond(nativeFrame({ text: "the new connection" })));
    const m = h.mount();
    await h.pump(m);
    // The connection is replaced underneath the mount: a switch is a new provider value, and the harness states one by
    // re-rendering this same hook instance inside it. The held read is the replaced connection's answer from here on,
    // so it is released after the switch rather than before it.
    m.switchConnection(h.anotherConnection(t));
    await h.pump(m);
    // The new connection reads the conversation for itself: that is what a switch asks of a surface, and it is the
    // window the surface shows from here on. What the replaced connection answers afterwards must not displace it.
    assert.deepEqual(texts(m.out.messages), ["the new connection"], answer + ": the new connection's own read is what is on screen");
    // The held read answers a window of the **same** conversation id: the case where a conversation-id fence is not
    // enough. The fence is the connection, and the identity of the object the read went through is that connection.
    if (answer === "snapshot") stale.release(nativeFrame({ text: "the replaced connection's answer" }));
    else if (answer === "missing") stale.releaseAt({ error: "not_found" }, 404);
    else stale.reject(new TypeError("Failed to fetch"));
    await h.pump(m);
    assert.deepEqual(texts(m.out.messages), ["the new connection"], answer + ": no window of the replaced connection is published");
    assert.equal(m.out.readFailure ?? null, null, answer + ": and no failure was stated for a connection that was already replaced");
    assert.equal(m.out.error ?? null, null, answer + ": and no error was stated for it");
    m.unmount();
  }
});
test("leaving a fresh composer unmounts it without deleting the text the reader typed", async (t) => {
  // The review finding: a connection replacement or an unmount ran a cleanup that cleared the composer's own draft, so
  // the unsent text and images of a fresh composer were gone from the store before anything could park or restore them.
  // Disposal is the selection's — it parks the draft under the folder's own key — never a lifecycle cleanup's.
  const fresh = harness(t, url => url === "/api/conversations" ? respond({ conversationId: "fresh" }) : normal(url));
  const composer = fresh.mount({ session: null, newSessionCwd: "/tmp", newSessionDraftKey: "new:kept:/tmp" });
  await fresh.pump(composer);
  const key = "new:kept:/tmp";
  composer.connection.drafts.setDraft(key, {
    value: "unsent before the connection changed",
    images: [{ data: "aW1n", mimeType: "image/png" }],
  });
  composer.unmount();
  // The cleanup is a microtask when it exists at all: give it the tick it would have used.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(composer.connection.drafts.getDraft(key)?.value, "unsent before the connection changed",
    "the composer's text survives the unmount");
  assert.equal(composer.connection.drafts.getDraft(key)?.images.length, 1, "and so does its attached image");
});
