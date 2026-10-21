import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const store = await jiti.import<typeof import("./draft-store.ts")>("./draft-store.ts");
type ChatDraft = import("./draft-store.ts").ChatDraft;

/** The store shape the drafts are handed, as the module's own storage contract states it. */
type StoredEntry = { readonly key: string; readonly value: string };

/** The tab's own browser store, as the draft store reads it. */
type TestStorage = {
  readonly values: Map<string, string>;
  quotaExceeded: boolean;
  reads: number;
  writes: number;
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** The draft a read answered, asserted present so its fields are readable. */
function draftOf(draft: ChatDraft | null): ChatDraft {
  assert.ok(draft !== null, "the store answered with a draft");
  return draft;
}

/** A stand-in for the tab's own browser store, with the two failure modes a real one has. */
function createStorage(initial: Readonly<Record<string, string>> = {}): TestStorage {
  const values = new Map<string, string>(Object.entries(initial));
  const storage: TestStorage = {
    values,
    quotaExceeded: false,
    reads: 0,
    writes: 0,
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem(key: string) { storage.reads += 1; return values.get(key) ?? null; },
    setItem(key: string, value: string) {
      if (storage.quotaExceeded) throw new DOMException("QuotaExceededError");
      storage.writes += 1;
      values.set(key, value);
    },
    removeItem: (key: string) => { values.delete(key); },
  };
  return storage;
}

const image = { data: "YWJj", mimeType: "image/png" };
const KEY = "new:composer-1:/repo";
// The connection every draft in these cases belongs to. The store is scoped, so its storage entries carry this prefix.
const SCOPE = "web|backend-a|account-a";

/** One fresh store over a stated tab, which is what every case starts from. */
function fresh(storage: TestStorage = createStorage()): TestStorage {
  store.resetDraftStoreForTests();
  store.setDraftScope(SCOPE);
  store.hydrateDrafts(storage);
  return storage;
}

test("a draft survives a reload of the same tab, in another tab's own store, and keeps the synchronous contract", () => {
  const tab = fresh(createStorage());
  store.setDraft(KEY, { value: "unsent text", images: [image] });
  // The synchronous read the rest of the app performs sees it before any browser round trip.
  assert.deepEqual(store.getDraft(KEY), { value: "unsent text", images: [image] });
  // The move and clear operations keep their semantics across the browser store as well.
  assert.deepEqual(store.rekeyDraft(KEY, "session-1"), { value: "unsent text", images: [image] });
  assert.equal(store.getDraft(KEY), null);
  assert.deepEqual(store.getDraft("session-1"), { value: "unsent text", images: [image] });
  store.clearDraft("session-1");
  assert.equal(store.getDraft("session-1"), null);
  assert.equal(tab.values.size, 0, "clear drops both stored halves");

  store.setDraft(KEY, { value: "unsent text", images: [image] });
  // What the browser holds, read back by a second page of the same tab: this is the refresh.
  store.resetDraftStoreForTests();
  store.hydrateDrafts(tab);
  assert.deepEqual(store.getDraft(KEY), { value: "unsent text", images: [image] }, "the tab's own draft comes back");

  // Another tab has its own sessionStorage, so the same key is empty there rather than showing this tab's text.
  store.resetDraftStoreForTests();
  store.hydrateDrafts(createStorage());
  assert.equal(store.getDraft(KEY), null, "another tab's store holds none of this tab's draft");

  // A draft that is emptied is removed from the browser store, so a reload cannot resurrect it.
  store.resetDraftStoreForTests();
  store.hydrateDrafts(tab);
  store.setDraft(KEY, { value: "", images: [] });
  assert.equal(tab.values.size, 0, "an emptied draft leaves nothing to restore");
  store.resetDraftStoreForTests();
  store.hydrateDrafts(tab);
  assert.equal(store.getDraft(KEY), null, "clearing then reloading restores nothing");
});

test("the text half is written per change while the attachment half is written only when it changes", () => {
  const tab = fresh(createStorage());
  store.setDraft(KEY, { value: "a", images: [image] });
  const afterFirst = tab.writes;
  assert.equal(afterFirst, 2, "the first write stores text and images");
  for (const value of ["ab", "abc", "abcd"]) store.setDraft(KEY, { value, images: [image] });
  assert.equal(tab.writes, afterFirst + 3, "typing re-serializes the text only, never the attachment list");
  store.setDraft(KEY, { value: "abcd", images: [image, { data: "ZGVm", mimeType: "image/jpeg" }] });
  assert.equal(tab.writes, afterFirst + 4, "an attachment change writes the image half once");
  assert.deepEqual(store.getDraft(KEY), { value: "abcd", images: [image, { data: "ZGVm", mimeType: "image/jpeg" }] });
});

test("a browser that refuses the write drops the stale entry and reports the limit instead of implying the draft is kept", () => {
  const tab = fresh(createStorage());
  const issues = [];
  store.subscribeDraftStorageIssue(() => issues.push(store.getDraftStorageIssue(KEY)));

  store.setDraft(KEY, { value: "first", images: [] });
  assert.equal(store.getDraftStorageIssue(KEY), null, "a stored draft reports no limit");
  const writesBefore = tab.writes;
  tab.quotaExceeded = true;
  store.setDraft(KEY, { value: "second", images: [image] });
  assert.equal(tab.writes, writesBefore, "the refused write stored nothing");
  assert.ok(store.getDraftStorageIssue(KEY), "the browser's own refusal is reported");
  assert.equal(issues.length, 1, "the surface observing it is told once");
  // The draft itself is not lost: it is still this page's to send.
  assert.deepEqual(store.getDraft(KEY), { value: "second", images: [image] });
  // The entry that no longer describes the composer is gone, so a reload cannot restore the older text as current.
  store.resetDraftStoreForTests();
  store.hydrateDrafts(tab);
  assert.equal(store.getDraft(KEY), null, "the stale entry was removed rather than left to be restored");

  // A write that succeeds again clears the report.
  store.resetDraftStoreForTests();
  tab.quotaExceeded = true;
  store.hydrateDrafts(tab);
  store.setDraft(KEY, { value: "held", images: [] });
  assert.ok(store.getDraftStorageIssue(KEY));
  tab.quotaExceeded = false;
  store.setDraft(KEY, { value: "held", images: [] });
  assert.equal(store.getDraftStorageIssue(KEY), null, "a recovered write clears the report");
});

test("attachments a browser refused are not re-serialized on every keystroke after the refusal", () => {
  const tab = fresh(createStorage());
  // Realistic volume: several attachments whose base64 outweighs the ~5M-character sessionStorage budget.
  const heavy = Array.from({ length: 10 }, () => ({ data: "A".repeat(1_300_000), mimeType: "image/png" }));
  tab.quotaExceeded = true;
  store.setDraft(KEY, { value: "hello", images: heavy });
  const attempts = tab.writes;
  assert.ok(store.getDraftStorageIssue(KEY), "the refusal is reported");
  assert.deepEqual(store.getDraft(KEY), { value: "hello", images: heavy }, "the draft is still this page's to send");

  // Typing must not re-offer the same oversized attachment list to the store on every keystroke.
  for (const value of ["hello ", "hello t", "hello th"]) store.setDraft(KEY, { value, images: heavy });
  assert.equal(tab.writes, attempts, "an unchanged refused attachment list is not handed back per keystroke");

  // Dropping attachments is a real retry: the smaller draft may now fit.
  tab.quotaExceeded = false;
  store.setDraft(KEY, { value: "hello th", images: [image] });
  assert.equal(store.getDraftStorageIssue(KEY), null, "the retry after the attachments changed clears the report");
  store.resetDraftStoreForTests();
  store.hydrateDrafts(tab);
  assert.deepEqual(store.getDraft(KEY), { value: "hello th", images: [image] }, "and the smaller draft is stored");
});

test("an unreadable or malformed stored entry is ignored rather than restored as a wrong draft", () => {
  // The stored entry names are the store's own: the prefix, then this connection's scope, then the caller's key.
  const stored = (kind: string, key: string) => "pi-web:composer-draft:" + kind + ":" + SCOPE + "/" + key;
  const tab = fresh(createStorage({
    [stored("value", "good")]: JSON.stringify("kept"),
    [stored("images", "good")]: JSON.stringify([image, { data: "not base64!", mimeType: "image/png" }, { data: "YWJj", mimeType: "text/plain" }]),
    [stored("value", "broken")]: "{ not json",
    [stored("value", "wrongshape")]: JSON.stringify(7),
    [stored("images", "orphan")]: JSON.stringify([image]),
    [stored("value", "empty")]: JSON.stringify(""),
    // A draft another connection stored under the same key is not this page's composer.
    "pi-web:composer-draft:value:web|backend-b|account-a/good": JSON.stringify("other connection"),
  }));
  assert.deepEqual(store.getDraft("good"), { value: "kept", images: [image] }, "only entries within the attachment limits are kept");
  for (const key of ["broken", "wrongshape", "orphan", "empty", ""]) {
    assert.equal(store.getDraft(key), null, `stored ${JSON.stringify(key)} restores nothing`);
  }
  assert.equal(store.getDraft("good")?.images.length, 1);
});

test("a server render with no browser store still reads and writes drafts synchronously", () => {
  store.resetDraftStoreForTests();
  store.hydrateDrafts(null);
  store.setDraft(KEY, { value: "server", images: [] });
  assert.deepEqual(store.getDraft(KEY), { value: "server", images: [] });
  store.clearDraft(KEY);
  assert.equal(store.getDraft(KEY), null);
  store.resetDraftStoreForTests();
});

test("switching connection starts the composers empty and leaves the previous connection's drafts to it", () => {
  const tab = fresh(createStorage());
  store.setDraft(KEY, { value: "first connection", images: [image] });
  // Switching connection is the same page, a different connection: nothing of the old composer may be adopted, because
  // the conversation this key names on the new connection may not be the one the text was written for.
  store.setDraftScope("web|backend-b|account-a");
  assert.equal(store.getDraft(KEY), null, "the new connection starts empty");
  store.setDraft(KEY, { value: "second connection", images: [] });
  assert.equal(draftOf(store.getDraft(KEY)).value, "second connection");
  // The first connection's draft is still its own, not overwritten by the second connection's write.
  store.setDraftScope(SCOPE);
  assert.equal(draftOf(store.getDraft(KEY)).value, "first connection");
  // A reload of the second connection reads only its own entries out of the same tab store.
  store.resetDraftStoreForTests();
  store.setDraftScope("web|backend-b|account-a");
  store.hydrateDrafts(tab);
  assert.equal(draftOf(store.getDraft(KEY)).value, "second connection");
});
