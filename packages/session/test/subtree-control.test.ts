import assert from "node:assert/strict";
import test from "node:test";
import { createConversationControl } from "../src/control.ts";

/**
 * Subtree control at the client's control seam: one POST for the request, one GET for its durable record, and the
 * three-outcome rule the rest of the control surface already owns.
 *
 * What is decided here is only what a caller reads off the wire: the request id and the per-child outcomes are required,
 * because an answer without them states nothing about what the write did to each child, and a read-back 404 named
 * `unknown_request` is the Backend's answer to the question rather than a failed read. The capture, the selection check
 * and each child's control are the Backend's and are tested there.
 */

type Recorded = { readonly url: string; readonly method: string; readonly body?: unknown };

const json = (status: number, body: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

function client(answer: () => Promise<Response>): { control: ReturnType<typeof createConversationControl>; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const control = createConversationControl({
    conversationId: "7",
    basePath: "http://ingress/api/conversations",
    fetch: async (input, init) => {
      calls.push({ url: input, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
      return await answer();
    },
  });
  return { control, calls };
}

/** One child as the Backend answers it: its recorded outcome, its committed control, its current row. */
const child = (id: string, status: string, overrides: Record<string, unknown> = {}) => ({
  conversationId: id,
  status,
  control: { state: "held", revision: 4 },
  session: { id, runStatus: { state: "held" }, title: "Child " + id },
  ...overrides,
});

const answered = (overrides: Record<string, unknown> = {}) => ({
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

test("a subtree stop is one POST that carries the action and the selection, and answers each child separately", async () => {
  const { control, calls } = client(() => json(202, answered()));
  const result = await control.subtreeControl({ requestId: "sub-1", action: "stop", selected: ["9"] });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], {
    url: "http://ingress/api/conversations/7/subtree-control",
    method: "POST",
    body: { requestId: "sub-1", action: "stop", selected: ["9"] },
  });
  if (!result.ok) throw new Error("unreachable");
  assert.deepEqual([result.value.status, result.value.partial, result.value.outcomes.map((outcome) => [outcome.conversationId, outcome.status])], ["completed", false, [["8", "stopping"], ["9", "accepted"]]]);
  // The two halves of a child arrive as two halves: what the request recorded, its committed control, and the status
  // of the row the Backend stated beside it — read from that entry, not from a second request per child.
  const row = result.value.outcomes[0]!.session as { readonly runStatus?: { readonly state?: string } } | undefined;
  assert.deepEqual([result.value.outcomes[0]!.status, result.value.outcomes[0]!.control.state, row?.runStatus?.state], ["stopping", "held", "held"]);
});

test("omitting the selection sends no `selected` field, so the request governs the whole capture", async () => {
  const whole = client(() => json(202, answered({ selected: null })));
  await whole.control.subtreeControl({ requestId: "sub-2", action: "interrupt" });
  assert.deepEqual(whole.calls[0]!.body, { requestId: "sub-2", action: "interrupt" });
});

test("a partial result is an answer, not a failure: 202 states each child and says the set is not clean", async () => {
  const partial = client(() => json(202, answered({ status: "pending", partial: true, outcomes: [child("8", "conflict", { reason: "session_deleted", session: undefined, control: { state: "held", revision: 1 } }), child("9", "pending", { control: { state: "allowed", revision: 0 }, session: undefined })] })));
  const result = await partial.control.subtreeControl({ requestId: "sub-3", action: "stop" });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.partial, true);
  assert.equal(result.value.status, "pending");
  // A child the catalogue does not list states no row, and the caller keeps that absence rather than a default.
  assert.equal(result.value.outcomes[0]!.session, undefined);
  assert.equal(result.value.outcomes[0]!.reason, "session_deleted");
  // An outcome this build has no word for still arrives as the Backend's own word.
  assert.equal(result.value.outcomes[1]!.status, "pending");
});

test("a subtree refusal is the Backend's own code, and an answer that never arrived is unknown under its id", async () => {
  const refused = client(() => json(409, { code: "outside_subtree", error: "not in the captured subtree" }));
  const refusedAnswer = await refused.control.subtreeControl({ requestId: "sub-4", action: "stop", selected: ["99"] });
  assert.equal(refusedAnswer.ok, false);
  assert.equal(refusedAnswer.ok === false && refusedAnswer.kind, "refused");
  assert.equal(refusedAnswer.ok === false && refusedAnswer.kind === "refused" ? refusedAnswer.code : "", "outside_subtree");

  const dropped = client(() => { throw new TypeError("connection reset"); });
  const lost = await dropped.control.subtreeControl({ requestId: "sub-5", action: "stop" });
  assert.equal(lost.ok, false);
  assert.equal(lost.ok === false && lost.kind, "unknown");
  assert.equal(lost.ok === false && lost.kind === "unknown" ? lost.requestId : "", "sub-5");
  assert.equal(dropped.calls.length, 1, "a lost write is never retried at this seam");

  // An answer that names no request id states nothing a caller could ask about again.
  const anonymous = client(() => json(202, { ...answered(), requestId: "" }));
  const unreadable = await anonymous.control.subtreeControl({ requestId: "sub-6", action: "stop" });
  assert.equal(unreadable.ok === false && unreadable.kind, "unknown");
});

test("reading a request back asks for its id, states no record as an answer, and never controls anything", async () => {
  const { control, calls } = client(() => json(200, answered()));
  const read = await control.subtreeRequest("sub-1");
  assert.equal(read.ok, true);
  assert.deepEqual(calls[0], { url: "http://ingress/api/conversations/7/subtree-control?requestId=sub-1", method: "GET" });

  const missing = client(() => json(404, { protocol: "hepi.v1", code: "unknown_request", error: "no subtree request with that id" }));
  const noRecord = await missing.control.subtreeRequest("sub-nope");
  assert.deepEqual(noRecord, { ok: true, value: null });

  // A conversation the Backend does not have is a refusal about the conversation, not a statement about the record.
  const gone = client(() => json(404, { protocol: "hepi.v1", code: "not_found", error: "no conversation" }));
  const refused = await gone.control.subtreeRequest("sub-1");
  assert.equal(refused.ok === false && refused.kind === "refused" ? refused.code : "", "not_found");
});
