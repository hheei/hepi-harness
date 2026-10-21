import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { readCatalogAnswer } = await createJiti(import.meta.url).import("./catalog-answer.ts");

/**
 * The one shape the workbench's selectors read, from the two answers a deployment can give.
 *
 * The case that matters is the one this page is served today: the Backend states `models` as a list, so a reader that
 * treats `models` as a name map builds its names out of objects and a selector renders an object as a React child.
 */

const backendAnswer = {
  models: [
    { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek V4.1 Flash", reasoning: true, contextWindow: 1000000, maxTokens: 384000, input: ["text", "image"], cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }, thinkingLevelMap: { low: "low" } },
    { provider: "deepseek", id: "acceptance-model", name: "Acceptance Model", input: ["text"] },
  ],
  thinkingLevels: { "deepseek:deepseek-flash": ["off", "low"] },
  thinkingLevelMaps: { "deepseek:deepseek-flash": { low: "low" } },
  defaultModel: { provider: "deepseek", modelId: "acceptance-model" },
  defaultThinkingLevel: "medium",
};

test("the Backend's list is the catalog, and its names are the entries' own", () => {
  const catalog = readCatalogAnswer(backendAnswer);
  assert.deepEqual(catalog.modelList.map((model) => model.provider + "/" + model.id), ["deepseek/deepseek-flash", "deepseek/acceptance-model"]);
  // A name is a string, never the model object it came from: this is what a selector renders.
  assert.deepEqual(catalog.models, { "deepseek:deepseek-flash": "DeepSeek V4.1 Flash", "deepseek:acceptance-model": "Acceptance Model" });
  assert.ok(Object.values(catalog.models).every((name) => typeof name === "string"), "a name that is not a string reaches a selector");
  // The facts a selector and the image-input check read survive the read.
  assert.deepEqual(catalog.modelList[0].input, ["text", "image"]);
  assert.equal(catalog.modelList[0].contextWindow, 1000000);
  assert.deepEqual(catalog.defaultModel, { provider: "deepseek", modelId: "acceptance-model" });
  assert.deepEqual(catalog.thinkingLevels, { "deepseek:deepseek-flash": ["off", "low"] });
  assert.equal(catalog.defaultThinkingLevel, "medium");
});

test("the retired BFF's name map is still read as the map it is", () => {
  const catalog = readCatalogAnswer({ models: { "p:shared": "Shared" }, modelList: [{ provider: "p", id: "shared", name: "Shared" }], defaultModel: null });
  assert.deepEqual(catalog.models, { "p:shared": "Shared" });
  assert.deepEqual(catalog.modelList.map((model) => model.id), ["shared"]);
  assert.equal(catalog.defaultModel, null);
});

test("an empty, absent or malformed answer is an empty catalog rather than a failure", () => {
  for (const answer of [{ models: [] }, {}, null, undefined, "not json", { models: [{ provider: "p" }, { id: "no-provider" }] }]) {
    const catalog = readCatalogAnswer(answer);
    assert.deepEqual(catalog.modelList, [], "a malformed entry became a model: " + JSON.stringify(answer));
    assert.deepEqual(catalog.models, {});
    assert.equal(catalog.defaultModel, null);
  }
});
