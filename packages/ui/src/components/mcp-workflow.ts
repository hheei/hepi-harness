import type { McpExposure } from "@earendil-works/pi-coding-agent";
import type {
  CodemodeMode,
  McpActionResponse,
  McpCodemodePreference,
  McpResponse,
  McpScope,
  McpServerInfo,
  ProjectTrustStatus,
} from "@hepi/protocol/mcp-ui";
import {
  loadMcpOverview,
  mcpGroupSwitchTargets,
  mcpServerGroups,
  mcpServerKey,
  mcpTestAnswerOutdates,
  mcpTestBlock,
  mcpTestRunAfter,
  mcpTestRunAfterSignOut,
  pickMcpSelection,
  postMcpAction,
  postMcpTest,
  saveMcpCodemodeInlineBudget,
  saveMcpCodemodeMode,
  saveMcpCodemodePreference,
  withMcpCodemodeInlineBudget,
  withMcpCodemodeMode,
  withMcpCodemodePreference,
  type FetchLike,
  type McpActionFailure,
  type McpActionRequest,
  type McpActionResult,
  type McpLoadFailure,
  type McpTestRun,
} from "./mcp-config-helpers";
import {
  MCP_SIGN_IN_POLL_MS,
  cancelMcpSignInFlow,
  getMcpSignIn,
  mcpSignInActive,
  mcpSignInJustEnded,
  mcpSignInRunAfterCancel,
  mcpSignInRunAfterPaste,
  mcpSignInRunAfterPoll,
  mcpSignInRunAfterStart,
  pasteMcpSignIn,
  postMcpSignIn,
  type McpSignInRun,
} from "./mcp-sign-in-helpers";

/**
 * Settings › MCP's workflow (components/McpConfig.tsx): the overview, the writes
 * to it, and the two flows that run beside a write — Test and sign-in.
 *
 * What it owns is the part a panel would otherwise have to sequence by hand:
 *
 * - **one overview readout**, fenced by request, so a load answered after a
 *   change (or after a later load) cannot put back a listing the change
 *   replaced;
 * - **the selection** the listing implies: a load keeps the selected row while
 *   it still exists, a change that names a row (Add, Undo) selects it, and the
 *   view only states which row a person picked;
 * - **each write's pending/answered/failed state**, with the readback after it:
 *   a write's answer is the overview the route read after the change, and a
 *   refused or timed-out write reloads the listing rather than showing its
 *   intent as saved;
 * - **Test**, which writes no file and therefore runs beside writes, per
 *   server, its answer kept as that server's status while it is the newest;
 * - **sign-in**, whose flow lives on the server: it is polled while it is under
 *   way — from this object's own timers, not from anything a hidden tab or a
 *   re-render does — and it is released only when the panel is disposed.
 *
 * It is a plain object rather than a hook so the rules can be tested without a
 * renderer, and because a sign-in or a test outliving a render is the normal
 * case: the panel re-renders on every answer, and a flow that restarted with
 * each of those would cancel itself. `components/useMcpWorkflow.ts` is the one
 * React binding: it creates this per connection and folder, subscribes the
 * view to its snapshot, and disposes it at unmount.
 *
 * Every readout is in the snapshot; every intent is a method. The view keeps
 * the form fields it is editing (the paste, the budget) and the focus it must
 * restore, and never sees a controller, a request counter or a poll round.
 */

/** What the panel has loaded; a project the route refused leaves the global listing and `projectError`. */
export type McpConfigLoad =
  | { state: "loading" }
  | { state: "failed"; error: McpLoadFailure }
  | { state: "loaded"; data: McpResponse; projectError?: McpLoadFailure };

/** What saving the Code mode choice, mode or budget is doing: nothing, waiting for the route, or why it failed. */
export interface McpCodemodeSaveState {
  saving: boolean;
  error: McpLoadFailure | null;
  /** What the save is about, so its state shows in that row; the choice when absent. */
  target?: "preference" | "mode" | "inlineBudget";
}

/** What the last group switch left undone, under that group's heading. */
export interface McpGroupStatus {
  scope: McpScope;
  /** Servers that reference PI_WEB_PASSWORD, which the switch left off. */
  keptOff: number;
  /** The servers the route refused, of `total` asked for. */
  failures: { name: string; failure: McpActionFailure }[];
  total: number;
  /** The request as a whole failed. */
  error?: McpActionFailure;
}

/**
 * A removal that can still be undone, while its notice shows: the token the
 * route answered with, never the entry, which stays on the server.
 */
export interface McpUndoNotice {
  token: string;
  scope: McpScope;
  name: string;
  path: string;
  /** How long the route holds it, from when the notice appeared. */
  expiresInMs: number;
  undoing: boolean;
  error?: McpActionFailure;
}

/** What the last Add wrote, while its notice shows: the server and the file it went to. */
export interface McpAddedNotice {
  scope: McpScope;
  name: string;
  path: string;
  key: string;
}

/** A change to one server that failed, shown in that server's detail pane. */
export interface McpActionErrorState {
  key: string;
  failure: McpActionFailure;
}

/** Everything the panel shows, as one value a subscriber reads. */
export interface McpWorkflowSnapshot {
  readonly overview: McpConfigLoad;
  readonly refreshing: boolean;
  /** The selected row's key (`mcpServerKey()` or `MCP_CODEMODE_SELECTION`). */
  readonly selected: string | null;
  /** The change on its way, if any: `switch:<key>`, `exposure:<key>`, `remove:<key>`, `sign-out:<key>`, `group:<scope>`, `add` or `undo`. */
  readonly busy: string | null;
  readonly codemodeSave: McpCodemodeSaveState;
  readonly actionError: McpActionErrorState | null;
  readonly groupStatus: McpGroupStatus | null;
  readonly undo: McpUndoNotice | null;
  readonly added: McpAddedNotice | null;
  /** The panel's tests by server key: running, their last answer, or why one failed. */
  readonly tests: Readonly<Record<string, McpTestRun>>;
  /** The panel's sign-ins by server key: starting, the flow as last polled, or why a request failed. */
  readonly signIns: Readonly<Record<string, McpSignInRun>>;
}

/** One timer, as this module uses them; a test states its own so a poll or an expiry can be advanced. */
export interface McpWorkflowTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const SYSTEM_TIMERS: McpWorkflowTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface McpWorkflowOptions {
  /** The panel's project folder, which every request carries as its routing address. */
  readonly cwd: string | null;
  /** This connection's own request function: the routes resolve against its origin and carry its credential. */
  readonly send: FetchLike;
  /** The remembered row for this folder, or none. */
  readonly initialSelection?: string | null;
  /** Hands the page the folder's trust after an Add wrote to its `.pi/mcp.json`. */
  readonly onProjectTrustChanged?: (cwd: string, status: ProjectTrustStatus) => void;
  /** The clock a sign-in's deadline and a test's start are stated by. */
  readonly now?: () => number;
  readonly timers?: McpWorkflowTimers;
}

const EMPTY_SNAPSHOT: McpWorkflowSnapshot = {
  overview: { state: "loading" },
  refreshing: false,
  selected: null,
  busy: null,
  codemodeSave: { saving: false, error: null },
  actionError: null,
  groupStatus: null,
  undo: null,
  added: null,
  tests: {},
  signIns: {},
};

/** The snapshot of a panel that has no workflow yet: the first render, before the effect created one. */
export function idleMcpWorkflowSnapshot(): McpWorkflowSnapshot {
  return EMPTY_SNAPSHOT;
}

/** What one Code mode save answers, in the shape the workflow stores. */
type CodemodeSaveResult<T> = { ok: true; stored: T } | { ok: false; error: McpLoadFailure };

export class McpWorkflow {
  readonly #cwd: string | null;
  readonly #send: FetchLike;
  readonly #onProjectTrustChanged: ((cwd: string, status: ProjectTrustStatus) => void) | undefined;
  readonly #now: () => number;
  readonly #timers: McpWorkflowTimers;
  readonly #listeners = new Set<() => void>();
  #snapshot: McpWorkflowSnapshot;
  #disposed = false;
  /** Which overview read is the current one; a read answered under another number is dropped. */
  #request = 0;
  #loadController: AbortController | null = null;
  #saveController: AbortController | null = null;
  #actionController: AbortController | null = null;
  /** The test request on its way for each server, by key; an entry is only an identity. */
  readonly #testRequests = new Map<string, object>();
  #pollTimer: { readonly handle: unknown } | null = null;
  #pollController: AbortController | null = null;
  /** The set of flows the poll timer serves, so a change of set re-arms it and an unchanged one does not. */
  #pollKey = "";
  #undoTimer: { readonly handle: unknown } | null = null;
  #undoKey = "";

  constructor(options: McpWorkflowOptions) {
    this.#cwd = options.cwd;
    this.#send = options.send;
    this.#onProjectTrustChanged = options.onProjectTrustChanged;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? SYSTEM_TIMERS;
    this.#snapshot = { ...EMPTY_SNAPSHOT, selected: options.initialSelection ?? null };
  }

  /** The whole readout, as an immutable value; stable while nothing changed. */
  getSnapshot = (): McpWorkflowSnapshot => this.#snapshot;

  /** Told after every change of the snapshot; the return value releases the subscriber. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Releases everything this panel holds: the reads and writes on their way,
   * the sign-in polls and the undo notice's timer. A sign-in flow itself keeps
   * running on the server (Sign in joins it again) and a test is left to
   * finish there, because the route records what it found for the next visit.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#request += 1;
    this.#loadController?.abort();
    this.#loadController = null;
    this.#saveController?.abort();
    this.#saveController = null;
    this.#actionController?.abort();
    this.#actionController = null;
    this.#pollController?.abort();
    this.#pollController = null;
    this.#clearPollTimer();
    this.#clearUndoTimer();
    this.#testRequests.clear();
    this.#listeners.clear();
  }

  // -------------------------------------------------------------------------
  // The overview
  // -------------------------------------------------------------------------

  /**
   * Reads GET /api/mcp again. A load still on its way is dropped when this one
   * answers, and a load that answers after a change was applied is dropped by
   * `#applyOverview()`. A failed read leaves the listing unread rather than
   * empty, so nothing is shown as saved on the strength of a read that failed.
   */
  async refresh(): Promise<void> {
    if (this.#disposed) return;
    const request = ++this.#request;
    this.#loadController?.abort();
    const controller = new AbortController();
    this.#loadController = controller;
    this.#publish({ refreshing: true });
    const result = await loadMcpOverview(this.#cwd, this.#send, controller.signal);
    if (request !== this.#request || this.#disposed) return;
    this.#loadController = null;
    if (!result.ok) {
      this.#publish({ refreshing: false, overview: { state: "failed", error: result.error } });
      return;
    }
    this.#publish({
      refreshing: false,
      overview: {
        state: "loaded",
        data: result.data,
        ...(result.projectError ? { projectError: result.projectError } : {}),
      },
      selected: pickMcpSelection(mcpServerGroups(result.data, Boolean(this.#cwd)), this.#snapshot.selected),
    });
  }

  /** Selects a row (or none); a notice about another row goes with the row it was about. */
  select(key: string | null): void {
    this.#publish({
      selected: key,
      actionError: null,
      added: this.#snapshot.added?.key === key ? this.#snapshot.added : null,
    });
  }

  /** The Add pane took the list's place: its notices go, the row it was added to stays selected. */
  prepareAdd(): void {
    this.#publish({ added: null, actionError: null });
  }

  // -------------------------------------------------------------------------
  // Code mode settings
  // -------------------------------------------------------------------------

  saveCodemodePreference(preference: McpCodemodePreference): Promise<void> {
    return this.#saveCodemode("preference",
      async (signal) => {
        const result = await saveMcpCodemodePreference(preference, this.#send, signal);
        return result.ok ? { ok: true, stored: result.preference } : result;
      },
      withMcpCodemodePreference);
  }

  saveCodemodeMode(mode: CodemodeMode): Promise<void> {
    return this.#saveCodemode("mode",
      async (signal) => {
        const result = await saveMcpCodemodeMode(mode, this.#send, signal);
        return result.ok ? { ok: true, stored: result.mode } : result;
      },
      withMcpCodemodeMode);
  }

  saveCodemodeInlineBudget(budget: number | null): Promise<void> {
    return this.#saveCodemode("inlineBudget",
      async (signal) => {
        const result = await saveMcpCodemodeInlineBudget(budget, this.#send, signal);
        return result.ok ? { ok: true, stored: result.inlineBudget } : result;
      },
      withMcpCodemodeInlineBudget);
  }

  // -------------------------------------------------------------------------
  // Servers
  // -------------------------------------------------------------------------

  async setServerEnabled(server: McpServerInfo, enabled: boolean): Promise<McpActionResult | undefined> {
    const key = mcpServerKey(server);
    this.#clearOperationNotices();
    const result = await this.#runAction({ action: enabled ? "enable" : "disable", scope: server.scope, name: server.name }, `switch:${key}`);
    if (result && !result.ok) this.#publish({ actionError: { key, failure: result.error } });
    return result;
  }

  async setServerExposure(server: McpServerInfo, exposure: McpExposure): Promise<McpActionResult | undefined> {
    const key = mcpServerKey(server);
    this.#clearOperationNotices();
    const result = await this.#runAction(
      { action: "set-exposure", scope: server.scope, name: server.name, exposure },
      `exposure:${key}`,
    );
    if (result && !result.ok) this.#publish({ actionError: { key, failure: result.error } });
    return result;
  }

  async removeServer(server: McpServerInfo): Promise<McpActionResult | undefined> {
    const key = mcpServerKey(server);
    this.#clearOperationNotices();
    const result = await this.#runAction({ action: "remove", scope: server.scope, name: server.name }, `remove:${key}`);
    if (!result) return undefined;
    if (!result.ok) {
      this.#publish({ actionError: { key, failure: result.error } });
      return result;
    }
    const removed = result.data.undo;
    if (removed) this.#publish({ undo: { ...removed, undoing: false } });
    return result;
  }

  /** Puts back the server the undo notice names, and selects the row it comes back to. */
  async undoRemoval(): Promise<McpActionResult | undefined> {
    const notice = this.#snapshot.undo;
    if (!notice) return undefined;
    this.#clearOperationNotices();
    this.#publish({ undo: { ...notice, undoing: true, error: undefined } });
    const result = await this.#runAction(
      { action: "undo", token: notice.token },
      "undo",
      (data) => (data.restored ? mcpServerKey(data.restored) : undefined),
    );
    if (!result) return undefined;
    const current = this.#snapshot.undo;
    if (current?.token === notice.token) {
      this.#publish({ undo: result.ok ? null : { ...current, undoing: false, error: result.error } });
    }
    return result;
  }

  /**
   * Switches a whole group in one request, answered per server: the ones the
   * route refuses keep their state and are named under the heading, and so are
   * the ones referencing PI_WEB_PASSWORD, which switching on leaves off.
   */
  async setGroupEnabled(scope: McpScope, servers: readonly McpServerInfo[], enabled: boolean): Promise<McpActionResult | undefined> {
    const { targets, keptOff } = mcpGroupSwitchTargets(servers, enabled);
    this.#publish({ actionError: null, groupStatus: keptOff > 0 ? { scope, keptOff, failures: [], total: 0 } : null });
    if (targets.length === 0) return undefined;
    const result = await this.#runAction(
      { action: "set-enabled", enabled, servers: targets.map(({ scope: serverScope, name }) => ({ scope: serverScope, name })) },
      `group:${scope}`,
    );
    if (!result) return undefined;
    if (!result.ok) {
      this.#publish({ groupStatus: { scope, keptOff, failures: [], total: targets.length, error: result.error } });
      return result;
    }
    const results = result.data.results ?? [];
    const failures = results
      .filter((item) => item.reason !== undefined)
      .map((item) => ({ name: item.name, failure: { error: item.error ?? "", reason: item.reason } }));
    this.#publish({ groupStatus: failures.length > 0 || keptOff > 0 ? { scope, keptOff, failures, total: results.length } : null });
    return result;
  }

  /**
   * Signs out of a server's URL through POST /api/mcp, which answers with the
   * overview like any change. The route then forgets what connections found,
   * so this panel's own test answers go too, or one would read Connected over
   * the untested entry until Settings closed.
   */
  async signOut(server: McpServerInfo): Promise<McpActionResult | undefined> {
    const key = mcpServerKey(server);
    this.#clearOperationNotices();
    this.#setSignIn(key, { ...this.#snapshot.signIns[key], signOutError: undefined, signedOut: undefined });
    const result = await this.#runAction({ action: "sign-out", scope: server.scope, name: server.name }, `sign-out:${key}`);
    if (!result) return undefined;
    this.#setSignIn(key, result.ok
      ? { signedOut: { removed: result.data.signedOut?.removed === true } }
      : { ...this.#snapshot.signIns[key], signOutError: result.error });
    if (result.ok) {
      const next = mcpTestRunAfterSignOut(this.#snapshot.tests[key], this.#now());
      if (next) this.#publish({ tests: { ...this.#snapshot.tests, [key]: next } });
    }
    return result;
  }

  /**
   * Adds a server, after the pane's own preview and its explicit click. The
   * answer names the server it wrote, which is selected and tested once (an
   * install link hides its command until the preview, so a test before it
   * would connect nothing), and a folder whose trust the write changed is
   * handed to the page.
   *
   * The draft the person typed belongs to the view, which is why the answer is
   * returned: while the request is out the pane stays editable, and only the
   * view knows whether the answer still describes the draft it sent.
   */
  async add(request: Extract<McpActionRequest, { action: "add" }>): Promise<McpActionResult | undefined> {
    this.#clearOperationNotices();
    const result = await this.#runAction(request, "add", (data) => (data.added ? mcpServerKey(data.added) : undefined));
    if (!result) return undefined;
    if (!result.ok) {
      // A folder that changed under the step: the page shows its trust as it is now.
      if (result.error.trust && this.#cwd) this.#onProjectTrustChanged?.(this.#cwd, result.error.trust);
      return result;
    }
    const { added: written, trust: writtenTrust } = result.data;
    if (writtenTrust && this.#cwd) this.#onProjectTrustChanged?.(this.#cwd, writtenTrust);
    if (!written) return result;
    this.#publish({ added: { ...written, key: mcpServerKey(written) } });
    const listed = result.data.servers.find((item) => mcpServerKey(item) === mcpServerKey(written));
    if (listed && !mcpTestBlock(listed, result.data)) void this.test(listed);
    return result;
  }

  // -------------------------------------------------------------------------
  // Test
  // -------------------------------------------------------------------------

  /**
   * Tests one server through POST /api/mcp/test. It writes no file, so it runs
   * beside changes and other tests; one test per server at a time. An answer
   * that shows the listing is out of date loads it again.
   */
  async test(server: McpServerInfo): Promise<void> {
    const key = mcpServerKey(server);
    if (this.#testRequests.has(key) || this.#disposed) return;
    const request = {};
    this.#testRequests.set(key, request);
    this.#publish({
      tests: {
        ...this.#snapshot.tests,
        [key]: { ...this.#snapshot.tests[key], running: true, startedAt: this.#now(), error: undefined, queueTimedOut: undefined, configKey: undefined },
      },
    });
    // As for a change: the project only when the listing covers it. A global stdio server runs there, else in the home folder.
    const result = await postMcpTest({ scope: server.scope, name: server.name }, this.#requestedCwd(), this.#send);
    // Closed meanwhile: nothing is left to update.
    if (this.#testRequests.get(key) !== request || this.#disposed) return;
    this.#testRequests.delete(key);
    this.#publish({ tests: { ...this.#snapshot.tests, [key]: mcpTestRunAfter(this.#snapshot.tests[key], result, server.configKey) } });
    const overview = this.#snapshot.overview;
    const listed = overview.state === "loaded" ? overview.data.servers.find((item) => mcpServerKey(item) === key) : undefined;
    if (mcpTestAnswerOutdates(result, listed)) void this.refresh();
  }

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------

  /**
   * Starts signing in to a server, or joins the flow under way for its URL.
   * The route answers at once and the flow runs on the server; from here it is
   * polled until it ends or its time limit passes, whatever the panel is
   * showing meanwhile.
   */
  async signIn(server: McpServerInfo): Promise<void> {
    const key = mcpServerKey(server);
    const current = this.#snapshot.signIns[key];
    if (current?.starting || mcpSignInActive(current)) return;
    this.#setSignIn(key, { starting: true });
    const result = await postMcpSignIn({ scope: server.scope, name: server.name }, this.#requestedCwd(), this.#send);
    if (this.#disposed) return;
    this.#setSignIn(key, mcpSignInRunAfterStart(result, this.#now()));
    // A refusal with a reason may mean the listing is out of date, as for a test.
    if (!result.ok && result.error.reason !== undefined && !result.error.timedOut) void this.refresh();
  }

  /** Hands the server the address the browser landed on; a refused one leaves the sign-in waiting. */
  async pasteSignIn(server: McpServerInfo, flowId: string, value: string): Promise<void> {
    const key = mcpServerKey(server);
    const run = this.#snapshot.signIns[key];
    if (run?.flow?.flowId === flowId) this.#setSignIn(key, { ...run, pasting: true, pasteError: undefined });
    const result = await pasteMcpSignIn(flowId, value, this.#send);
    if (this.#disposed) return;
    const next = mcpSignInRunAfterPaste(this.#snapshot.signIns[key], flowId, result, this.#now());
    if (next !== undefined) this.#setSignIn(key, next);
  }

  /** Cancels a sign-in; the flow's own answer is what the next poll reads. */
  async cancelSignIn(server: McpServerInfo, flowId: string): Promise<void> {
    const key = mcpServerKey(server);
    const run = this.#snapshot.signIns[key];
    if (run?.flow?.flowId === flowId) this.#setSignIn(key, { ...run, cancelling: true });
    const result = await cancelMcpSignInFlow(flowId, this.#send);
    if (this.#disposed) return;
    const next = mcpSignInRunAfterCancel(this.#snapshot.signIns[key], flowId, result, this.#now());
    if (next !== undefined) this.#setSignIn(key, next);
  }

  // -------------------------------------------------------------------------
  // Inside
  // -------------------------------------------------------------------------

  #publish(patch: Partial<McpWorkflowSnapshot>): void {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#reconcileTimers();
    for (const listener of this.#listeners) listener();
  }

  #clearOperationNotices(): void {
    this.#publish({ actionError: null, groupStatus: null });
  }

  /** The folder a write, a test or a sign-in carries: the panel's project only when the listing covers one. */
  #requestedCwd(): string | null {
    const overview = this.#snapshot.overview;
    return overview.state === "loaded" && overview.data.project ? this.#cwd : null;
  }

  #setSignIn(key: string, next: McpSignInRun): void {
    const previous = this.#snapshot.signIns[key];
    if (next === previous) return;
    this.#publish({ signIns: { ...this.#snapshot.signIns, [key]: next } });
    // A flow that ended changed mcp-auth.json and recorded what connecting found: the overview is read
    // again, for Signed in and the Connection row.
    if (mcpSignInJustEnded(previous, next)) void this.refresh();
  }

  async #saveCodemode<T>(
    target: NonNullable<McpCodemodeSaveState["target"]>,
    save: (signal: AbortSignal) => Promise<CodemodeSaveResult<T>>,
    withStored: (data: McpResponse, stored: T) => McpResponse,
  ): Promise<void> {
    this.#saveController?.abort();
    const controller = new AbortController();
    this.#saveController = controller;
    this.#publish({ codemodeSave: { saving: true, error: null, target } });
    const result = await save(controller.signal);
    // Closed meanwhile: nothing is left to update.
    if (this.#saveController !== controller || this.#disposed) return;
    this.#saveController = null;
    this.#publish({ codemodeSave: { saving: false, error: result.ok ? null : result.error, target } });
    if (result.ok) {
      const overview = this.#snapshot.overview;
      if (overview.state === "loaded") this.#publish({ overview: { ...overview, data: withStored(overview.data, result.stored) } });
    }
    // Read back what is stored: a save that timed out may still land, and one
    // refused because the file no longer parses should show that file's error.
    void this.refresh();
  }

  /**
   * One change, on its way. Its answer is the overview read after it, which
   * replaces the listing; a load still on its way may predate the change, so it
   * is dropped. A refused change reloads the listing: the file may no longer
   * say what the panel showed (a server removed meanwhile, a file that no
   * longer parses), and a change that timed out may still have landed.
   */
  async #runAction(
    request: McpActionRequest,
    busyKey: string,
    select?: (data: McpActionResponse) => string | undefined,
  ): Promise<McpActionResult | undefined> {
    this.#actionController?.abort();
    const controller = new AbortController();
    this.#actionController = controller;
    this.#publish({ busy: busyKey });
    const result = await postMcpAction(request, this.#requestedCwd(), this.#send, controller.signal);
    // Closed meanwhile: nothing is left to update.
    if (this.#actionController !== controller || this.#disposed) return undefined;
    this.#actionController = null;
    this.#publish({ busy: null });
    if (result.ok) this.#applyOverview(result.data, select?.(result.data));
    else void this.refresh();
    return result;
  }

  #applyOverview(data: McpResponse, select?: string): void {
    this.#request += 1;
    this.#loadController?.abort();
    this.#loadController = null;
    const overview = this.#snapshot.overview;
    this.#publish({
      refreshing: false,
      overview: {
        state: "loaded",
        data,
        ...(overview.state === "loaded" && overview.projectError ? { projectError: overview.projectError } : {}),
      },
      selected: pickMcpSelection(mcpServerGroups(data, Boolean(this.#cwd)), select ?? this.#snapshot.selected),
    });
  }

  #reconcileTimers(): void {
    this.#reconcileUndo();
    this.#reconcilePoll();
  }

  #reconcileUndo(): void {
    const undo = this.#snapshot.undo;
    const key = undo === null ? "" : `${undo.token}\u0000${undo.expiresInMs}`;
    if (key === this.#undoKey) return;
    this.#undoKey = key;
    this.#clearUndoTimer();
    if (undo === null) return;
    const token = undo.token;
    this.#undoTimer = {
      handle: this.#timers.set(() => {
        this.#undoTimer = null;
        if (this.#snapshot.undo?.token === token) this.#publish({ undo: null });
      }, undo.expiresInMs),
    };
  }

  #clearUndoTimer(): void {
    if (this.#undoTimer === null) return;
    this.#timers.clear(this.#undoTimer.handle);
    this.#undoTimer = null;
  }

  /** The flows this panel is waiting on, by server key and flow id. */
  #activeFlows(): [string, string][] {
    return Object.entries(this.#snapshot.signIns).flatMap(([key, run]) => (
      mcpSignInActive(run) && run.flow ? [[key, run.flow.flowId] as [string, string]] : []
    ));
  }

  #reconcilePoll(): void {
    const key = this.#activeFlows().map(([serverKey, flowId]) => `${serverKey}\u0001${flowId}`).join("\u0002");
    if (key !== this.#pollKey) {
      // The set of flows changed: the armed timer is for the old set. A round already out is left to
      // finish — its answers are dropped per flow when that flow is no longer the one shown — because
      // aborting it would also end the poll of every other flow in the same round.
      this.#pollKey = key;
      this.#clearPollTimer();
    }
    if (this.#pollKey === "" || this.#pollTimer !== null || this.#pollController !== null) return;
    this.#pollTimer = {
      handle: this.#timers.set(() => {
        this.#pollTimer = null;
        void this.#pollRound();
      }, MCP_SIGN_IN_POLL_MS),
    };
  }

  #clearPollTimer(): void {
    if (this.#pollTimer === null) return;
    this.#timers.clear(this.#pollTimer.handle);
    this.#pollTimer = null;
  }

  /**
   * One round: ask where each flow under way stands. A round is followed by
   * another while any flow is still under way, which is what makes a sign-in
   * continue while its tab is hidden and end only by its own limit, a cancel or
   * a failure — and stop when this panel is disposed.
   */
  async #pollRound(): Promise<void> {
    const controller = new AbortController();
    this.#pollController = controller;
    try {
      for (const [key, flowId] of this.#activeFlows()) {
        // A paste or cancel answered while this poll is out is newer than what it brings back.
        const sentVersion = this.#snapshot.signIns[key]?.version ?? 0;
        const result = await getMcpSignIn(flowId, this.#send, controller.signal);
        if (controller.signal.aborted || this.#disposed) return;
        const next = mcpSignInRunAfterPoll(this.#snapshot.signIns[key], flowId, result, this.#now(), sentVersion);
        if (next !== undefined) this.#setSignIn(key, next);
      }
    } finally {
      if (this.#pollController === controller) this.#pollController = null;
      if (!controller.signal.aborted) this.#reconcilePoll();
    }
  }
}
