import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { WorkbenchClient } from "../client.ts";
import type { CatalogueEntry, CatalogueRow } from "./conversation-catalogue.ts";
import type { SubtreeReadResult, SubtreeResult, SubtreeView } from "./subtree-control.ts";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const lib = await jiti.import<typeof import("./subtree-control.ts")>("./subtree-control.ts");
const { catalogueRow } = await jiti.import<typeof import("./conversation-catalogue.ts")>("./conversation-catalogue.ts");
const {
  subtreeAttemptKey,
  subtreeConfirm,
  subtreeRelease,
  subtreeControlFrom,
  subtreeReadFrom,
} = lib;

/**
 * Subtree control as the browser's own seam reads it.
 *
 * The Backend owns the capture, the selection check and every child's control. What lives here is the three things a
 * surface cannot get from a raw request: the attempt identity a retry has to repeat, the confirmed subset that same retry
 * has to repeat with it, and an answer that keeps **what the request recorded** separate from **what the child is doing
 * now** — projected through the same `catalogueRow` the session list uses, so one conversation never has two rows on one
 * screen. A child the Backend stated no row for keeps its absence: showing it as `idle` would be the aggregate-state lie
 * this operation is built not to produce.
 */

/** One child as the Backend answers it: its durable outcome, its control, and the row the catalogue states. */
type ChildAnswer = {
  readonly conversationId: string;
  readonly status: string;
  readonly reason?: string;
  readonly control: { readonly state: string; readonly revision: number };
  /** Absent for a child the Backend stated no catalogue row for — a removed or detached conversation. */
  readonly session?: CatalogueEntry;
};

/** One subtree answer as it crosses the wire. */
type AnswerBody = {
  readonly protocol: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly action: "stop" | "interrupt";
  readonly status: "completed" | "pending";
  readonly scope: readonly string[];
  readonly selected: readonly string[] | null;
  readonly outcomes: readonly ChildAnswer[];
  readonly partial: boolean;
};

const child = (id: string, status: string, overrides: Partial<ChildAnswer> = {}): ChildAnswer => ({
  conversationId: id,
  status,
  control: { state: "held", revision: 4 },
  session: { id, workspaceId: "feature", gatewayId: "workstation", workspace: { gatewayId: "workstation" }, busy: true, revision: 9, messageCount: 2, firstMessage: "work", title: "Child " + id, runStatus: { state: "stopping" } },
  ...overrides,
});

const answer = (overrides: Partial<AnswerBody> = {}): AnswerBody => ({
  protocol: "hepi.v1",
  conversationId: "7",
  requestId: "sub-1",
  action: "stop",
  status: "completed",
  scope: ["8", "9"],
  selected: null,
  outcomes: [child("8", "stopping"), child("9", "accepted")],
  partial: false,
  ...overrides,
});

/** The Backend's own refusal, as it states one: the protocol, its code, and a sentence to show. */
type RefusalBody = { readonly protocol: string; readonly code: string; readonly error: string };

/** One request a case's client was asked to make, with its body already parsed. */
type SentRequest = { readonly url: string; readonly method: string; readonly body: unknown };

/** The body a case's client sent, as the JSON it wrote: the request the Backend is actually asked to answer. */
function sentBody(sent: SentRequest | undefined): Record<string, unknown> {
  assert.ok(sent, "the client was asked to make a request");
  assert.ok(sent.body !== undefined && typeof sent.body === "object" && sent.body !== null, "the request carried a JSON body");
  return sent.body as Record<string, unknown>;
}

/** The view a case reached for out of a result that could also have been a refusal or an unknown outcome. */
function viewOf(result: SubtreeResult): SubtreeView {
  assert.ok(result.ok, "the Backend answered a subtree view rather than a failure");
  assert.ok("view" in result, "the answer is a view, not a missing record");
  return result.view;
}

/** The view a read-back reached for, when the answer is the record it asked about rather than its absence. */
function recordedView(read: SubtreeReadResult): SubtreeView {
  assert.ok(read.ok, "the Backend answered the request it was asked about");
  assert.ok("view" in read, "the answer is the request's own record");
  return read.view;
}

/** The refusal a result states, when the Backend answered rather than the answer being lost. */
function refusalOf(result: SubtreeResult | SubtreeReadResult): { readonly code: string; readonly message: string } {
  assert.ok(!result.ok, "the Backend refused the request");
  assert.ok("refusal" in result, "the refusal arrived as the Backend's own code and sentence");
  return result.refusal;
}

/** The row a child answer stated, as the catalogue projects it. */
function sessionOf(childAnswer: ChildAnswer): CatalogueRow {
  assert.ok(childAnswer.session, "the child answer stated a catalogue row");
  return catalogueRow(childAnswer.session);
}

/** A client that records what it was asked and answers what the test states. */
function client(body: AnswerBody | RefusalBody | string, status = 202): WorkbenchClient & { readonly calls: SentRequest[] } {
  const calls: SentRequest[] = [];
  return {
    calls,
    request: async (path, init) => {
      calls.push({
        url: path,
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    },
  } as WorkbenchClient & { readonly calls: SentRequest[] };
}

test("the attempt key is the decision: another subset, action or conversation is another attempt", () => {
  // A chosen subset is one attempt whatever order the surface happened to list it in, and nothing else about the
  // listing (revision, order, a child that arrived) makes it a different decision.
  assert.equal(subtreeAttemptKey("7", "stop", ["8", "9"]), subtreeAttemptKey("7", "stop", ["9", "8"]));
  assert.notEqual(subtreeAttemptKey("7", "stop", ["8"]), subtreeAttemptKey("7", "stop", null));
  assert.notEqual(subtreeAttemptKey("7", "stop", ["8"]), subtreeAttemptKey("7", "interrupt", ["8"]));
  assert.notEqual(subtreeAttemptKey("7", "stop", ["8"]), subtreeAttemptKey("8", "stop", ["8"]), "another conversation's subtree is its own attempt");
});

test("a subtree stop is posted on the connection the page holds, with the Backend's own body", async () => {
  const connection = client(answer());
  const result = await subtreeControlFrom(connection, { key: "k", requestId: "sub-1", rootId: "7", action: "stop", selected: ["9"] });
  assert.equal(result.ok, true);
  assert.deepEqual(connection.calls[0], {
    url: "/api/conversations/7/subtree-control",
    method: "POST",
    body: { requestId: "sub-1", action: "stop", selected: ["9"] },
  });
  assert.equal(connection.calls[0].body.selected.includes("7"), false, "the addressed conversation is never in the body");
});

test("a whole-subtree decision is sent with no selection field, so the Backend's capture governs", async () => {
  const connection = client(answer());
  await subtreeControlFrom(connection, { key: "k", requestId: "sub-1", rootId: "7", action: "stop", selected: null });
  assert.deepEqual(connection.calls[0].body, { requestId: "sub-1", action: "stop" }, "an omitted selection is not an empty one");
});

/**
 * What a confirmed decision is, and what it stays.
 *
 * A lost answer is resumed against a listing that moved: a child finished and left it, or a new one arrived. If the
 * subset were derived again at resume time the retry would name a different set than the one the user approved —
 * narrower than the capture and refused whole as `outside_subtree`, or empty, which tells the Backend to capture the
 * WHOLE subtree, the deliberately excluded children included. Both widen a decision that was narrowed on purpose, and
 * neither is what the confirmation said. So the subset is frozen with the identity, and a settled attempt — by its own
 * answer or by a read-back that states completion — releases it, so the next identical decision is a fresh capture
 * instead of a replay of a request that already finished.
 */
test("a confirmed decision is one frozen record: its identity, its subset, and its addressed conversation", () => {
  const attempts = new Map();
  let minted = 0;
  const mint = () => "id-" + ++minted;

  const confirmed = subtreeConfirm(attempts, { rootId: "7", action: "stop", selected: ["8"] }, mint);
  assert.deepEqual([confirmed.rootId, confirmed.action, confirmed.selected, confirmed.key], ["7", "stop", ["8"], subtreeAttemptKey("7", "stop", ["8"])]);

  // Deciding the same thing again while it is unresolved is the same attempt: same identity, same subset.
  const retried = subtreeConfirm(attempts, { rootId: "7", action: "stop", selected: ["8"] }, mint);
  assert.equal(retried.requestId, confirmed.requestId, "a retry is not a second request");
  assert.deepEqual(retried.selected, confirmed.selected);
  assert.equal(minted, 1, "and it mints nothing");

  // A different action, a different subset or a different conversation is a different decision.
  assert.notEqual(subtreeConfirm(attempts, { rootId: "7", action: "interrupt", selected: ["8"] }, mint).requestId, confirmed.requestId);
  assert.notEqual(subtreeConfirm(attempts, { rootId: "7", action: "stop", selected: ["9"] }, mint).requestId, confirmed.requestId);
  assert.notEqual(subtreeConfirm(attempts, { rootId: "8", action: "stop", selected: ["8"] }, mint).requestId, confirmed.requestId);

  // Release it, and the identical decision is a NEW capture: an identity held past completion would be answered from
  // the capture it already made — children shown as controlled while nothing was reached.
  subtreeRelease(attempts, confirmed);
  const after = subtreeConfirm(attempts, { rootId: "7", action: "stop", selected: ["8"] }, mint);
  assert.notEqual(after.requestId, confirmed.requestId, "a settled attempt lends its identity to nothing");
  // The frozen subset survives on the record itself, whatever the caller's listing looks like now.
  assert.deepEqual(after.selected, ["8"]);
});

test("resending an attempt posts the subset it was confirmed with, not one read from a listing since", async () => {
  const attempts = new Map();
  const confirmed = subtreeConfirm(attempts, { rootId: "7", action: "stop", selected: ["8"] }, () => "sub-9");
  const connection = client(answer());
  await subtreeControlFrom(connection, confirmed);
  assert.deepEqual(sentBody(connection.calls[0]), { requestId: "sub-9", action: "stop", selected: ["8"] }, "the send takes only the attempt, so nothing else can widen it");

  const read = client(answer({ requestId: "sub-9" }), 200);
  await subtreeReadFrom(read, confirmed);
  assert.equal(read.calls[0].url, "/api/conversations/7/subtree-control?requestId=sub-9", "and a read is that same attempt's id");
});

test("each child keeps both halves: the recorded outcome and the current row, projected as the list projects it", async () => {
  const result = await subtreeControlFrom(client(answer()), { key: "k", requestId: "sub-1", rootId: "7", action: "stop", selected: null });
  const view = viewOf(result);
  const [first, second] = view.children;
  assert.ok(first && second, "the answer states a row for each child");
  // What the request recorded is what the answer states, untouched by the child's present.
  assert.deepEqual([first.status, first.control.state], ["stopping", "held"]);
  // `Now` is the catalogue's own row for that conversation — the same projection the list and the poll publish.
  assert.deepEqual(first.session, sessionOf(child("8", "stopping")));
  assert.equal(first.session?.runStatus?.state, "stopping");
  assert.equal(second.session?.runStatus?.state, "stopping", "each row is the child's own, never borrowed from a sibling");
  assert.deepEqual([view.status, view.partial, view.scope], ["completed", false, ["8", "9"]]);
});

test("a child the catalogue states no row for keeps that absence, and an unknown outcome keeps its own word", async () => {
  const removed = child("8", "conflict", { reason: "session_deleted", session: undefined, control: { state: "held", revision: 1 } });
  const novel = child("9", "quiescing", { session: undefined });
  const result = await subtreeControlFrom(client(answer({ status: "pending", partial: true, outcomes: [removed, novel] })), { key: "k", requestId: "sub-2", rootId: "7", action: "stop", selected: null });
  const view = viewOf(result);
  assert.equal(view.children[0]?.session, undefined, "a removed child states no row rather than one no surface shows");
  assert.equal(view.children[0]?.reason, "session_deleted");
  // An outcome this build has no word for arrives as the Backend's word instead of being dropped or mapped onto a
  // nearby one — a flattened answer would hide which child refused.
  assert.equal(view.children[1]?.status, "quiescing");
  assert.equal(view.status, "pending");
});

test("a lost answer is reported as unknown under its own id and never re-sent, and a refusal keeps the Backend's code", async () => {
  const dropped = { request: async (): Promise<Response> => { throw new TypeError("connection reset"); } } as unknown as WorkbenchClient;
  const lost = await subtreeControlFrom(dropped, { key: "k", requestId: "sub-3", rootId: "7", action: "stop", selected: null });
  assert.deepEqual([lost.ok, "unknown" in lost && lost.unknown, "requestId" in lost ? lost.requestId : undefined], [false, true, "sub-3"]);

  const refused = client({ protocol: "hepi.v1", code: "outside_subtree", error: "these conversations are not in the captured subtree: 99" }, 409);
  const answer409 = await subtreeControlFrom(refused, { key: "k", requestId: "sub-4", rootId: "7", action: "stop", selected: ["99"] });
  const refusal = refusalOf(answer409);
  assert.deepEqual([refusal.code, refusal.message], ["outside_subtree", "these conversations are not in the captured subtree: 99"]);
});

test("the read-back refreshes a request without controlling anything, and states no record as an answer", async () => {
  const answered = child("8", "stopping");
  const connection = client(answer({
    requestId: "sub-5",
    outcomes: [child("8", "stopping", { session: { ...sessionOf(answered), runStatus: { state: "held" } } }), child("9", "accepted")],
  }), 200);
  const read = await subtreeReadFrom(connection, { key: "k", requestId: "sub-5", rootId: "7", action: "stop", selected: null });
  const view = recordedView(read);
  assert.deepEqual(connection.calls[0], { url: "/api/conversations/7/subtree-control?requestId=sub-5", method: "GET", body: undefined });
  // The outcome the request recorded still reads `stopping`, and the row now reads `held`: the drain settled and the
  // record was not restated from the present.
  assert.deepEqual([view.children[0]?.status, view.children[0]?.session?.runStatus?.state], ["stopping", "held"]);

  const missing = client({ protocol: "hepi.v1", code: "unknown_request", error: "no subtree request with that id on this conversation" }, 404);
  const noRecord = await subtreeReadFrom(missing, { key: "k", requestId: "sub-nope", rootId: "7", action: "stop", selected: null });
  assert.deepEqual(noRecord, { ok: true, noRecord: true }, "the Backend's own unknown_request is an answer, not a failed read");

  const gone = client({ protocol: "hepi.v1", code: "not_found", error: "no conversation with id 7" }, 404);
  const refused = await subtreeReadFrom(gone, { key: "k", requestId: "sub-5", rootId: "7", action: "stop", selected: null });
  assert.equal(refusalOf(refused).code, "not_found");
});
