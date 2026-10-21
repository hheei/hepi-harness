// Bounded in-memory snapshot of one session's rendered view, so switching back
// to a recently visited session shows history immediately while a background
// freshness check runs.
//
// Constraints (deliberate):
// - Page-memory only. Never localStorage/IndexedDB/Service Worker, never sent
//   anywhere. Cleared by a full page reload by design.
// - Keyed by connection scope first: the durable conversation ids are unique within one Backend, so a view cached for
//   one connection must not answer a lookup made on another that happens to have the same session id.
// - LRU: at most MAX_SESSIONS sessions and MAX_TOTAL_UNITS UTF-16 code units of
//   their serialization; oversize or unmeasurable snapshots are simply not cached.
//   The unit is the serialized length, not heap size and not UTF-8 bytes.
// - Only *settled history* is cached: the confirmed message window, entry ids,
//   active leaf, pagination cursor, the head it was stated under, and display
//   stats. Never streaming state, queued messages, run state, or SSE objects.

import type { AgentMessage } from "./types";
import { scopedKey } from "./connection-scope";

export interface SessionViewSnapshot {
	sessionId: string;
	/** Opaque server revision the snapshot was validated against. */
	revision: string;
	messages: AgentMessage[];
	entryIds: string[];
	leafId: string | null;
	/** Oldest entry id currently loaded — the pagination cursor. */
	oldestEntryId: string | null;
	hasMore: boolean;
	/**
	 * The head marker this window was stated under. A mount adopts it as the head it is, which is what keeps a
	 * restored view from being stamped with an older head than the conversation is on.
	 */
	historyHead: string | null;
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
	stats?: unknown;
	/** Ids of history pages the user already paged in beyond the first window. */
	loadedEntryIds: string[];
	/**
	 * The paged prefix the view had in front of the window — the older pages the reader asked for, in transcript order —
	 * and the head marker they were loaded under. `messages`/`entryIds` are the projection's bounded window; without
	 * this the pages behind it are lost on the way back, which is the one thing the cache exists to prevent.
	 */
	prefixEntryIds: string[];
	prefixMessages: AgentMessage[];
	prefixHistoryHead: string | null;
}

const MAX_SESSIONS = 8;
const MAX_TOTAL_UNITS = 32 * 1024 * 1024;
const TTL_MS = 10 * 60_000;

/**
 * One stored window: the settled snapshot itself — held by reference, never copied and never mutated, because the
 * caller's payload is immutable once it is a settled view — the one measure its write took, and when it was written.
 */
interface CacheEntry {
	snapshot: SessionViewSnapshot;
	/** UTF-16 code units of this snapshot's serialization, measured once at write. */
	units: number;
	savedAt: number;
}

/** The whole cache: its entries in LRU order and the running total of the measures they hold. */
interface CacheStore {
	entries: Map<string, CacheEntry>;
	totalUnits: number;
}

declare global {
	var __piSessionViewCache: CacheStore | undefined;
}

function cache(): CacheStore {
	if (!globalThis.__piSessionViewCache) globalThis.__piSessionViewCache = { entries: new Map(), totalUnits: 0 };
	return globalThis.__piSessionViewCache;
}

/** Serialized length in UTF-16 code units. Circular payloads are treated as oversize. */
function measureSnapshotUnits(snapshot: SessionViewSnapshot): number {
	try {
		return JSON.stringify(snapshot).length;
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

/** Drop one entry and release the measure it was accounted with. The key is the scoped one, never a bare session id. */
function remove(store: CacheStore, key: string): boolean {
	const entry = store.entries.get(key);
	if (entry === undefined) return false;
	store.entries.delete(key);
	store.totalUnits -= entry.units;
	return true;
}

function removeOldest(store: CacheStore): void {
	const oldestKey = store.entries.keys().next().value;
	if (oldestKey === undefined) return;
	remove(store, oldestKey);
}

/** Enforce both bounds against the running total — never by rescanning the payloads already stored. */
function evictToFit(store: CacheStore): void {
	while (store.entries.size > MAX_SESSIONS) removeOldest(store);
	while (store.totalUnits > MAX_TOTAL_UNITS && store.entries.size > 0) removeOldest(store);
}

export function getSessionViewSnapshot(scope: string, sessionId: string): SessionViewSnapshot | null {
	const store = cache();
	const key = scopedKey(scope, sessionId);
	const entry = store.entries.get(key);
	if (!entry) return null;
	if (Date.now() - entry.savedAt > TTL_MS) {
		// An expired window is gone, so the measure it held is released with it.
		remove(store, key);
		return null;
	}
	// LRU touch: reinsert the same entry under the same measure.
	store.entries.delete(key);
	store.entries.set(key, entry);
	return entry.snapshot;
}

/** Store a snapshot; returns false when it was refused (oversize/unmeasurable/invalid). */
export function setSessionViewSnapshot(scope: string, snapshot: SessionViewSnapshot): boolean {
	if (!snapshot.sessionId || !snapshot.revision) return false;
	const units = measureSnapshotUnits(snapshot);
	if (units > MAX_TOTAL_UNITS) return false;
	const store = cache();
	const key = scopedKey(scope, snapshot.sessionId);
	// A write replaces whatever the session held, so the replaced measure is released before the new one is added.
	remove(store, key);
	store.entries.set(key, { snapshot, units, savedAt: Date.now() });
	store.totalUnits += units;
	evictToFit(store);
	return store.entries.has(key);
}

export function deleteSessionViewSnapshot(scope: string, sessionId: string): void {
	remove(cache(), scopedKey(scope, sessionId));
}

export function clearSessionViewCache(): void {
	const store = cache();
	store.entries.clear();
	store.totalUnits = 0;
}

/** Test seam: drop all module state. */
export function resetSessionViewCacheForTests(): void {
	globalThis.__piSessionViewCache = undefined;
}
