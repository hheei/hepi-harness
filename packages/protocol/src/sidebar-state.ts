/**
 * The sidebar's shared UI state: pins, archive, project order, and the unread marker.
 *
 * One document per backend holds this, so two windows of one backend agree, and it is read and written through the
 * backend rather than through browser storage. The rules live here rather than in the Web adapter because both sides
 * apply them: the browser applies a change optimistically with the same function the backend uses to commit it, so an
 * optimistic change and a confirmed change cannot diverge. Pure and dependency-free, so it is safe on both sides.
 */

export const SESSION_UI_STATE_VERSION = 1;
/**
 * The session ids a request and the document may name. It is the session reader's own rule, so an id the sidebar
 * shows is an id this accepts: a durable conversation id is a non-negative safe integer and arrives as its decimal
 * form, and the upstream reader's ids are UUIDs. An entry for an id that no longer exists is harmless and is kept.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export const MAX_SESSION_UI_IDS_PER_REQUEST = 500;
/** Longest projectKey or project root a request or the document may carry. */
const MAX_PROJECT_STRING_LENGTH = 4096;
/** Most projectKeys `projectOrder` holds. */
export const MAX_PROJECT_ORDER_KEYS = 1000;
/**
 * Most UTF-8 bytes `projectOrder` takes as JSON. Keys may be 4096 characters, a CJK character is 3 bytes and a
 * Windows backslash doubles in JSON: the count alone would let the list outgrow the document's own size limit.
 */
export const PROJECT_ORDER_MAX_BYTES = 256 * 1024;
/** Most UTF-8 bytes one accepted request body may carry; over it the request is refused unread. */
export const MAX_SESSION_UI_REQUEST_BYTES = 512 * 1024;

/** Epoch ms, keyed by the conversation id. `unreadAt` marks a finished run the user has not looked at. */
export interface SessionUiFamilyState { pinnedAt?: number; archivedAt?: number; unreadAt?: number }
/** Keyed by projectKey. */
export interface SessionUiProjectState { pinnedAt: number; root: string }
export interface SessionUiState {
  version: 1;
  /** Monotonic, bumped by the backend on every changing write. */
  revision: number;
  sessions: Record<string, SessionUiFamilyState>;
  projects: Record<string, SessionUiProjectState>;
  /**
   * projectKeys of the sidebar's groups, top first, pinned and other projects in one list (each band keeps the
   * relative order of its own keys). Keys of projects no longer shown stay, so a project that comes back takes its
   * old place. Absent while empty.
   */
  projectOrder?: string[];
}

/** Where a moved project goes, next to its anchor. */
export type ProjectMovePosition = "before" | "after";
/** One family's flags before a change, for undo; null = absent. */
export interface SessionUiFlagsSnapshot { id: string; pinnedAt: number | null; archivedAt: number | null; unreadAt: number | null }

export type SessionUiStateRequest =
  | { action: "set"; ids: string[]; pinned: boolean }
  | { action: "set"; ids: string[]; archived: boolean }
  /** Undo: writes back exact prior values (null = absent), so one bulk archive undoes as one action. */
  | { action: "restore"; entries: SessionUiFlagsSnapshot[] }
  | { action: "pin-project"; projectKey: string; root: string; pinned: boolean }
  /** New projects, top first: the ones `projectOrder` lacks go in front of it. Never pushes a key out. */
  | { action: "add-projects"; keys: string[] }
  /**
   * A drag or Move up/down: `projectKey` goes right before or after `anchorKey`. `add` (the moved project's band's
   * unsaved keys, top first) is added first, so the move lands where the user saw it.
   */
  | { action: "move-project"; projectKey: string; anchorKey: string; position: ProjectMovePosition; add: string[] };

/** Unread markers are written in the same document and by the same rules, as their own action. */
export type SessionUiUnreadRequest = { action: "set-unread"; ids: string[]; unread: boolean };
export type SessionUiAnyRequest = SessionUiStateRequest | SessionUiUnreadRequest;

export interface SessionUiStateResponse { state: SessionUiState }

/** Why a write was refused; `error` is diagnostic text and `reason` is the stable machine-readable cause. */
export type SessionUiStateRefusalReason = "content-type" | "invalid-request" | "too-large" | "internal";
export interface SessionUiStateErrorResponse { error: string; reason: SessionUiStateRefusalReason }

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Epoch ms as requests and the document carry them. */
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** `__proto__` would set the record's prototype instead of adding a key. */
function isProjectString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PROJECT_STRING_LENGTH
    && value !== "__proto__";
}

const utf8 = new TextEncoder();

/** What one key adds to `projectOrder` as JSON: the quoted, escaped key and its comma. */
function orderEntryBytes(key: string): number {
  return utf8.encode(JSON.stringify(key)).length + 1;
}

/** `projectOrder` as JSON: its brackets and entries, one comma fewer than entries. */
function orderBytes(order: readonly string[]): number {
  let bytes = 1;
  for (const key of order) bytes += orderEntryBytes(key);
  return bytes;
}

function orderFits(count: number, bytes: number): boolean {
  return count <= MAX_PROJECT_ORDER_KEYS && bytes <= PROJECT_ORDER_MAX_BYTES;
}

/** The first of `keys` that fit both limits; a key too long for the bytes left is skipped. */
function fitProjectOrder(keys: readonly string[]): string[] {
  const kept: string[] = [];
  let bytes = 1;
  for (const key of keys) {
    if (kept.length >= MAX_PROJECT_ORDER_KEYS) break;
    const size = orderEntryBytes(key);
    if (bytes + size > PROJECT_ORDER_MAX_BYTES) continue;
    kept.push(key);
    bytes += size;
  }
  return kept;
}

export function emptySessionUiState(): SessionUiState {
  return { version: SESSION_UI_STATE_VERSION, revision: 0, sessions: {}, projects: {} };
}

function normalizeFamily(value: unknown): SessionUiFamilyState | null {
  if (!isPlainObject(value)) return null;
  const family: SessionUiFamilyState = {};
  if (isTimestamp(value.pinnedAt)) family.pinnedAt = value.pinnedAt;
  if (isTimestamp(value.archivedAt)) family.archivedAt = value.archivedAt;
  if (isTimestamp(value.unreadAt)) family.unreadAt = value.unreadAt;
  return family.pinnedAt === undefined && family.archivedAt === undefined && family.unreadAt === undefined ? null : family;
}

function normalizeProject(value: unknown): SessionUiProjectState | null {
  if (!isPlainObject(value) || !isTimestamp(value.pinnedAt) || !isProjectString(value.root)) return null;
  return { pinnedAt: value.pinnedAt, root: value.root };
}

/** Tolerant: returns a clean state from unknown JSON, dropping malformed entries; null if the root shape is unusable. */
export function normalizeSessionUiState(value: unknown): SessionUiState | null {
  if (!isPlainObject(value)) return null;
  // Another version may mean other rules; it is not read as this one.
  if (value.version !== undefined && value.version !== SESSION_UI_STATE_VERSION) return null;
  if (value.sessions !== undefined && !isPlainObject(value.sessions)) return null;
  if (value.projects !== undefined && !isPlainObject(value.projects)) return null;
  const state = emptySessionUiState();
  const revision = value.revision;
  if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) state.revision = revision;
  for (const [id, entry] of Object.entries(value.sessions ?? {})) {
    if (!isSessionId(id)) continue;
    const family = normalizeFamily(entry);
    if (family) state.sessions[id] = family;
  }
  for (const [key, entry] of Object.entries(value.projects ?? {})) {
    if (!isProjectString(key)) continue;
    const project = normalizeProject(entry);
    if (project) state.projects[key] = project;
  }
  // Anything but an array reads as no order: it is cheap to rebuild, and no reason to set the rest aside.
  if (Array.isArray(value.projectOrder)) {
    const seen = new Set<string>();
    const keys = value.projectOrder.filter((key): key is string => {
      if (!isProjectString(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const order = fitProjectOrder(keys);
    if (order.length > 0) state.projectOrder = order;
  }
  return state;
}

type ParseResult = { ok: true; request: SessionUiAnyRequest } | { ok: false; error: string };

function parseIds(value: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: "ids must be a non-empty array" };
  if (value.length > MAX_SESSION_UI_IDS_PER_REQUEST) {
    return { ok: false, error: `ids may hold at most ${MAX_SESSION_UI_IDS_PER_REQUEST} session ids` };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (!isSessionId(id)) return { ok: false, error: "ids must be session ids" };
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ok: true, ids };
}

function parseSnapshotValue(value: unknown): number | null | undefined {
  if (value === null) return null;
  return isTimestamp(value) ? value : undefined;
}

/** A list of projectKeys: at most MAX_SESSION_UI_IDS_PER_REQUEST, each a project string, deduped keeping the first. */
function parseProjectKeys(value: unknown, name: string, allowEmpty: boolean): { ok: true; keys: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    return { ok: false, error: `${name} must be ${allowEmpty ? "an" : "a non-empty"} array` };
  }
  if (value.length > MAX_SESSION_UI_IDS_PER_REQUEST) {
    return { ok: false, error: `${name} may hold at most ${MAX_SESSION_UI_IDS_PER_REQUEST} projectKeys` };
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of value) {
    if (!isProjectString(key)) {
      return { ok: false, error: `${name} must hold non-empty strings of at most ${MAX_PROJECT_STRING_LENGTH} characters` };
    }
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return { ok: true, keys };
}

/**
 * Validates an untrusted body. ids: non-empty, unique after dedupe, each matching SESSION_ID_PATTERN, at most
 * MAX_SESSION_UI_IDS_PER_REQUEST. projectKey/root/anchorKey and every key of keys/add: non-empty strings of at most
 * 4096 characters, at most MAX_SESSION_UI_IDS_PER_REQUEST of them.
 */
export function parseSessionUiStateRequest(body: unknown): ParseResult {
  if (!isPlainObject(body)) return { ok: false, error: "Expected a JSON object" };
  switch (body.action) {
    case "set": {
      const hasPinned = hasOwn(body, "pinned");
      if (hasPinned === hasOwn(body, "archived")) return { ok: false, error: "Send exactly one of pinned or archived" };
      const value = hasPinned ? body.pinned : body.archived;
      if (typeof value !== "boolean") return { ok: false, error: `${hasPinned ? "pinned" : "archived"} must be a boolean` };
      const ids = parseIds(body.ids);
      if (!ids.ok) return ids;
      return {
        ok: true,
        request: hasPinned
          ? { action: "set", ids: ids.ids, pinned: value }
          : { action: "set", ids: ids.ids, archived: value },
      };
    }
    case "set-unread": {
      if (typeof body.unread !== "boolean") return { ok: false, error: "unread must be a boolean" };
      const ids = parseIds(body.ids);
      if (!ids.ok) return ids;
      return { ok: true, request: { action: "set-unread", ids: ids.ids, unread: body.unread } };
    }
    case "restore": {
      const raw = body.entries;
      if (!Array.isArray(raw)) return { ok: false, error: "entries must be an array" };
      if (raw.length > MAX_SESSION_UI_IDS_PER_REQUEST) {
        return { ok: false, error: `entries may hold at most ${MAX_SESSION_UI_IDS_PER_REQUEST} sessions` };
      }
      const entries: SessionUiFlagsSnapshot[] = [];
      const seen = new Set<string>();
      for (const entry of raw) {
        if (!isPlainObject(entry) || !isSessionId(entry.id)) return { ok: false, error: "Each entry needs a session id" };
        // Two prior values for one family would leave which one wins to chance.
        if (seen.has(entry.id)) return { ok: false, error: "entries must name each session once" };
        seen.add(entry.id);
        const pinnedAt = parseSnapshotValue(entry.pinnedAt);
        const archivedAt = parseSnapshotValue(entry.archivedAt);
        const unreadAt = parseSnapshotValue(entry.unreadAt);
        if (pinnedAt === undefined || archivedAt === undefined || unreadAt === undefined) {
          return { ok: false, error: "pinnedAt, archivedAt and unreadAt must be timestamps or null" };
        }
        entries.push({ id: entry.id, pinnedAt, archivedAt, unreadAt });
      }
      return { ok: true, request: { action: "restore", entries } };
    }
    case "pin-project": {
      if (!isProjectString(body.projectKey)) {
        return { ok: false, error: `projectKey must be a non-empty string of at most ${MAX_PROJECT_STRING_LENGTH} characters` };
      }
      if (!isProjectString(body.root)) {
        return { ok: false, error: `root must be a non-empty string of at most ${MAX_PROJECT_STRING_LENGTH} characters` };
      }
      if (typeof body.pinned !== "boolean") return { ok: false, error: "pinned must be a boolean" };
      return { ok: true, request: { action: "pin-project", projectKey: body.projectKey, root: body.root, pinned: body.pinned } };
    }
    case "add-projects": {
      const keys = parseProjectKeys(body.keys, "keys", false);
      if (!keys.ok) return keys;
      return { ok: true, request: { action: "add-projects", keys: keys.keys } };
    }
    case "move-project": {
      const { projectKey, anchorKey, position } = body;
      if (!isProjectString(projectKey) || !isProjectString(anchorKey)) {
        return { ok: false, error: `projectKey and anchorKey must be non-empty strings of at most ${MAX_PROJECT_STRING_LENGTH} characters` };
      }
      if (projectKey === anchorKey) return { ok: false, error: "projectKey and anchorKey must differ" };
      if (position !== "before" && position !== "after") return { ok: false, error: "position must be \"before\" or \"after\"" };
      const add = body.add === undefined ? { ok: true as const, keys: [] } : parseProjectKeys(body.add, "add", true);
      if (!add.ok) return add;
      return { ok: true, request: { action: "move-project", projectKey, anchorKey, position, add: add.keys } };
    }
    default:
      return { ok: false, error: "action must be \"set\", \"set-unread\", \"restore\", \"pin-project\", \"add-projects\" or \"move-project\"" };
  }
}

function sameFamily(a: SessionUiFamilyState | undefined, b: SessionUiFamilyState): boolean {
  return a?.pinnedAt === b.pinnedAt && a?.archivedAt === b.archivedAt && a?.unreadAt === b.unreadAt;
}

/** Stores `next` for `id` (an empty entry is removed) and says whether that changed anything. */
function writeFamily(sessions: Record<string, SessionUiFamilyState>, id: string, next: SessionUiFamilyState): boolean {
  const previous = hasOwn(sessions, id) ? sessions[id] : undefined;
  const empty = next.pinnedAt === undefined && next.archivedAt === undefined && next.unreadAt === undefined;
  if (empty) {
    if (!previous) return false;
    delete sessions[id];
    return true;
  }
  if (sameFamily(previous, next)) return false;
  sessions[id] = next;
  return true;
}

function nextFamily(
  previous: SessionUiFamilyState | undefined,
  request: Extract<SessionUiStateRequest, { action: "set" }>,
  now: number,
): SessionUiFamilyState {
  const next: SessionUiFamilyState = { ...previous };
  if ("pinned" in request) {
    if (!request.pinned) {
      delete next.pinnedAt;
    } else if (next.pinnedAt === undefined || next.archivedAt !== undefined) {
      // Pin and archive exclude each other: pinning an archived family restores it.
      next.pinnedAt = now;
      delete next.archivedAt;
    }
    return next;
  }
  if (request.archived) {
    // Archiving again refreshes the time, so a family that came back with new activity can be archived again.
    next.archivedAt = now;
    // Archiving means dealt with, so the unread marker goes in the same write and Undo brings it back.
    delete next.pinnedAt;
    delete next.unreadAt;
  } else {
    delete next.archivedAt;
  }
  return next;
}

function copyState(state: SessionUiState): SessionUiState {
  const sessions: Record<string, SessionUiFamilyState> = {};
  for (const [id, entry] of Object.entries(state.sessions)) sessions[id] = { ...entry };
  const projects: Record<string, SessionUiProjectState> = {};
  for (const [key, entry] of Object.entries(state.projects)) projects[key] = { ...entry };
  const copy: SessionUiState = { ...state, sessions, projects };
  // Only when present: an explicit undefined would not equal an absent field.
  if (state.projectOrder) copy.projectOrder = [...state.projectOrder];
  return copy;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/** Stores `order` (an empty one removes the field) and says whether that changed anything. */
function writeProjectOrder(state: SessionUiState, order: string[]): boolean {
  if (sameOrder(state.projectOrder ?? [], order)) return false;
  if (order.length === 0) delete state.projectOrder;
  else state.projectOrder = order;
  return true;
}

/** `keys` that `order` lacks, each once, in their order. */
function missingProjectKeys(order: readonly string[], keys: readonly string[]): string[] {
  const present = new Set(order);
  const missing: string[] = [];
  for (const key of keys) {
    if (present.has(key)) continue;
    present.add(key);
    missing.push(key);
  }
  return missing;
}

/**
 * "add-projects": the keys `order` lacks go in front, in their order. Nothing is pushed out, so adding stays
 * idempotent. When not all of them fit, the last ones that do are added: those render right above the saved keys, so
 * the ones left out (unsaved, and unsaved keys render first in their band) keep their place on screen.
 */
function withProjectsAdded(order: readonly string[], keys: readonly string[]): string[] {
  const missing = missingProjectKeys(order, keys);
  let count = order.length;
  let bytes = orderBytes(order);
  let first = missing.length;
  while (first > 0) {
    const size = orderEntryBytes(missing[first - 1]);
    if (!orderFits(count + 1, bytes + size)) break;
    count++;
    bytes += size;
    first--;
  }
  return [...missing.slice(first), ...order];
}

/** `key` right before or after `anchor`. A missing anchor goes to the top first, where an unsaved project renders. */
function withProjectMoved(order: readonly string[], key: string, anchor: string, position: ProjectMovePosition): string[] {
  const list = order.filter((item) => item !== key);
  if (!list.includes(anchor)) list.unshift(anchor);
  const index = list.indexOf(anchor);
  list.splice(position === "before" ? index : index + 1, 0, key);
  return list;
}

/**
 * Where a project goes when it changes band, next to the boundary: a pin at the bottom of the pinned band (after the
 * last pinned key), an unpin at the top of the others (before the first key not pinned). `pinned` holds the pinned
 * projects after the change.
 */
function withProjectRebanded(order: readonly string[], key: string, pinned: Record<string, SessionUiProjectState>, nowPinned: boolean): string[] {
  const list = order.filter((item) => item !== key);
  let index: number;
  if (nowPinned) {
    index = 0;
    list.forEach((item, position) => {
      if (hasOwn(pinned, item)) index = position + 1;
    });
  } else {
    index = list.findIndex((item) => !hasOwn(pinned, item));
    if (index < 0) index = list.length;
  }
  list.splice(index, 0, key);
  return list;
}

/**
 * `order` within both limits: keys the request does not name go from the end first; if the named ones alone are too
 * many, the first of them that fit stay.
 */
function capProjectOrder(order: string[], keep: ReadonlySet<string>): string[] {
  let count = order.length;
  let bytes = orderBytes(order);
  if (orderFits(count, bytes)) return order;
  const dropped = new Set<number>();
  for (let index = order.length - 1; index >= 0 && !orderFits(count, bytes); index--) {
    if (keep.has(order[index])) continue;
    dropped.add(index);
    count--;
    bytes -= orderEntryBytes(order[index]);
  }
  const kept = order.filter((_, index) => !dropped.has(index));
  return orderFits(count, bytes) ? kept : fitProjectOrder(kept);
}

/**
 * Pure. Returns a NEW state (never mutates input) and whether anything changed. Does NOT touch revision.
 * The project order never depends on `now`, and its requests are relative (keys added if missing, one key placed next
 * to one anchor), so a replay or another window's write in between gives the same placements.
 */
export function applySessionUiStateRequest(
  state: SessionUiState,
  request: SessionUiAnyRequest,
  now: number,
): { state: SessionUiState; changed: boolean } {
  const next = copyState(state);
  let changed = false;
  switch (request.action) {
    case "set":
      for (const id of request.ids) {
        const previous = hasOwn(next.sessions, id) ? next.sessions[id] : undefined;
        if (writeFamily(next.sessions, id, nextFamily(previous, request, now))) changed = true;
      }
      break;
    case "set-unread":
      for (const id of request.ids) {
        const previous = hasOwn(next.sessions, id) ? next.sessions[id] : undefined;
        const family: SessionUiFamilyState = { ...previous };
        if (request.unread) family.unreadAt = now;
        else delete family.unreadAt;
        if (writeFamily(next.sessions, id, family)) changed = true;
      }
      break;
    case "restore":
      for (const entry of request.entries) {
        const family: SessionUiFamilyState = {};
        if (entry.pinnedAt !== null) family.pinnedAt = entry.pinnedAt;
        if (entry.archivedAt !== null) family.archivedAt = entry.archivedAt;
        if (entry.unreadAt !== null) family.unreadAt = entry.unreadAt;
        if (writeFamily(next.sessions, entry.id, family)) changed = true;
      }
      break;
    case "pin-project": {
      const { projectKey, root } = request;
      const previous = hasOwn(next.projects, projectKey) ? next.projects[projectKey] : undefined;
      if (request.pinned) {
        if (previous?.root !== root) {
          next.projects[projectKey] = { pinnedAt: now, root };
          changed = true;
        }
      } else if (previous) {
        delete next.projects[projectKey];
        changed = true;
      }
      // A project that changes band gets a saved place next to the boundary (a new root for a pinned project is no
      // change of band), never at the cost of another key: a full list leaves a project it lacks unsaved.
      const rebanded = request.pinned ? previous === undefined : previous !== undefined;
      if (rebanded && next.projectOrder) {
        const order = withProjectRebanded(next.projectOrder, projectKey, next.projects, request.pinned);
        if (orderFits(order.length, orderBytes(order)) && writeProjectOrder(next, order)) changed = true;
      }
      break;
    }
    case "add-projects":
      if (writeProjectOrder(next, withProjectsAdded(next.projectOrder ?? [], request.keys))) changed = true;
      break;
    case "move-project": {
      const { projectKey, anchorKey, position, add } = request;
      const order = next.projectOrder ?? [];
      const moved = withProjectMoved([...missingProjectKeys(order, add), ...order], projectKey, anchorKey, position);
      const named = new Set([projectKey, anchorKey, ...add]);
      if (writeProjectOrder(next, capProjectOrder(moved, named))) changed = true;
      break;
    }
  }
  return { state: next, changed };
}

/**
 * `items` in slices of at most `size` (a request's limit), in order. A change to more families than one request may
 * carry ("Archive sessions older than 7 days" in a busy project, and its Undo) is sent as several requests.
 */
export function chunkForSessionUiRequests<T>(items: readonly T[], size = MAX_SESSION_UI_IDS_PER_REQUEST): T[][] {
  const step = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += step) chunks.push(items.slice(start, start + step));
  return chunks;
}

/** Snapshot of the current flags for undo; each id once, in the order given. */
export function snapshotSessionUiFlags(state: SessionUiState, ids: readonly string[]): SessionUiFlagsSnapshot[] {
  const seen = new Set<string>();
  const snapshot: SessionUiFlagsSnapshot[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = hasOwn(state.sessions, id) ? state.sessions[id] : undefined;
    snapshot.push({ id, pinnedAt: entry?.pinnedAt ?? null, archivedAt: entry?.archivedAt ?? null, unreadAt: entry?.unreadAt ?? null });
  }
  return snapshot;
}
