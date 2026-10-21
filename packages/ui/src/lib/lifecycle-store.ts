import type { Step } from "./lifecycle-projection";
import { scopedKey } from "./connection-scope";

/**
 * The projection of each composer and conversation this page has open, held in memory for the lifetime of the page.
 * The fold itself is pure and owns nothing; the page owns the value, and this is where it keeps it across the remount
 * that promotion causes — a fresh composer becomes a real session while the chat remounts, and the turns staged there
 * must stay on screen instead of being re-invented.
 *
 * It is deliberately not browser storage: a refresh re-reads the conversation, and a staged turn is presentation
 * state, not durable history. A key with nothing of its own gets nothing — never another conversation's turns.
 *
 * Every key is inside a connection scope, so the same conversation id on another connection is a different composer
 * and gets nothing of this one's staged turns.
 */
const byKey = new Map<string, Step>();
/** A composer's provisional key to the conversation it became, so a lookup reaches the value stored under either name. */
const aliases = new Map<string, string>();
/** Follow a composer key to the conversation it became, however many times it was rekeyed. */
function resolveKey(key: string): string {
  let current = key;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = aliases.get(current);
    if (next === undefined) break;
    current = next;
  }
  return current;
}

/** The projection of the composer or conversation a surface is showing, or null when this page has none for it. */
export function readProjection(scope: string, key: string): Step | null {
  return byKey.get(resolveKey(scopedKey(scope, key))) ?? null;
}

export function saveProjection(scope: string, key: string, step: Step): void {
  const scoped = scopedKey(scope, key);
  byKey.set(resolveKey(scoped), step);
}

/**
 * Move one composer's projection to the conversation it became, exactly as its draft is moved: the turns staged under
 * the provisional key belong to the conversation the composer turned into.
 */
export function rekeyProjection(scope: string, from: string, to: string): void {
  if (from === to) return;
  const scopedFrom = scopedKey(scope, from);
  const scopedTo = scopedKey(scope, to);
  const oldKey = resolveKey(scopedFrom);
  const newKey = resolveKey(scopedTo);
  aliases.set(scopedFrom, scopedTo);
  const step = byKey.get(oldKey);
  if (step === undefined || oldKey === newKey) return;
  byKey.delete(oldKey);
  byKey.set(newKey, step);
}
