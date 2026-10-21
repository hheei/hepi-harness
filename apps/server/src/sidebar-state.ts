import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type JsonObject, type Session, type Tx } from "@earendil-works/pi-durable";
import {
  applySessionUiStateRequest,
  emptySessionUiState,
  normalizeSessionUiState,
  SESSION_UI_STATE_VERSION,
  type SessionUiAnyRequest,
  type SessionUiState,
} from "@hepi/protocol";

// The sidebar's shared state — pins, archive, project order and the unread marker — as one session-scoped document,
// so every client of this backend reads and writes the same arrangement instead of a file on a Web host. The rules
// live in `@hepi/protocol` and are applied by both sides: the browser applies them optimistically and this backend
// applies the same function to commit, so an optimistic change and a confirmed change cannot diverge.
//
// The value carries its own `version`, and a value of another version is not read as this one (normalize returns
// null, and the caller starts from empty rather than reinterpreting fields it does not know). The storage-level
// version below is the framework's, and a document written by a newer backend is refused by typed access rather than
// silently misread.

/**
 * The document's own value shape: the shared state plus the revision this backend bumps on every changing write. Its
 * nested values are plain JSON objects rather than the shared interfaces, because a durable document's value must be
 * strict JSON; `normalizeSessionUiState` is what turns a stored value back into those interfaces, and it is the only
 * reader. `projectOrder` is always present here and reads back as absent while empty, which is the shared shape.
 */
export type SidebarDocumentState = JsonObject & {
  version: number;
  revision: number;
  sessions: Record<string, JsonObject>;
  projects: Record<string, JsonObject>;
  projectOrder: string[];
};

export const SidebarStateDoc = defineDoc<SidebarDocumentState>({
  kind: "hepi.sidebar-state",
  version: 1,
  scope: "session",
  initial: () => ({ version: SESSION_UI_STATE_VERSION, revision: 0, sessions: {}, projects: {}, projectOrder: [] }),
});

/** One value as the document stores it: rebuilt field by field, so only the shape this document declares is written. */
function stored(state: SessionUiState, revision: number): SidebarDocumentState {
  const sessions: SidebarDocumentState["sessions"] = {};
  for (const [id, family] of Object.entries(state.sessions)) {
    const entry: JsonObject = {};
    if (family.pinnedAt !== undefined) entry.pinnedAt = family.pinnedAt;
    if (family.archivedAt !== undefined) entry.archivedAt = family.archivedAt;
    if (family.unreadAt !== undefined) entry.unreadAt = family.unreadAt;
    sessions[id] = entry;
  }
  const projects: SidebarDocumentState["projects"] = {};
  for (const [key, project] of Object.entries(state.projects)) projects[key] = { pinnedAt: project.pinnedAt, root: project.root };
  return { version: SESSION_UI_STATE_VERSION, revision, sessions, projects, projectOrder: state.projectOrder ?? [] };
}

/**
 * The committed state, or an empty one when the document was never written or holds a value this version cannot use.
 * An entry for a session or project that is no longer shown is kept, so a returning project takes its old place.
 */
export async function readSidebarState(session: Session): Promise<SessionUiState> {
  const document = await session.snapshot(SidebarStateDoc, BACKGROUND_CONTEXT);
  return (document === undefined ? null : normalizeSessionUiState(document)) ?? emptySessionUiState();
}

/**
 * One change per request, applied with the shared rules; the answer is the state after the change. A request that
 * changes nothing (the same flag set twice, an unknown session id) is accepted, writes nothing and answers the state
 * as it already was, so a repeated or concurrent write cannot drift the arrangement. Last write wins, and this
 * backend is the only writer.
 *
 * The transaction form is what lets another hepi operation clear a session's entries inside its own commit: a session
 * the user removed must leave no orphan pin or archive entry behind, and a second request could fail on its own after
 * the removal had already happened.
 */
export async function applySidebarStateTx(tx: Tx, request: SessionUiAnyRequest, now: number): Promise<SessionUiState> {
  const draft = await tx.doc(SidebarStateDoc);
  const current = normalizeSessionUiState(draft) ?? emptySessionUiState();
  const applied = applySessionUiStateRequest(current, request, now);
  if (!applied.changed) return current;
  const revision = current.revision + 1;
  const next = stored(applied.state, revision);
  draft.version = next.version;
  draft.revision = next.revision;
  draft.sessions = next.sessions;
  draft.projects = next.projects;
  draft.projectOrder = next.projectOrder;
  return { ...applied.state, revision };
}

export async function writeSidebarState(session: Session, request: SessionUiAnyRequest): Promise<SessionUiState> {
  return session.commit(tx => applySidebarStateTx(tx, request, Date.now()), BACKGROUND_CONTEXT);
}
