/**
 * Ticket 03 browser seam: selective subtree control over the conversation API the page already holds.
 *
 * The surfaces are the production ones — `AgentSessionPanel` (the child tree) with `SubtreeControlPanel` mounted below
 * it, exactly as the shell arranges them — behind one real `createClient` whose transport is the fixture's and records
 * every URL, body and credential. A real Chromium does the clicking.
 *
 * Nothing about a subtree is decided here: the Backend owns the capture, the selection check and every child's control.
 * The answers below are the shapes `apps/server` really publishes — per-child durable outcome, committed control and
 * that child's own catalogue row, as tickets 01 and 02 deliver them — so the assertions are about what the surface
 * *shows* and what the wire *carried*, not about a stub's opinions.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { connectionIdentityOf } from "@hepi/ui/lib/connection-scope";
import { WorkbenchConnectionProvider, workbenchConnection } from "@hepi/ui/lib/workbench-scope";
import { AgentSessionPanel } from "@hepi/ui/components/AgentSessionPanel";
import { SubtreeControlPanel } from "@hepi/ui/components/SubtreeControlPanel";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { catalogueRow, type CatalogueRow } from "@hepi/ui/lib/conversation-catalogue";
import type { ConversationRunState, SessionInfo } from "@hepi/ui/lib/types";

export const INGRESS_ORIGIN = "https://ingress.example:9443";
export const BEARER = "subtree-device-bearer";

export type ConnectionRequest = { method: string; url: string; body: string | null; authorization: string | null };

/**
 * Which answer the fixture gives next: a clean result, a partial one, a lost answer, a refusal, or the **mixed** set a
 * system acceptance has to see at once — a request that controlled every child while each one's own current row states
 * something different (blocked, interrupted, waiting-report, running).
 */
export type Mode = "answered" | "partial" | "dropped" | "refused" | "refreshed" | "pending" | "no-record" | "mixed";

export interface Gate {
  connection: ConnectionRequest[];
  origin: string;
  bearer: string;
  mode: Mode;
  /** Every conversation the surface asked to open, in order: navigation is a separate thing from control. */
  opened: string[];
  /**
   * What each request id captured: its action and the subset it governs, or `null` for the whole subtree.
   *
   * A POST records its capture even when its answer is then dropped, because that is the state a lost answer leaves
   * behind — the Backend may already have the request. Reads answer from **this**, never from what the reader asks with:
   * a GET carries only an id, and the record decides which children it governs.
   */
  captured: Record<string, { action: string; selected: string[] | null }>;
  controlled(): void;
  setMode(mode: Mode): void;
  /**
   * Which descendants the catalogue lists right now.
   *
   * A subtree listing is not static: a child finishes and leaves the list, or a new one arrives, while a request's
   * answer is lost. That is the race the surface has to survive — resuming must repeat the selection the user
   * **confirmed**, not the one this moved listing happens to imply.
   */
  setListed(ids: string[]): void;
}

declare global {
  interface Window { __uxSubtree?: Gate }
}

const json = (body: unknown, status = 202): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** One conversation's catalogue row, as `GET /api/conversations` states it, projected by the list's own function. */
const entry = (id: string, title: string, runState: ConversationRunState, extra: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "local",
  gatewayId: "workstation",
  workspace: { gatewayId: "workstation", root: "/srv/local" },
  busy: runState === "running",
  revision: 4,
  messageCount: 2,
  firstMessage: title,
  title,
  runStatus: { state: runState },
  ...extra,
});

const ROOT = catalogueRow(entry("root", "The addressed conversation", "running"));
const DESCENDANTS = [
  catalogueRow(entry("child-a", "Research the flaky suite", "running", { createdBy: "root", displayParentId: "root" })),
  catalogueRow(entry("child-b", "Draft the migration note", "held", { createdBy: "root", displayParentId: "root", runStatus: { state: "held", reason: "user_stop" }, gatewayId: "kr-box", workspace: { gatewayId: "kr-box", root: "/srv/remote" } })),
  catalogueRow(entry("child-c", "Grandchild of the first", "running", { createdBy: "child-a", displayParentId: "child-a" })),
];
/** The poll's running set, for a row the catalogue stated no status of its own for. */
const RUNNING = new Set(["root", "child-a", "child-c"]);

const gate: Gate = {
  connection: [],
  origin: INGRESS_ORIGIN,
  bearer: BEARER,
  mode: "answered",
  opened: [],
  captured: {},
  controlled: () => undefined,
  setMode: () => undefined,
  setListed: () => undefined,
};
window.__uxSubtree = gate;

/** One child as the Backend answers it: the recorded outcome, the committed control, the current row. */
const child = (id: string, status: string, runState: ConversationRunState | null, controlState = "held", reason?: string) => ({
  conversationId: id,
  status,
  ...(reason === undefined ? {} : { reason }),
  control: { state: controlState, revision: 5 },
  ...(runState === null ? {} : { session: entry(id, DESCENDANTS.find((row) => row.id === id)?.name ?? id, runState) }),
});

const scoped = (requestId: string, action: string, status: string, selected: string[] | null, outcomes: unknown[], partial: boolean) => ({
  protocol: "hepi.v1",
  conversationId: "root",
  requestId,
  action,
  status,
  scope: ["child-a", "child-b", "child-c"],
  selected,
  outcomes,
  partial,
});

/** The whole subtree, the set a request with no named selection governs. */
const ALL = ["child-a", "child-b", "child-c"];
const governedOf = (selected: readonly string[] | null) => selected ?? ALL;

/**
 * The whole-subtree answer, projected over the subset the request captured.
 *
 * The addressed conversation is never among the governed children, and a child the request excluded does not appear:
 * what the Backend answers is what that request governs, not everything the family happens to list.
 */
function answeredBody(requestId: string, action: string, selected: string[] | null) {
  return scoped(requestId, action, "completed", selected, governedOf(selected).map((id) => child(id, id === "child-a" ? "stopping" : id === "child-b" ? "held" : "accepted", id === "child-a" ? "stopping" : "held")), false);
}

/** Refused and removed children, each stating its own reason, over only the subset this request governs. */
const FAILURES: Record<string, { status: string; reason?: string; run: ConversationRunState | null; control: string }> = {
  "child-a": { status: "refused", reason: "source_locked", run: "blocked", control: "allowed" },
  "child-b": { status: "stopping", run: "stopping", control: "held" },
  "child-c": { status: "conflict", reason: "session_deleted", run: null, control: "held" },
};
function partialBody(requestId: string, action: string, selected: string[] | null) {
  return scoped(requestId, action, "pending", selected, governedOf(selected).map((id) => {
    const failure = FAILURES[id];
    return child(id, failure.status, failure.run, failure.control, failure.reason);
  }), true);
}

/** The answer a refresh reads back: the outcomes unchanged, the drains settled, one child resumed by its own user. */
const SETTLED: Record<string, { status: string; run: ConversationRunState }> = {
  "child-a": { status: "stopping", run: "held" },
  "child-b": { status: "held", run: "held" },
  "child-c": { status: "accepted", run: "idle" },
};
function refreshedBody(requestId: string, action: string, selected: string[] | null) {
  return scoped(requestId, action, "completed", selected, governedOf(selected).map((id) => child(id, SETTLED[id].status, SETTLED[id].run)), false);
}

/**
 * The mixed set: every child takes the hold at once — so every outcome is `accepted` — while each child's own current row
 * states a different fact the catalogue owns: one blocked by the runtime, one interrupted by a restart, one with its
 * report queued, and one already running again because the user continued it. A surface that collapsed the recorded
 * outcome and the current row into one column could not show this answer at all.
 */
const CURRENT: Record<string, ConversationRunState> = {
  "child-a": "blocked",
  "child-b": "interrupted",
  "child-c": "waiting-report",
};
function mixedBody(requestId: string, action: string, selected: string[] | null) {
  return scoped(requestId, action, "completed", selected, governedOf(selected).map((id) => child(id, "accepted", CURRENT[id])), false);
}

/** A read-back of a request the Backend has not finished: one child answered, the rest still unreached. */
function pendingBody(requestId: string, action: string, selected: string[] | null) {
  const governed = governedOf(selected);
  return scoped(requestId, action, "pending", selected, [
    child(governed[0], SETTLED[governed[0]].status, SETTLED[governed[0]].run),
    ...governed.slice(1).map((id) => child(id, "pending", "running")),
  ], true);
}

function answer(url: string, init?: RequestInit): Response | Promise<Response> {
  const path = url.slice(INGRESS_ORIGIN.length).split("?")[0];
  const method = init?.method ?? "GET";
  if (path !== "/api/conversations/root/subtree-control") return json({ code: "unsupported", error: "the fixture serves no other route" }, 501);
  if (method === "GET") {
    const requestId = new URL(url).searchParams.get("requestId") ?? "";
    const capture = gate.captured[requestId];
    if (gate.mode === "no-record" || capture === undefined) {
      return json({ protocol: "hepi.v1", code: "unknown_request", error: "no subtree request with that id on this conversation" }, 404);
    }
    if (gate.mode === "pending") return json(pendingBody(requestId, capture.action, capture.selected), 200);
    if (gate.mode === "mixed") return json(mixedBody(requestId, capture.action, capture.selected), 200);
    return json(gate.mode === "partial" ? partialBody(requestId, capture.action, capture.selected) : refreshedBody(requestId, capture.action, capture.selected), 200);
  }
  const body = JSON.parse(String(init?.body ?? "{}"));
  const selected: string[] | null = Array.isArray(body.selected) ? body.selected : null;
  if (gate.mode === "refused") {
    // A selection naming anything outside the subtree is refused whole, before the request captures anything.
    return json({ protocol: "hepi.v1", code: "outside_subtree", error: "these conversations are not in the captured subtree of root: stranger" }, 409);
  }
  gate.captured[body.requestId] = { action: body.action, selected };
  if (gate.mode === "dropped") {
    // The answer never arrives; the transport fails after the request captured its scope.
    return Promise.reject(new TypeError("connection reset by peer"));
  }
  if (gate.mode === "partial") return json(partialBody(body.requestId, body.action, selected), 202);
  if (gate.mode === "mixed") return json(mixedBody(body.requestId, body.action, selected), 202);
  return json(answeredBody(body.requestId, body.action, selected), 202);
}

const connectionFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  gate.connection.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? init.body : null, authorization: headers.get("authorization") });
  return await answer(url, init);
};

const identity = connectionIdentityOf("profile-subtree", { backend: { id: "backend-1" }, account: { scope: "acct" } });
const client = createClient({
  origin: INGRESS_ORIGIN,
  credential: { kind: "bearer", token: BEARER },
  fetch: connectionFetch,
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});
const connection = workbenchConnection(client, identity);

const open = (session: SessionInfo) => gate.opened.push(session.id);

/**
 * The family rows this catalogue lists for one mode.
 *
 * A catalogue is one projection: the child tree and a subtree answer must never state two different statuses for one
 * conversation. The mixed mode is the case that would expose a second projection — every child's own row states a
 * different fact — so the rows the tree lists are the same ones the answer projects, from the same vocabulary.
 */
function rowsFor(mode: Mode): CatalogueRow[] {
  if (mode !== "mixed") return DESCENDANTS;
  return DESCENDANTS.map((row) => {
    const state = CURRENT[row.id];
    if (state === undefined) return row;
    const parent = row.id === "child-c" ? "child-a" : "root";
    return catalogueRow(entry(row.id, row.name ?? row.id, state, { createdBy: parent, displayParentId: parent }));
  });
}

function Fixture() {
  const [mode, setMode] = useState<Mode>("answered");
  const [controlled, setControlled] = useState(0);
  // The ids this catalogue currently lists for the root's family, in listing order.
  const [listed, setListed] = useState<string[]>(["child-a", "child-b", "child-c"]);
  const shown = rowsFor(mode).filter((row) => listed.includes(row.id));
  gate.mode = mode;
  gate.setMode = setMode;
  gate.setListed = (ids: string[]) => setListed(ids);
  gate.controlled = () => setControlled((count) => count + 1);
  return (
    <div style={{ width: 480 }}>
      <div data-controlled={controlled} />
      {/* The shell's own arrangement: the child tree on top, subtree control below it. A row stays a row. */}
      <AgentSessionPanel
        rootSession={ROOT}
        subagents={shown}
        selectedSessionId="root"
        runningSessionIds={RUNNING}
        onSelectSession={open}
      />
      <SubtreeControlPanel
        root={ROOT}
        descendants={shown.map((session) => ({ id: session.id, session }))}
        runningSessionIds={RUNNING}
        onSelectSession={open}
        onControlled={gate.controlled}
      />
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <WorkbenchConnectionProvider value={connection}>
    <I18nProvider>
      <Fixture />
    </I18nProvider>
  </WorkbenchConnectionProvider>,
);
