import assert from "node:assert/strict";
import test from "node:test";
import { findChatScrollAnchor } from "./chat-scroll-position.ts";

test("scroll anchors retain position and distinguish repeated entry IDs by index", () => {
  const candidates = [
    { entryId: "same", top: 20, bottom: 80 },
    { entryId: "same", top: 420, bottom: 480 },
  ];
  for (const [scrollTop, expected] of [
    [0, { anchorEntryId: "same", anchorOffset: 20, anchorIndex: 0 }],
    [200, { anchorEntryId: "same", anchorOffset: -180, anchorIndex: 0 }],
    [500, { anchorEntryId: "same", anchorOffset: -80, anchorIndex: 1 }],
  ]) assert.deepEqual(findChatScrollAnchor(candidates, scrollTop), expected);
  assert.equal(findChatScrollAnchor([], 100), null);
});
