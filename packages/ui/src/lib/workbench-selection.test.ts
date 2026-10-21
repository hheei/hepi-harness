import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createWorkbenchSelection, composerDraftKey, parkedComposerDraftKey } = await jiti.import<typeof import("./workbench-selection.ts")>("./workbench-selection.ts");
const { createDraftStore } = await jiti.import<typeof import("./draft-store.ts")>("./draft-store.ts");
type WorkbenchSelection = import("./workbench-selection.ts").WorkbenchSelection;
type WorkbenchSelectionDeps = import("./workbench-selection.ts").WorkbenchSelectionDeps;
type SessionInfo = import("./types.ts").SessionInfo;

/** One row as the catalogue states it, with only the fields a case reads. */
function row(id: string, cwd: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    path: "/sessions/" + id,
    id,
    cwd,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
    ...extra,
  };
}

/** One tab's own browser store, as the memories write through it. */
type Storage = {
  readonly values: Map<string, string>;
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function storage(initial: Record<string, string> = {}): Storage {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

/**
 * One workbench: a selection over a real draft store, with the page's own seams stated.
 *
 * The memories are the browser's, so the case installs a tab store as `window.sessionStorage` / `localStorage` and reads
 * back what a reload would: the same store, handed to a second selection.
 */
function workbench(overrides: Partial<WorkbenchSelectionDeps> & {
  catalogue?: SessionInfo[];
  /** Answers a by-id read; a throw is a read that failed. */
  open?: (sessionId: string) => Promise<SessionInfo>;
  validate?: (path: string) => Promise<{ cwd: string; projectKey?: string | null; projectRoot?: string | null; displayRoot?: string | null }>;
  search?: string;
} = {}) {
  const tab = storage();
  const local = storage();
  const globalAny = globalThis as unknown as { window?: unknown; sessionStorage?: unknown; localStorage?: unknown };
  globalAny.window = { sessionStorage: tab, localStorage: local };
  globalAny.sessionStorage = tab;
  globalAny.localStorage = local;
  const drafts = createDraftStore("test|backend|account");
  drafts.hydrate(tab);
  const navigations: string[] = [];
  let search = overrides.search ?? "";
  const catalogue = overrides.catalogue ?? [];
  const opened: string[] = [];
  const selection = createWorkbenchSelection({
    drafts,
    conversation: {
      open: async (sessionId) => {
        opened.push(sessionId);
        return overrides.open ? await overrides.open(sessionId) : row(sessionId, "/repo");
      },
    },
    validateCwd: overrides.validate ?? (async (path) => ({ cwd: path, projectKey: path, projectRoot: path, displayRoot: path })),
    navigate: (next) => { navigations.push(next); search = next; },
    query: () => new URLSearchParams(search),
    ...(overrides.onLanded === undefined ? {} : { onLanded: overrides.onLanded }),
  });
  // The catalogue is what the sidebar delivered, which is the only source a restore reads.
  if (overrides.catalogue !== undefined) selection.setCatalogue(overrides.catalogue);
  return { selection, drafts, tab, local, navigations, opened, currentSearch: () => search };
}

/** Let every microtask the selection scheduled run: a read that answers immediately is one tick away. */
async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

/** The selection's own readout, asserted to be the state a case is about. */
function state(selection: WorkbenchSelection) {
  return selection.getState();
}

test("an explicit URL wins over tab memory, and a cwd in it wins over a session", async () => {
  // N1: ?cwd and ?session together. The cwd is the fresh composer's, so no conversation is read at all.
  const withBoth = workbench({ search: "?cwd=%2Frepo&session=old" });
  withBoth.selection.start();
  assert.equal(state(withBoth.selection).initialCwd.status, "validating", "the cwd is validated before it is adopted");
  assert.deepEqual(withBoth.opened, [], "the cwd the URL named is the target; the session beside it is not read");
  await settle();
  assert.equal(state(withBoth.selection).composer?.cwd, "/repo");
  assert.equal(state(withBoth.selection).conversation, null);

  // ?session alone opens that conversation, and the URL is left as it is.
  const withSession = workbench({ search: "?session=abc" });
  withSession.selection.start();
  assert.deepEqual(withSession.opened, ["abc"]);
  assert.equal(withSession.navigations.length, 0, "a navigation that already names this session writes nothing");

  // A bare URL adopts this tab's memory: the composer it was showing, then the conversation.
  const restoredComposer = workbench({ search: "" });
  restoredComposer.selection.start();
  assert.equal(state(restoredComposer.selection).composer, null, "a tab with no memory opens nothing");

  // A tab that remembered a fresh composer reopens it, with the draft key it had.
  const remembered = storage({ "pi-web:tab-open-session": JSON.stringify({ kind: "new", cwd: "/repo", draftKey: "new:kept:/repo" }) });
  const reopened = workbench({ search: "" });
  reopened.tab.values.set("pi-web:tab-open-session", remembered.values.get("pi-web:tab-open-session")!);
  reopened.selection.start();
  await settle();
  assert.equal(state(reopened.selection).composer?.cwd, "/repo");
  assert.equal(state(reopened.selection).composer?.draftKey, "new:kept:/repo", "the composer the tab was showing comes back, not a new one");
});

test("a restored conversation and a restored composer keep the drafts they were holding", async () => {
  // N2: no explicit URL. The workspace memory restores the conversation; the composer memory restores a draft key.
  const w = workbench({ search: "", catalogue: [row("conv", "/repo")] });
  // What the tab held before the reload: the composer's own text, parked nowhere.
  w.drafts.setDraft("new:kept:/repo", { value: "half typed", images: [] });
  w.tab.values.set("pi-web:tab-open-session", JSON.stringify({ kind: "new", cwd: "/repo", draftKey: "new:kept:/repo" }));
  w.selection.start();
  await settle();
  assert.equal(state(w.selection).composer?.draftKey, "new:kept:/repo");
  assert.equal(w.drafts.getDraft("new:kept:/repo")?.value, "half typed", "the text comes back with the composer");

  // The workspace memory is what a bare route restores when the tab remembers a conversation: the selection is told the
  // catalogue and resolves it without a second read.
  const listed = workbench({ search: "?session=conv", catalogue: [row("conv", "/repo")] });
  listed.selection.start();
  await settle();
  assert.equal(state(listed.selection).conversation?.id, "conv");
  assert.equal(state(listed.selection).cwd, "/repo");
  assert.equal(listed.local.values.get("pi-web:last-open-by-workspace"), JSON.stringify({ "/repo": "conv" }), "the accepted selection is what the workspace memory records");
});

test("a read the reader already left changes nothing: no selection, no URL, no error panel", async () => {
  // N3: an open is in flight and the reader picks something else first.
  const w = workbench({ search: "" });
  w.selection.start();
  const slow = w.selection.openConversation("slow", {});
  // The reader's own choice lands while the read is still outstanding.
  w.selection.selectConversation(row("fast", "/other"));
  const navigationsAfterChoice = [...w.navigations];
  await slow;
  await settle();
  assert.equal(state(w.selection).conversation?.id, "fast", "the stale answer does not take the reader back");
  assert.equal(state(w.selection).cwd, "/other");
  assert.deepEqual(w.navigations, navigationsAfterChoice, "and it rewrites no URL");
  assert.equal(state(w.selection).openFailure, null, "nor does it state an error about a target nobody is on");

  // A read that fails after the reader moved on is not shown either.
  const failing = workbench({ search: "", open: async () => { throw Object.assign(new Error("gone"), { status: 404 }); } });
  failing.selection.start();
  const failingRead = failing.selection.openConversation("gone", {});
  failing.selection.selectConversation(row("kept", "/repo"));
  await failingRead;
  await settle();
  assert.equal(state(failing.selection).openFailure, null);
  assert.equal(state(failing.selection).conversation?.id, "kept");
});

test("identity hydration is not a switch, and a same-project worktree keeps the conversation", () => {
  // N4: the conversation is open, then its project key arrives, then the workspace moves within that project.
  const w = workbench({ search: "" });
  w.selection.start();
  w.selection.selectConversation(row("conv", "/repo/worktree-a"));
  const attachment = state(w.selection).attachment;
  const navigations = [...w.navigations];
  // The sidebar resolved the project identity the row did not carry: nothing moves.
  w.selection.acceptWorkspaceIdentity({ cwd: "/repo/worktree-a", projectKey: "/repo", projectRoot: "/repo", displayRoot: "/repo" });
  assert.equal(state(w.selection).conversation?.id, "conv", "the conversation stays");
  assert.equal(state(w.selection).projectKey, "/repo");
  assert.equal(state(w.selection).attachment, attachment, "identity hydration does not remount the chat");
  assert.deepEqual(w.navigations, navigations, "and writes no URL");

  // A checkout of the same project: the conversation stays open, the workspace around it moves.
  w.selection.selectWorkspace({ cwd: "/repo/worktree-b", projectKey: "/repo", projectRoot: "/repo" });
  assert.equal(state(w.selection).conversation?.id, "conv");
  assert.equal(state(w.selection).cwd, "/repo/worktree-b");
  assert.equal(state(w.selection).attachment, attachment, "a same-project worktree move does not remount the chat either");
  assert.deepEqual(w.navigations, navigations, "nor does it rewrite the URL");
});

test("a different project replaces the workspace, and the composer starts fresh there", () => {
  // N5: a conversation in one project, then a workspace of another.
  const w = workbench({ search: "" });
  w.selection.start();
  w.selection.selectConversation(row("conv", "/repo-a"));
  const before = state(w.selection).attachment;
  w.selection.selectWorkspace({ cwd: "/repo-b", projectKey: "/repo-b", projectRoot: "/repo-b", displayRoot: "/repo-b" });
  assert.equal(state(w.selection).conversation, null, "the previous project's conversation is left");
  assert.equal(state(w.selection).composer?.cwd, "/repo-b");
  assert.equal(state(w.selection).projectKey, "/repo-b");
  assert.equal(state(w.selection).attachment, before + 1, "a new composer is a new attachment");
  assert.equal(w.currentSearch(), "?cwd=%2Frepo-b");
});

test("a carried composer takes its live draft and leaves the destination's parked draft alone", () => {
  // N6: the composer's text and picks move to another cwd; the target's parked draft is not merged into it.
  const w = workbench({ search: "" });
  w.selection.start();
  w.selection.startComposer({ cwd: "/repo-a", projectKey: "/repo-a" });
  const source = state(w.selection).composer!.draftKey;
  w.drafts.setDraft(source, { value: "carried text", images: [] });
  // Something the user left in the destination folder earlier.
  w.drafts.setDraft(parkedComposerDraftKey("/repo-b"), { value: "parked there", images: [] });

  w.selection.startComposer({ cwd: "/repo-b", projectKey: "/repo-b" }, { carry: true });
  const destination = state(w.selection).composer!.draftKey;
  assert.notEqual(destination, source);
  assert.equal(w.drafts.getDraft(destination)?.value, "carried text", "the live draft travels with the composer");
  assert.equal(w.drafts.getDraft(source), null, "and leaves no composer holding it at the old key");
  assert.equal(w.drafts.getDraft(parkedComposerDraftKey("/repo-b"))?.value, "parked there", "the parked draft stays parked rather than merging");

  // The submission of that composer therefore targets the new cwd, which is the composer's own state.
  assert.equal(state(w.selection).composer?.cwd, "/repo-b");
});

test("New in the same folder parks the live draft and brings the folder's own draft back", async () => {
  // N7: leaving a composer and coming back; New in the same cwd starts a separate identity.
  const w = workbench({ search: "" });
  w.selection.start();
  w.selection.startComposer({ cwd: "/repo", projectKey: "/repo" });
  const first = state(w.selection).composer!.draftKey;
  w.drafts.setDraft(first, { value: "first composer", images: [] });

  // New in the same folder: a second identity, and the first draft is parked rather than taken.
  w.selection.startComposer({ cwd: "/repo", projectKey: "/repo" });
  const second = state(w.selection).composer!.draftKey;
  assert.notEqual(second, first, "New is its own identity");
  assert.equal(w.drafts.getDraft(second), null, "New does not adopt the composer that was on screen");
  assert.equal(w.drafts.getDraft(parkedComposerDraftKey("/repo"))?.value, "first composer", "the unsent text is kept, not deleted");

  // Leaving the folder parks what was on screen beside what was already parked: the folder keeps one slot, and the
  // existing policy is that a park merges rather than overwriting unsent text.
  w.drafts.setDraft(second, { value: "second composer", images: [] });
  w.selection.startComposer({ cwd: "/elsewhere", projectKey: "/elsewhere" });
  const parked = w.drafts.getDraft(parkedComposerDraftKey("/repo"))?.value ?? "";
  assert.match(parked, /first composer/);
  assert.match(parked, /second composer/);
  // Coming back to the folder restores that parked text, and nothing of it was deleted on the way.
  w.selection.startComposer({ cwd: "/repo", projectKey: "/repo" });
  assert.equal(w.drafts.getDraft(state(w.selection).composer!.draftKey)?.value, parked, "the folder's parked draft comes back");

});

test("a reload comes back to the composer the tab was showing, and takes nothing from that folder's park", async () => {
  // The park is what a *move* into the folder restores. A first frame is not a move: the reloaded composer keeps the draft
  // its own key names, so a draft from an earlier visit does not appear in a composer the reader never returned to by pick.
  const reload = workbench({ search: "" });
  reload.drafts.setDraft("new:kept:/repo", { value: "typed here", images: [] });
  reload.drafts.setDraft(parkedComposerDraftKey("/repo"), { value: "from an earlier visit", images: [] });
  reload.tab.values.set("pi-web:tab-open-session", JSON.stringify({ kind: "new", cwd: "/repo", draftKey: "new:kept:/repo" }));
  reload.selection.start();
  await settle();
  assert.equal(state(reload.selection).composer?.draftKey, "new:kept:/repo", "the tab's own composer identity comes back");
  assert.equal(state(reload.selection).composer?.cwd, "/repo");
  assert.equal(reload.drafts.getDraft("new:kept:/repo")?.value, "typed here", "with the text that composer held");
  assert.equal(reload.drafts.getDraft(parkedComposerDraftKey("/repo"))?.value, "from an earlier visit", "and the folder's parked draft stays parked");

  // A key the tab remembered for another folder is refused rather than applied: one workspace's draft is never attached
  // to another's composer, and the folder's own first-frame composer is invented instead.
  const drifted = workbench({ search: "?cwd=%2Fsrv%2Fother" });
  drifted.drafts.setDraft("new:kept:/repo", { value: "not yours", images: [] });
  drifted.tab.values.set("pi-web:tab-open-session", JSON.stringify({ kind: "new", cwd: "/repo", draftKey: "new:kept:/repo" }));
  drifted.selection.start();
  await settle();
  assert.equal(state(drifted.selection).composer?.cwd, "/srv/other");
  assert.notEqual(state(drifted.selection).composer?.draftKey, "new:kept:/repo", "a remembered key from another folder is refused");
  assert.equal(drifted.drafts.getDraft("new:kept:/repo")?.value, "not yours", "and the other folder's draft is untouched");
});

test("a promotion adopts the conversation the composer became, without clearing the draft it now owns", () => {
  // N8: the first submission's confirmation point. The hook rekeys the draft to the conversation's id; the selection
  // states the conversation and must not touch that draft.
  const w = workbench({ search: "" });
  w.selection.start();
  w.selection.startComposer({ cwd: "/repo", projectKey: "/repo" });
  const composerKey = state(w.selection).composer!.draftKey;
  w.drafts.setDraft(composerKey, { value: "the message being sent", images: [] });
  // What the hook does at the confirmation point, then the promotion.
  w.drafts.rekeyDraft(composerKey, "conv");
  w.selection.acceptPromotion(row("conv", "/repo"));
  assert.equal(state(w.selection).conversation?.id, "conv");
  assert.equal(state(w.selection).composer, null);
  assert.equal(w.drafts.getDraft("conv")?.value, "the message being sent", "the draft the conversation owns is untouched");
});

test("deleting a conversation leaves only when it is the one on screen, and keeps every draft", () => {
  // N9: the delete of the open conversation, then the delete of another one.
  const w = workbench({ search: "" });
  w.selection.start();
  w.selection.selectConversation(row("open", "/repo"));
  w.selection.selectConversation(row("other", "/repo"));
  // The first delete completes after the reader moved on: nothing happens.
  w.selection.conversationDeleted("open");
  assert.equal(state(w.selection).conversation?.id, "other", "a delete that outlived a switch leaves the reader where they are");

  // The conversation on screen is deleted: leave for the composer of its folder, with the draft still there.
  w.drafts.setDraft("other", { value: "unsent on other", images: [] });
  w.selection.conversationDeleted("other");
  assert.equal(state(w.selection).conversation, null);
  assert.equal(state(w.selection).composer?.cwd, "/repo", "the composer of the folder it was in");
  assert.equal(w.drafts.getDraft("other")?.value, "unsent on other", "the conversation's unsent text is not deleted with it");
  assert.equal(w.currentSearch(), "?cwd=%2Frepo");
});

test("a failed open states gone and unreadable differently, and a retry reads only", async () => {
  // N9: the two failure kinds and the recovery each offers.
  const missing = workbench({ search: "", open: async () => { throw Object.assign(new Error("gone"), { status: 404 }); } });
  missing.selection.start();
  await missing.selection.openConversation("gone");
  await settle();
  assert.equal(state(missing.selection).openFailure?.failure.kind, "missing", "a row the Backend says is gone is answered, not retried");
  assert.equal(state(missing.selection).conversation, null, "and the selection it failed to replace did not move");
  assert.equal(state(missing.selection).restoring, false);

  const unreachable = workbench({ search: "", open: async () => { throw new Error("socket closed"); } });
  unreachable.selection.start();
  await unreachable.selection.openConversation("flaky");
  await settle();
  assert.equal(state(unreachable.selection).openFailure?.failure.kind, "unreachable", "a read that never answered is retryable");
  // The retry repeats the read and nothing else: the same id, no navigation of its own.
  const before = [...unreachable.opened];
  await unreachable.selection.retryOpen();
  await settle();
  assert.deepEqual(unreachable.opened, [...before, "flaky"], "the retry is the same read again");

  // Staying put is a complete answer: the failure belongs to the request, not the selection.
  unreachable.selection.dismissOpenFailure();
  assert.equal(state(unreachable.selection).openFailure, null);
});

test("a navigation target is applied once, and the raw-history surface keeps its own position", () => {
  // N10's selection half: a plain re-selection resets nothing, an explicit entry is positioned, raw history gets its own.
  const w = workbench({ search: "" });
  w.selection.start();
  w.selection.selectConversation(row("conv", "/repo"));
  // A plain re-selection: the same conversation, no entry, and no reading position is reset.
  w.selection.selectConversation(row("conv", "/repo"));
  assert.equal(state(w.selection).navigation, null);
  assert.equal(state(w.selection).rawHistoryFocus, null);

  w.selection.selectConversation(row("conv", "/repo"), { entryId: "e7", blockIndex: 2 });
  assert.deepEqual(state(w.selection).navigation, { sessionId: "conv", entryId: "e7", blockIndex: 2 });
  assert.equal(state(w.selection).rawHistoryFocus, null, "the window carries this entry, so no raw-history position is needed");
  w.selection.navigationHandled("conv", "e7");
  assert.equal(state(w.selection).navigation, null, "the target is not applied twice");

  // An entry the window may not carry: the raw-history surface takes the reader there.
  w.selection.selectConversation(row("conv", "/repo"), { entryId: "dropped", rawHistory: true });
  assert.deepEqual(state(w.selection).rawHistoryFocus, { sessionId: "conv", entryId: "dropped" });
});

test("a late promotion for a composer the reader left replaces nothing", async () => {
  // N8's review finding: submit in composer A, then pick or type in B while A's admission is still pending. The answer
  // names A, so accepting it would put the reader in A's conversation and take B's draft off the screen.
  const w = workbench({ search: "", catalogue: [row("a-conv", "/repo")] });
  w.selection.start();
  w.selection.startComposer({ cwd: "/repo", projectKey: "/repo" });
  const first = state(w.selection).composer!.draftKey;
  // The reader moves to a second composer of the same folder and types in it.
  w.selection.startComposer({ cwd: "/repo", projectKey: "/repo" });
  const second = state(w.selection).composer!.draftKey;
  w.drafts.setDraft(second, { value: "what I am writing now", images: [] });
  const attachment = state(w.selection).attachment;

  w.selection.acceptPromotion(row("a-conv", "/repo"), first);
  assert.equal(state(w.selection).composer?.draftKey, second, "the composer the reader is in stays");
  assert.equal(state(w.selection).conversation, null, "and the abandoned submission does not become the selection");
  assert.equal(state(w.selection).attachment, attachment, "nothing was replaced on screen");
  assert.equal(w.drafts.getDraft(second)?.value, "what I am writing now", "B's draft is untouched");

  // The confirmation for the composer that is actually on screen is accepted.
  w.selection.acceptPromotion(row("b-conv", "/repo"), second);
  assert.equal(state(w.selection).conversation?.id, "b-conv");
});

test("an explicit workspace choice retires a pending open, and a same-project pick does not move the chat", async () => {
  // N3's review finding: an open of /b is in flight, the reader picks another checkout of the same project. The older
  // answer must not land on the workspace they chose.
  let releaseB: ((session: SessionInfo) => void) | null = null;
  const w = workbench({
    search: "",
    open: async () => await new Promise<SessionInfo>((resolve) => { releaseB = resolve; }),
  });
  w.selection.start();
  const pending = w.selection.openConversation("b");
  w.selection.selectConversation(row("a", "/a"), {});
  const attachment = state(w.selection).attachment;
  w.selection.selectWorkspace({ cwd: "/a/worktree", projectKey: "/a", projectRoot: "/a" });
  const navigations = [...w.navigations];
  releaseB!(row("b", "/b"));
  await pending;
  await settle();
  assert.equal(state(w.selection).conversation?.id, "a", "the workspace the reader picked is still what is on screen");
  assert.equal(state(w.selection).cwd, "/a/worktree", "and it is the checkout they picked");
  assert.deepEqual(w.navigations, navigations, "the stale answer rewrites no URL");
  assert.equal(state(w.selection).openFailure, null, "and states no failure");
  assert.equal(state(w.selection).attachment, attachment, "retiring the read is not a new attachment");
});

test("returning to a workspace restores the conversation its memory names, under the same fence", async () => {
  // N5's review finding: an explicit return to another project restores what that workspace was last showing, from the
  // catalogue it already has; a bare route still invents nothing.
  const catalogue = [row("b-conv", "/b"), row("a-conv", "/a")];
  const w = workbench({ search: "", catalogue });
  w.selection.start();
  w.selection.selectConversation(catalogue[0]!);
  assert.equal(w.local.values.get("pi-web:last-open-by-workspace"), JSON.stringify({ "/b": "b-conv" }));
  // Leave for another project, then come back to it.
  w.selection.selectWorkspace({ cwd: "/a", projectKey: "/a", projectRoot: "/a" });
  w.selection.setCatalogue(catalogue);
  w.selection.selectWorkspace({ cwd: "/b", projectKey: "/b", projectRoot: "/b" });
  await settle();
  assert.equal(state(w.selection).conversation?.id, "b-conv", "the workspace's remembered conversation comes back");
  assert.deepEqual(w.opened, [], "from the catalogue the sidebar delivered, not from a second read");

  // A workspace whose memory names nothing keeps its fresh composer.
  w.selection.selectWorkspace({ cwd: "/a", projectKey: "/a", projectRoot: "/a" });
  await settle();
  assert.equal(state(w.selection).composer?.cwd, "/a", "a workspace with no remembered conversation is its composer");
});

test("a same-project move is not a project transition, and another project is one", () => {
  // The shell's file tabs follow the accepted project: a resolved identity and a worktree move keep them, another
  // project's workspace does not.
  const w = workbench({ search: "" });
  w.selection.start();
  w.selection.selectConversation(row("conv", "/repo/worktree-a"));
  const settled = state(w.selection).projectTransition;

  w.selection.acceptWorkspaceIdentity({ cwd: "/repo/worktree-a", projectKey: "/repo", projectRoot: "/repo" });
  assert.equal(state(w.selection).projectTransition, settled, "learning which project the folder belongs to is not a transition");
  w.selection.selectWorkspace({ cwd: "/repo/worktree-b", projectKey: "/repo", projectRoot: "/repo" });
  assert.equal(state(w.selection).projectTransition, settled, "another checkout of the same project is not a transition either");

  w.selection.selectWorkspace({ cwd: "/other", projectKey: "/other", projectRoot: "/other" });
  assert.equal(state(w.selection).projectTransition, settled + 1, "another project is");
});

test("re-picking the conversation on screen keeps its attachment and still applies the target", () => {
  // N10's review finding: a row click on the conversation already open must not remount the chat and re-run its read.
  const w = workbench({ search: "" });
  w.selection.start();
  w.selection.selectConversation(row("conv", "/repo"));
  const attachment = state(w.selection).attachment;
  const navigations = [...w.navigations];
  w.selection.selectConversation(row("conv", "/repo"));
  assert.equal(state(w.selection).attachment, attachment, "the surface is the one already mounted");
  assert.deepEqual(w.navigations, navigations, "and the URL already names it");

  // A pick that names an entry is still that request.
  w.selection.selectConversation(row("conv", "/repo"), { entryId: "e9", rawHistory: true });
  assert.equal(state(w.selection).attachment, attachment, "still no remount");
  assert.deepEqual(state(w.selection).rawHistoryFocus, { sessionId: "conv", entryId: "e9" }, "but the target is applied");
});

test("a workspace chosen while the first frame is still validating leaves no pending restore", async () => {
  // The reader picks a folder before the URL's own cwd finished validating. The validation is retired with the read it
  // belonged to, so the page states the workspace they chose rather than a spinner for a request nobody is waiting on.
  let releaseValidate: ((answer: { cwd: string; projectKey: string }) => void) | null = null;
  const w = workbench({
    search: "?cwd=%2Fslow",
    validate: async () => await new Promise((resolve) => { releaseValidate = resolve; }),
  });
  w.selection.start();
  assert.equal(state(w.selection).initialCwd.status, "validating");
  w.selection.selectWorkspace({ cwd: "/picked", projectKey: "/picked", projectRoot: "/picked" });
  assert.equal(state(w.selection).initialCwd.status, "ready", "the retired validation states nothing pending");
  assert.equal(state(w.selection).restoring, false);
  assert.equal(state(w.selection).composer?.cwd, "/picked");
  releaseValidate!({ cwd: "/slow", projectKey: "/slow" });
  await settle();
  assert.equal(state(w.selection).composer?.cwd, "/picked", "and its late answer does not take the choice back");
  assert.equal(state(w.selection).initialCwd.status, "ready");
});

test("a remembered conversation comes only from the catalogue the sidebar delivered", () => {
  // N5's second review finding: a restore must not read a listing of its own — and a catalogue that has not arrived yet
  // is not evidence the conversation is gone, so the memory stands and the reader keeps the composer they were given.
  const w = workbench({ search: "" });
  w.selection.start();
  w.selection.selectConversation(row("b-conv", "/b"));
  // A workspace whose memory names a conversation, but whose catalogue this page has not received.
  const unseen = workbench({ search: "" });
  unseen.selection.start();
  unseen.local.values.set("pi-web:last-open-by-workspace", JSON.stringify({ "/b": "b-conv" }));
  unseen.selection.selectWorkspace({ cwd: "/b", projectKey: "/b", projectRoot: "/b" });
  assert.equal(state(unseen.selection).composer?.cwd, "/b", "the choice is a working composer, not a pending restore");
  assert.equal(state(unseen.selection).conversation, null);
  assert.equal(unseen.opened.length, 0, "and nothing is read to guess at it");
  assert.equal(unseen.local.values.get("pi-web:last-open-by-workspace"), JSON.stringify({ "/b": "b-conv" }),
    "the memory is not cleared on a catalogue that has not arrived");

  // Once the listing arrives and still names it, the row is restored.
  unseen.selection.setCatalogue([row("b-conv", "/b")]);
  unseen.selection.selectWorkspace({ cwd: "/a", projectKey: "/a", projectRoot: "/a" });
  unseen.selection.selectWorkspace({ cwd: "/b", projectKey: "/b", projectRoot: "/b" });
  assert.equal(state(unseen.selection).conversation?.id, "b-conv", "a delivered catalogue restores the remembered conversation");

  // A delivered listing that no longer carries the row clears the memory instead of retrying it forever.
  const gone = workbench({ search: "", catalogue: [row("other", "/b")] });
  gone.selection.start();
  gone.local.values.set("pi-web:last-open-by-workspace", JSON.stringify({ "/b": "b-conv" }));
  gone.selection.selectWorkspace({ cwd: "/b", projectKey: "/b", projectRoot: "/b" });
  assert.equal(state(gone.selection).composer?.cwd, "/b");
  assert.equal(gone.local.values.get("pi-web:last-open-by-workspace") ?? null, null, "a listing without the row is the answer that forgets it");
});
