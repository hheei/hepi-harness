import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";
import { scopedKey } from "./connection-scope";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

/**
 * The drafts one connection's composers hold, and the browser store they survive a refresh in.
 *
 * The store is an **instance per connection**, created with the connection and read from it, so a scope is a property of
 * the value a surface holds rather than a module global that a render installs. That is what makes the old question —
 * "is the module's scope still the one this composer's key belongs to?" — unaskable: a composer can only reach the store
 * of the connection it is rendered under, and a tree the page has already replaced writes to the previous connection's
 * entries, which nothing on screen reads.
 *
 * The synchronous owner is the memory `Map` below: reading, writing, moving and clearing a draft stay ordinary
 * synchronous operations, and nothing here awaits. The browser entry is a mirror of that map, in `sessionStorage` — the
 * one per-tab store the browser offers, which survives a reload and an in-app navigation and is never shared with
 * another tab. So a hard refresh finds *this* tab's own unsent text and images, while the same conversation open in
 * another tab keeps its own composer. Nothing here is a server document or a cross-window one: a draft is this page's
 * scratch, and the durable transcript is the message that was sent.
 *
 * Text and images are stored under **separate entries**, because they change at very different rates: the text entry is
 * rewritten per keystroke and stays small, while the image entry is rewritten only when the attachment list changes and
 * is the expensive one. One combined entry would re-serialize every attachment on every keystroke.
 *
 * A browser that refuses the write — a quota is the real case, since an attachment list can outweigh the storage a tab
 * is given — is not silently obeyed: the entries are dropped (they no longer describe the composer) and the refusal is
 * reported through `getDraftStorageIssue`, so the surface holding that draft can say what would not survive rather
 * than implying that it would. The draft itself stays in memory: the user has lost nothing they can still send.
 *
 * Every key this store holds is inside its connection's scope, and the scope is part of the storage entry's own name. Two
 * connections can therefore hold a conversation with the same id without sharing a composer: a draft written under one
 * scope is not readable under another, and switching connection starts from empty rather than adopting the previous
 * connection's unsent text or attachments. Nothing is imported from a previous scope — the values it held describe a
 * conversation this connection may not have.
 *
 * Known limit of the switch itself: a page still running the **previous** build holds its drafts in memory only, so
 * those cannot be checkpointed retroactively — the cutover guide has the user copy the unsent text and save any
 * attached image before the first refresh, and every reload after that is covered by this store.
 */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const VALUE_ENTRY_PREFIX = "pi-web:composer-draft:value:";
const IMAGES_ENTRY_PREFIX = "pi-web:composer-draft:images:";

/** The drafts of one connection: the composers it is showing, keyed the way callers always keyed them. */
export interface DraftStore {
  /** The connection scope every entry of this store carries. */
  readonly scope: string;
  /**
   * Adopt this tab's stored drafts for this scope. Called lazily by the first read or write and safe to call again
   * after a test replaced the browser store; safe on the server, where there is no browser storage at all.
   */
  hydrate(browserStorage?: StorageLike | null): void;
  getDraft(key: string): ChatDraft | null;
  setDraft(key: string, draft: ChatDraft): void;
  clearDraft(key: string): void;
  /** Move one draft to another key, merging into whatever the target already holds. */
  rekeyDraft(previousKey: string, nextKey: string, currentDraft?: ChatDraft): ChatDraft | null;
  /** Put a rejected submission's text and images back, merged with what the target key already holds. */
  restoreSubmission(key: string, text: string, images?: ChatDraftImage[]): ChatDraft;
  /** The browser's own reason for refusing to keep this key's draft, or null when it was kept. */
  getDraftStorageIssue(key: string): string | null;
  /** Observe refusals and recoveries, so the surface showing this draft can state the limit while it holds it. */
  subscribeDraftStorageIssue(listener: () => void): () => void;
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function withinLimits(images: readonly ChatDraftImage[]): ChatDraftImage[] {
  return images
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(({ data, mimeType }) => ({ data, mimeType }));
}

function readValue(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function readImages(raw: string | null): ChatDraftImage[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? withinLimits(parsed as ChatDraftImage[]) : [];
  } catch {
    return [];
  }
}

function sameImages(a: readonly ChatDraftImage[] | undefined, b: readonly ChatDraftImage[]): boolean {
  if (a === undefined || a.length !== b.length) return false;
  return a.every((image, index) => image.data === b[index].data && image.mimeType === b[index].mimeType);
}

/**
 * The drafts of one connection.
 *
 * `scope` is part of every entry's name, and `browserStorage` is this tab's own store — passed in by a test, discovered
 * lazily from the platform by the product.
 */
export function createDraftStore(scope: string, initialStorage?: StorageLike | null): DraftStore {
  const drafts = new Map<string, ChatDraft>();
  /** What the store was last told for a key, per half, so an unchanged half is not serialized again. */
  const persistedValues = new Map<string, string>();
  const persistedImages = new Map<string, ChatDraftImage[]>();
  /** The attachment list this browser refused, so the same bytes are not re-offered on every keystroke. */
  const refusedImages = new Map<string, ChatDraftImage[]>();
  /** The keys this browser refused to store, with its own reason. Reported, never passed off as a kept draft. */
  const storageIssues = new Map<string, string>();
  const issueListeners = new Set<() => void>();
  let storage: StorageLike | null = initialStorage ?? null;
  let hydrated = false;

  /** The storage entry name and the in-memory name one caller's key has under this connection. */
  const scoped = (key: string): string => scopedKey(scope, key);

  function notifyDraftStorageIssue(): void {
    for (const listener of issueListeners) listener();
  }

  function removeStoredDraft(key: string): void {
    persistedValues.delete(key);
    persistedImages.delete(key);
    if (!storage) return;
    try {
      storage.removeItem(VALUE_ENTRY_PREFIX + scoped(key));
      storage.removeItem(IMAGES_ENTRY_PREFIX + scoped(key));
    } catch {
      // A store that cannot be written cannot be read back either; the memory this page owns is unaffected.
    }
  }

  function persistDraft(key: string, draft: ChatDraft): void {
    if (!storage) return;
    // An attachment list the browser has already refused is not handed to it again while it stands unchanged: a refusal
    // is about these bytes, and re-serializing them on every keystroke is the very cost the separate entries exist to
    // avoid. The retry that can succeed is the one where the attachments changed — usually because they got smaller — so
    // typing alone is not a retry. A refusal with no attachments at all is cheap to re-attempt, and is left to retry
    // because such a store may simply have become writable again.
    const refused = refusedImages.get(key);
    if (refused !== undefined && refused.length > 0 && sameImages(refused, draft.images)) return;
    try {
      if (persistedValues.get(key) !== draft.value) {
        storage.setItem(VALUE_ENTRY_PREFIX + scoped(key), JSON.stringify(draft.value));
        persistedValues.set(key, draft.value);
      }
      // The attachment half is the expensive one, so it is written only when it actually changed.
      if (!sameImages(persistedImages.get(key), draft.images)) {
        storage.setItem(IMAGES_ENTRY_PREFIX + scoped(key), JSON.stringify(draft.images));
        persistedImages.set(key, draft.images.map((image) => ({ ...image })));
      }
      refusedImages.delete(key);
      if (storageIssues.delete(key)) notifyDraftStorageIssue();
    } catch (error) {
      // The entry this key had no longer describes what the composer holds, so both halves go rather than restoring a
      // stale value later as if it were current.
      removeStoredDraft(key);
      refusedImages.set(key, draft.images.map((image) => ({ ...image })));
      if (storageIssues.has(key)) return;
      storageIssues.set(key, error instanceof Error ? error.message : String(error));
      notifyDraftStorageIssue();
    }
  }

  function hydrate(browserStorage?: StorageLike | null): void {
    if (hydrated) return;
    hydrated = true;
    storage = browserStorage === undefined ? (storage ?? getBrowserStorage()) : browserStorage;
    if (storage === null) return;
    try {
      const values = new Map<string, string>();
      const images = new Map<string, ChatDraftImage[]>();
      for (let index = 0; index < storage.length; index += 1) {
        const rawKey = storage.key(index);
        if (typeof rawKey !== "string") continue;
        if (rawKey.startsWith(VALUE_ENTRY_PREFIX)) {
          const stored = rawKey.slice(VALUE_ENTRY_PREFIX.length);
          // Only this connection's entries are adopted: another scope's draft is not this page's composer.
          if (!stored.startsWith(scoped(""))) continue;
          const key = stored.slice(scoped("").length);
          const value = readValue(storage.getItem(rawKey));
          if (key && value !== null) {
            values.set(key, value);
            persistedValues.set(key, value);
          }
        } else if (rawKey.startsWith(IMAGES_ENTRY_PREFIX)) {
          const name = rawKey.slice(IMAGES_ENTRY_PREFIX.length);
          if (!name.startsWith(scoped(""))) continue;
          const key = name.slice(scoped("").length);
          if (!key) continue;
          const stored = readImages(storage.getItem(rawKey));
          images.set(key, stored);
          persistedImages.set(key, stored.map((image) => ({ ...image })));
        }
      }
      for (const [key, value] of values) {
        const draft: ChatDraft = { value, images: images.get(key) ?? [] };
        if (!isEmptyDraft(draft)) drafts.set(key, draft);
      }
    } catch {
      // A store that cannot be read leaves the drafts this page already holds alone.
    }
  }

  function getDraft(key: string): ChatDraft | null {
    hydrate();
    const draft = drafts.get(key);
    return draft ? cloneDraft(draft) : null;
  }

  function clearDraft(key: string): void {
    hydrate();
    drafts.delete(key);
    removeStoredDraft(key);
    refusedImages.delete(key);
    if (storageIssues.delete(key)) notifyDraftStorageIssue();
  }

  function setDraft(key: string, draft: ChatDraft): void {
    hydrate();
    if (isEmptyDraft(draft)) {
      clearDraft(key);
      return;
    }
    const stored = cloneDraft(draft);
    drafts.set(key, stored);
    persistDraft(key, stored);
  }

  function rekeyDraft(
    previousKey: string,
    nextKey: string,
    currentDraft?: ChatDraft,
  ): ChatDraft | null {
    if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

    const storedPrevious = getDraft(previousKey);
    const previous = currentDraft && !isEmptyDraft(currentDraft)
      ? cloneDraft(currentDraft)
      : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
    const next = getDraft(nextKey);
    clearDraft(previousKey);
    if (!previous) return next;

    const merged = next
      ? mergeRestoredSubmissionDraft(next.value, next.images, previous.value, previous.images)
      : previous;
    setDraft(nextKey, merged);
    return cloneDraft(merged);
  }

  function restoreSubmission(key: string, text: string, images?: ChatDraftImage[]): ChatDraft {
    const current = getDraft(key) ?? { value: "", images: [] };
    const restored = mergeRestoredSubmissionDraft(
      text,
      images,
      current.value,
      current.images,
    );
    setDraft(key, restored);
    return restored;
  }

  return {
    scope,
    hydrate,
    getDraft,
    setDraft,
    clearDraft,
    rekeyDraft,
    restoreSubmission,
    getDraftStorageIssue: (key: string) => storageIssues.get(key) ?? null,
    subscribeDraftStorageIssue(listener: () => void): () => void {
      issueListeners.add(listener);
      return () => {
        issueListeners.delete(listener);
      };
    },
  };
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
): ChatDraft {
  const images = withinLimits([...(submittedImages ?? []), ...currentImages]);

  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
  };
}
