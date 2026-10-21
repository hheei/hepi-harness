import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { createProjection, advance, MAX_UNFINISHED_INTERESTS } = await createJiti(import.meta.url).import("./lifecycle-projection.ts");
const conversationId = "7";
const start = () => createProjection({ composerKey: "draft:new", conversationId });
const stage = (requestId, whenBusy = "steer") => ({ kind: "stage", requestId, content: { text: requestId }, whenBusy });
const receipt = (requestId, submissionId) => ({ kind: "receipt", conversationId, requestId, submissionId });
const record = (overrides = {}) => ({ type: "input", submissionId: "s1", status: "queued", ...overrides });
const lifecycle = (...records) => ({ kind: "lifecycle", conversationId, acquisition: 1, records });
const snapshot = (overrides = {}, input = {}) => ({
  kind: "snapshot", conversationId, acquisition: 1, via: "sse",
  snapshot: { projectionId: "P1", revision: 1, data: { entries: [{ id: "e1", message: { role: "user", content: "accepted" } }] }, run: null, submissions: [], ...overrides },
  ...input,
});
function feed(state, ...inputs) {
  const notices = [], effects = [];
  let step;
  for (const input of inputs) {
    step = advance(state, input);
    state = step.state;
    notices.push(...step.notices);
    effects.push(...step.effects);
  }
  return { ...step, notices, effects };
}

test("admission and equal snapshots are idempotent; terminal facts cannot regress", () => {
  const staged = feed(start().state, stage("r1"), stage("r1"), receipt("r1", "s1"), receipt("r1", "s1"));
  assert.deepEqual(staged.view.pending.map(turn => [turn.requestId, turn.status, turn.submissionId]), [["r1", "queued", "s1"]]);
  const placed = record({ requestId: "r1", status: "placed", entryId: "e1" });
  const baseline = snapshot({ revision: 5, submissions: [placed] });
  const good = feed(staged.state, { kind: "begin", acquisition: 1 }, baseline);
  assert.deepEqual(good.view.pending, []);
  assert.deepEqual(good.view.outstanding.map(interest => interest.entryId), ["e1"]);
  assert.deepEqual(feed(good.state, baseline).state, good.state);
  const done = feed(good.state, lifecycle(record({ ...placed, status: "done", answerId: "a1" })));
  const late = feed(done.state, baseline);
  assert.deepEqual(late.view.outstanding, []);
  assert.deepEqual(late.notices, []);
  const full = feed(start().state,
    ...Array.from({ length: MAX_UNFINISHED_INTERESTS + 3 }, (_, i) => stage("r" + i)),
    ...Array.from({ length: MAX_UNFINISHED_INTERESTS + 3 }, (_, i) => lifecycle(record({ requestId: "r" + i, submissionId: "s" + i, status: "placed", entryId: "e" + i }))),
  );
  assert.equal(full.view.outstanding.length, MAX_UNFINISHED_INTERESTS);
  assert.equal(full.view.outstanding[0].submissionId, "s3");
});

test("stale revisions, cancelled reads and foreign attachments cannot replace accepted state", () => {
  const good = feed(start().state, { kind: "begin", acquisition: 2 }, snapshot({ projectionId: "P2", revision: 8 }, { acquisition: 2 }));
  for (const [label, input, effects] of [
    ["older revision", snapshot({ projectionId: "P2", revision: 7, data: { entries: [] } }, { acquisition: 2, via: "http" }), []],
    ["cancelled acquisition", snapshot({ revision: 99, data: { entries: [] } }, { acquisition: 1, via: "http" }), []],
    ["foreign attachment", snapshot({ projectionId: "P1", revision: 99, data: { entries: [] } }, { acquisition: 2, via: "http" }), [{ kind: "reattach", acquisition: 2 }]],
  ]) {
    const late = feed(good.state, input);
    assert.deepEqual(late.view.messages.map(m => m.content), ["accepted"], label);
    assert.deepEqual(late.effects, effects, label);
  }
  const reconnected = feed(good.state, { kind: "begin", acquisition: 3 }, snapshot({ projectionId: "P3", revision: 1 }, { acquisition: 3 }));
  assert.equal(reconnected.view.ready, "ready");
  assert.equal(reconnected.state.identity, "P3");
  const baseline = feed(start().state, snapshot({ submissions: [record({ status: "done", entryId: "e1", answerId: "historical" })] }));
  assert.deepEqual(baseline.notices, []);
});

test("a receipt after a recovery sweep asks about the turn the sweep had to skip", () => {
  // The sweep could not ask about a staged turn — it had no submission identity yet — so the receipt that names one
  // owes the question, by the request id the browser generated. Nothing is cleared by the committed window: the fold
  // only ever settles a turn from its own record, and a recovery is never a completion.
  const swept = feed(start().state, { kind: "begin", acquisition: 1 }, stage("r1"), { kind: "recover", acquisition: 1 });
  assert.deepEqual(swept.effects, [], "a staged turn has nothing to ask about yet");
  assert.deepEqual(swept.view.pending.map(turn => [turn.requestId, turn.status]), [["r1", "staged"]]);
  const receipted = feed(swept.state, receipt("r1", "s1"));
  assert.deepEqual(receipted.effects, [{ kind: "lookup", acquisition: 1, subject: { requestId: "r1" } }]);
  assert.deepEqual(receipted.view.pending.map(turn => [turn.requestId, turn.status, turn.submissionId]), [["r1", "queued", "s1"]]);
  // The answer repairs the turn silently; a second sweep asks again, because a recovery is not a settlement.
  const answered = feed(receipted.state, { kind: "lookup", conversationId, acquisition: 1, subject: { requestId: "r1" }, record: record({ requestId: "r1", status: "placed", entryId: "e1" }) });
  assert.deepEqual(answered.notices, []);
  assert.deepEqual(answered.view.pending, []);
  assert.deepEqual(answered.view.outstanding.map(interest => interest.entryId), ["e1"]);
  // A receipt for a turn no sweep ran past asks nothing, and one for a turn this projection does not hold is inert.
  const plainReceipt = feed(start().state, stage("r2"), receipt("r2", "s2"));
  assert.deepEqual(plainReceipt.effects, []);
  assert.deepEqual(feed(plainReceipt.state, receipt("r3", "s3")).effects, []);
  // A refused turn never carries a receipt, so the question its sweep owed is dropped with it.
  const refused = feed(feed(start().state, stage("r4"), { kind: "recover", acquisition: 1 }).state, { kind: "refusal", conversationId, requestId: "r4", reason: "no capacity" });
  assert.deepEqual(feed(refused.state, receipt("r4", "s4")).effects, []);
});

test("refusals restore their own draft; foreign facts retain the last good view", () => {
  for (const owner of [undefined, conversationId]) {
    const refused = feed(start().state, stage("r1"), { kind: "refusal", conversationId: owner, requestId: "r1", reason: "no capacity" });
    assert.deepEqual(refused.view.pending, []);
    assert.deepEqual(refused.notices, [{ kind: "refused", requestId: "r1", reason: "no capacity", restore: { text: "r1" } }]);
  }
  const bound = feed(start().state, stage("r1"), snapshot());
  for (const input of [
    { kind: "refusal", conversationId: "other", requestId: "r1", reason: "no capacity" },
    { ...lifecycle(record({ status: "done", answerId: "a1" })), conversationId: "other" },
    lifecycle(record({ status: "done", entryId: "e1" })),
  ]) {
    const wrong = feed(bound.state, input);
    assert.equal(wrong.view.issue.kind, "protocol");
    assert.deepEqual(wrong.view.messages.map(m => m.content), ["accepted"]);
    assert.deepEqual(wrong.notices, []);
  }
});
