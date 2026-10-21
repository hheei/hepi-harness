import type { SessionInfo } from "./types";

export interface SessionFamily {
  root: SessionInfo;
  subagents: SessionInfo[];
  latestModified: string;
}

/**
 * The family root of every listed session, or `null` for a conversation whose ancestry leaves the listing.
 *
 * A **subagent relation is followed through the listing, not through the store**: the catalogue reports a
 * conversation's creator edge whether or not the conversation that owns it is still listed, so a session whose parent
 * was tombstoned still arrives with its relation. Following the relation to a parent that is not in the listing would
 * end the walk with nothing and drop the session from the sidebar entirely — the cascade a parent's removal must not
 * cause. The walk therefore climbs while the parent is **present**, and a missing parent ends it at the last
 * conversation that was present, so a hidden middle conversation neither hides its descendants nor splits the family:
 * the descendant is grouped under the nearest listed ancestor (spec D14, A22).
 */
function resolveFamilyRoots(sessions: readonly SessionInfo[]): Map<string, string> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = new Map<string, string>();

  for (const session of sessions) {
    if (roots.has(session.id)) continue;

    const path: string[] = [];
    const visited = new Set<string>();
    let current = session;

    while (true) {
      if (roots.has(current.id)) {
        for (const id of path) roots.set(id, roots.get(current.id)!);
        break;
      }
      if (visited.has(current.id)) break;
      visited.add(current.id);
      path.push(current.id);

      const parentId = current.relation?.kind === "subagent" ? current.relation.parentSessionId : undefined;
      const parent = parentId === undefined ? undefined : byId.get(parentId);
      // No parent, or a parent this listing does not hold: this session's ancestry stops at the last conversation that
      // is present, which is itself.
      if (parent === undefined) {
        for (const id of path) roots.set(id, current.id);
        break;
      }
      current = parent;
    }
  }

  return roots;
}

/** Groups visible main/fork sessions with every persisted subagent descendant. */
export function listSessionFamilies(sessions: readonly SessionInfo[]): SessionFamily[] {
  const rootsBySessionId = resolveFamilyRoots(sessions);
  const families = new Map<string, SessionFamily>();

  for (const session of sessions) {
    if (session.relation?.kind === "subagent") continue;
    families.set(session.id, {
      root: session,
      subagents: [],
      latestModified: session.modified,
    });
  }

  for (const session of sessions) {
    if (session.relation?.kind !== "subagent") continue;
    // A subagent's family is the root the walk resolved. When that root is the session itself, its ancestry left the
    // listing — a parent that was tombstoned — and it is kept as a family of its own rather than dropped: a removal
    // above it must not erase a conversation nobody removed (spec D14, A22).
    const family = families.get(rootsBySessionId.get(session.id) ?? session.id)
      ?? (families.set(session.id, { root: session, subagents: [], latestModified: session.modified }), families.get(session.id)!);
    if (family.root.id === session.id) continue;
    family.subagents.push(session);
    if (session.modified > family.latestModified) family.latestModified = session.modified;
  }

  return [...families.values()].sort((a, b) => b.latestModified.localeCompare(a.latestModified));
}

export function getSessionFamily(
  sessions: readonly SessionInfo[],
  sessionId: string | null | undefined,
): SessionFamily | null {
  if (!sessionId) return null;
  return listSessionFamilies(sessions).find((family) => (
    family.root.id === sessionId
    || family.subagents.some((session) => session.id === sessionId)
  )) ?? null;
}
