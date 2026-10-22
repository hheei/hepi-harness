import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import<typeof import("react")>("react");
const { renderToStaticMarkup } = await jiti.import<typeof import("react-dom/server")>("react-dom/server");
const { ChatInput } = await jiti.import<typeof import("./ChatInput.tsx")>("./ChatInput.tsx");
const { I18nProvider } = await jiti.import<typeof import("../hooks/useI18n.tsx")>("../hooks/useI18n.tsx");
const { createClient } = await jiti.import<typeof import("../client.ts")>("../client.ts");
const { workbenchConnection, WorkbenchConnectionProvider } = await jiti.import<typeof import("../lib/workbench-scope.ts")>("../lib/workbench-scope.ts");

type Props = Parameters<typeof ChatInput>[0];

/** The composer as a chat surface mounts it: inside one connection and one locale, with the props a conversation states. */
function render(overrides: Partial<Props> = {}): string {
  const client = createClient({
    origin: "https://gateway.example",
    credential: { kind: "cookie" },
    fetch: async () => new Response("{}"),
    createSource: () => ({ onmessage: null, close() {} }) as unknown as EventSource,
  });
  const connection = workbenchConnection(client, { profile: "test", backendId: "test", accountScope: "test" });
  const props = { onSend: () => {}, onAbort: () => {}, isStreaming: false, ...overrides } as Props;
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(
        WorkbenchConnectionProvider,
        { value: connection },
        React.createElement(ChatInput, props),
      ),
    ),
  );
}

const queuedItem = (overrides: Partial<import("@hepi/protocol").QueuedItemProjection> = {}) => ({
  submissionId: "s1", contentToken: "t1", content: "a queued follow-up", mode: "followUp" as const,
  source: { kind: "input" as const }, ...overrides,
}) as import("@hepi/protocol").QueuedItemProjection;

test("the composer states the queue the host gave it, with one control per item", () => {
  const html = render({
    queuedItems: [queuedItem()],
    onEditItem: async () => ({ ok: true }),
    onCancelItem: async () => ({ ok: true }),
  });
  assert.match(html, /a queued follow-up/, "the item's own text is what the row shows");
  assert.match(html, /data-queued-item="s1"/);
  assert.match(html, />Edit</, "a queue row the caller can edit offers it");
  assert.match(html, />Cancel</);
  assert.doesNotMatch(html, /data-held-banner/, "an allowed conversation states no hold");
});

test("a caller that can read the queue but not change it is offered no control it could not honour", () => {
  const html = render({ queuedItems: [queuedItem()] });
  assert.match(html, /a queued follow-up/);
  assert.doesNotMatch(html, />Edit</);
  assert.doesNotMatch(html, />Cancel</);
});

test("a queued item is drawn only by the queue, never by a local copy of it", () => {
  // The same item twice is the queue's mistake to make, not the composer's to dedupe: the rows are the projection.
  const html = render({
    queuedItems: [queuedItem(), queuedItem({ submissionId: "s2", contentToken: "t2", content: "and another" })],
    onEditItem: async () => ({ ok: true }),
    onCancelItem: async () => ({ ok: true }),
  });
  assert.match(html, /and another/);
  assert.match(html, /data-queued-item="s2"/);
});

test("the held banner is stated by the conversation's own control", () => {
  assert.doesNotMatch(render({ control: { state: "allowed", revision: 3 } }), /data-held-banner/);
  const held = render({ control: { state: "held", revision: 3 }, onContinue: async () => "allowed" });
  assert.match(held, /data-held-banner/);
  assert.match(held, /data-continue/, "the user's own stop is ended by their own Continue");
});

test("an idle composer sends, a streaming one steers and follows up instead", () => {
  const idle = render();
  assert.match(idle, /aria-label="[^"]*"/, "the send control is named for a screen reader");
  const streaming = render({ isStreaming: true, onSteer: () => {}, onFollowUp: () => {} });
  assert.notEqual(streaming, idle);
});

test("the catalog's own failures and the newest run's outcome are stated above the input", () => {
  const html = render({
    modelError: "the catalog could not be read",
    runFailure: { reason: "no_model", message: "no model is configured" },
    modelScopeWarnings: ["nothing matched gpt-*"],
  });
  assert.match(html, /the catalog could not be read/, "a catalog read failure is not a silent empty list");
  assert.match(html, /no model is configured/, "the run's own failure keeps its backend message");
  assert.match(html, /nothing matched gpt-\*/, "a pattern that matched nothing is visible where the model is chosen");
  assert.equal((render().match(/role="alert"/g) ?? []).length, 0, "a composer with nothing to report states nothing");
});

test("a catalog read that failed offers the one step that can change it, and nothing else", () => {
  // The recovery is a read of the same catalog. The composer states it beside the failure it recovers from, and a
  // caller that states no recovery is offered no control whose only outcome would be nothing.
  const recoverable = render({ modelError: "the catalog could not be read", onModelRetry: () => {} });
  assert.match(recoverable, /the catalog could not be read/);
  assert.match(recoverable, /<button[^>]*>Retry<\/button>/, "a recoverable catalog failure offers Retry: " + recoverable.slice(0, 400));
  const plain = render({ modelError: "the catalog could not be read" });
  assert.doesNotMatch(plain, /Retry/, "a caller with no recovery offered one anyway");
});

test("the model picker appears only when the conversation offers a choice", () => {
  const model = { provider: "p", modelId: "m1" };
  const modelList = [{ id: "m1", name: "Model One", provider: "p", input: ["text", "image"] }];
  assert.doesNotMatch(render({ model, modelList }), /Model One/, "a readout the caller cannot change is not a control");
  assert.match(render({ model, modelList, onModelChange: () => {} }), /Model One/);
});

test("a selection the catalog no longer lists is named as unavailable instead of silently replaced", () => {
  const html = render({
    model: { provider: "p", modelId: "retired" },
    modelList: [{ id: "m1", name: "Model One", provider: "p", input: ["text"] }],
    onModelChange: () => {},
  });
  assert.match(html, /p\/retired/, "the conversation's own model is stated, not one the catalog happens to have");
});
