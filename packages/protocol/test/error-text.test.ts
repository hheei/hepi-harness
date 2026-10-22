import assert from "node:assert/strict";
import test from "node:test";
import { errorText } from "../src/error-text.ts";

test("an Error contributes its own message", () => {
  assert.equal(errorText(new Error("the model request failed")), "the model request failed");
});

test("an Error subclass contributes the message it was built with", () => {
  assert.equal(errorText(new TypeError("x is not a function")), "x is not a function");
});

test("an Error without a message contributes the empty string", () => {
  assert.equal(errorText(new Error()), "");
});

test("a thrown string is its own text", () => {
  assert.equal(errorText("host unreachable"), "host unreachable");
});

test("a thrown value that is not an Error keeps String() semantics", () => {
  assert.equal(errorText(undefined), "undefined");
  assert.equal(errorText(null), "null");
  assert.equal(errorText(42), "42");
  assert.equal(errorText({ message: "looks like an error" }), "[object Object]");
});
