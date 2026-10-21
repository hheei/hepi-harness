/**
 * Browser fixture for the rail's history scope: a compaction while the outline is open.
 *
 * It mounts the production `useHistoryNavigation` — the owner `ChatWindow` mounts — over a `ConversationApi` whose two
 * navigation reads are this file's own, and drives the one fact that changes: the conversation's `snapshotRevision`.
 * A compaction moves that token's head marker, so the anchors the rail already lists were issued over a scope the
 * conversation no longer states.
 *
 * Three behaviours are staged here, and the driver reads each from the hook's own state:
 *
 * - the first page of each history is answered with that history's own scope;
 * - the **first** read after the compaction is answered late, with a page of the history the conversation has left —
 *   the shape of a page that was already on the wire when the head marker moved;
 * - an append moves the snapshot token's entry fact and leaves the scope alone.
 *
 * Nothing here reimplements the coordinator or the reducer: the fixture only states what a Backend would answer, and
 * counts what it was asked.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useHistoryNavigation } from "@hepi/ui/hooks/useHistoryNavigation";
import type { ConversationApi } from "@hepi/ui/lib/conversation-api";
import { decodeNavigationAnchor, encodeNavigationAnchor, type NavigationOutlinePage, type NavigationTargetWindow } from "@hepi/protocol/navigation";

const CONVERSATION = "77";
const HEAD_ONE = CONVERSATION + "|head1";
const HEAD_TWO = CONVERSATION + "|head2";

export interface ScopeGate {
  /** The scopes the hook asked the outline for, in order. */
  outlineScopes(): (string | null)[];
  /** The target reads issued, in order. */
  targetReads(): string[];
  /** What the rail would render right now. */
  state(): { revision: string; scope: string | null; anchors: string[]; failure: string | null; loading: boolean; landed: number };
  /** Accept a compaction: the conversation states a new head marker, and the old scope is gone. */
  compact(): void;
  /** Append a turn: the snapshot token moves, the scope does not. */
  append(): void;
  /** Settle the read that was already on the wire when the compaction landed. */
  answerLate(): void;
  /** Jump to the first listed anchor, through the coordinator a rail click uses. */
  jump(): void;
}

declare global {
  interface Window { __scope?: ScopeGate }
}

function pageOf(scope: string, revision: string): NavigationOutlinePage {
  const entryId = scope === HEAD_ONE ? "10" : "20";
  return {
    protocol: "hepi.v1",
    conversationId: CONVERSATION,
    snapshot: revision,
    scope,
    order: "oldest-first",
    anchors: [{ entryId, cursor: Number(entryId), preview: "Question of " + scope, anchor: anchorOf(scope, entryId) }],
    hasMore: false,
    capped: true,
    bytes: 128,
  };
}

/** The contract's own coordinate, minted the way the Backend mints one for a page it answers. */
function anchorOf(scope: string, entryId: string): string {
  return encodeNavigationAnchor({ version: 1, conversationId: CONVERSATION, scope, entryId });
}

function windowOf(scope: string, revision: string, entryId: string): NavigationTargetWindow {
  return {
    protocol: "hepi.v1",
    conversationId: CONVERSATION,
    snapshot: revision,
    scope,
    order: "oldest-first",
    target: { entryId, anchor: anchorOf(scope, entryId), present: true, blocks: [0] },
    capped: true,
    trimmed: false,
    entries: [{ id: entryId, role: "user", text: "Question of " + scope, message: { role: "user", content: [{ type: "text", text: "Question of " + scope }] } }],
    hasOlder: false,
    hasNewer: false,
    bytes: 256,
  };
}

function Fixture() {
  const [revision, setRevision] = useState(HEAD_ONE + "|10");
  const [settle, setSettle] = useState<(() => void) | null>(null);
  const outlineScopes = useRef<(string | null)[]>([]);
  const targetReads = useRef<string[]>([]);
  const landed = useRef(0);

  const api = useRef({
    navigationOutline: async (_conversationId: string, options?: { readonly scope?: string }) => {
      const scope = options?.scope ?? null;
      outlineScopes.current.push(scope);
      const asks = outlineScopes.current.filter((entry) => entry === scope).length;
      // The first read of the replaced history is answered only when the driver says so, and it answers with a page of
      // the history that has been replaced: that is what a read already on the wire looks like.
      if (scope === HEAD_TWO && asks === 1) {
        await new Promise<void>((resolve) => setSettle(() => resolve));
        return pageOf(HEAD_ONE, HEAD_ONE + "|10");
      }
      if (scope === HEAD_TWO) return pageOf(HEAD_TWO, HEAD_TWO + "|12");
      return pageOf(HEAD_ONE, HEAD_ONE + "|10");
    },
    navigationTarget: async (_conversationId: string, query: string) => {
      targetReads.current.push(query);
      // The coordinate the surface minted, read back through the contract's own decoder: the fixture answers what the
      // Backend would answer, so it reads the same address the same way.
      const coordinate = decodeNavigationAnchor(new URLSearchParams(query).get("anchor") ?? "");
      const scope = coordinate.ok ? coordinate.coordinate.scope : HEAD_ONE;
      const entryId = coordinate.ok ? coordinate.coordinate.entryId : "10";
      return windowOf(scope, scope + "|" + (scope === HEAD_ONE ? "10" : "12"), entryId);
    },
  } as unknown as ConversationApi).current;

  const nav = useHistoryNavigation({
    conversationId: CONVERSATION,
    snapshotRevision: revision,
    busy: false,
    activeEntryIds: [],
    api,
    landWindow: () => { landed.current += 1; },
  });

  const loadOutline = nav.loadOutline;
  useEffect(() => {
    void loadOutline();
  }, [loadOutline]);

  useEffect(() => {
    const gate: ScopeGate = {
      outlineScopes: () => outlineScopes.current,
      targetReads: () => targetReads.current,
      state: () => ({
        revision,
        scope: nav.outline?.scope ?? null,
        anchors: (nav.outline?.anchors ?? []).map((anchor) => anchor.entryId),
        failure: nav.outcome?.kind === "failed" ? nav.outcome.failure : null,
        loading: nav.outline?.loading ?? false,
        landed: landed.current,
      }),
      compact: () => setRevision(HEAD_TWO + "|12"),
      append: () => setRevision((current) => current.replace(/\|\d+$/, "|99")),
      answerLate: () => { settle?.(); setSettle(null); },
      jump: () => { const first = nav.outline?.anchors[0]; if (first !== undefined) nav.jump(first.anchor); },
    };
    window.__scope = gate;
    document.body.dataset.fixtureReady = "true";
    return () => { delete window.__scope; };
  }, [nav, revision, settle]);

  return <pre id="state">{JSON.stringify(nav.outline === null ? null : { scope: nav.outline.scope, anchors: nav.outline.anchors.length, loading: nav.outline.loading })}</pre>;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(<Fixture />);
