import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { WorkbenchConnection } from "./workbench-scope.ts";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import<typeof import("react")>("react");
const { renderToStaticMarkup } = await jiti.import<typeof import("react-dom/server")>("react-dom/server");
const { createClient } = await jiti.import<typeof import("../client.ts")>("../client.ts");
const { workbenchConnection, WorkbenchConnectionProvider } = await jiti.import<typeof import("./workbench-scope.ts")>("./workbench-scope.ts");
const { connectionScopeKey } = await jiti.import<typeof import("./connection-scope.ts")>("./connection-scope.ts");
const { useApiRequest } = await jiti.import<typeof import("./api-request.ts")>("./api-request.ts");

/**
 * One connection, assembled once, and the request seams that are that connection's own.
 *
 * The rule is that a surface asks the connection it is rendered under and has nothing else to ask: a conversation API is
 * built with the connection rather than by each surface that reads it, and a surface outside a connection is a wiring
 * error rather than a page-origin request. Both halves are asserted at the seam a product surface uses: the object the
 * provider holds, and the request a hook hands back.
 */

const identity = { profile: "web", backendId: "backend-1", accountScope: "acct" };

/** One connection over a synthetic transport, recording what it was asked. */
function connectionWith(calls: string[]): WorkbenchConnection {
  return workbenchConnection(createClient({
    origin: "https://gateway.example",
    credential: { kind: "bearer", token: "device" },
    fetch: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ model: null, thinkingLevel: "off" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
  }), identity);
}

test("a connection carries one conversation API, bound to its own client", async () => {
  const calls: string[] = [];
  const connection = connectionWith(calls);
  assert.equal(connection.scope, connectionScopeKey(identity), "the connection's scope is the identity's own key");

  assert.deepEqual(await connection.api.settings("conv"), { model: null, thinkingLevel: "off" });
  assert.deepEqual(calls, ["https://gateway.example/api/conversations/conv/settings"], "the API asked this connection's own origin");

  // Disposing the connection retires the API with it: the same object cannot keep talking after the client is gone.
  connection.client.dispose();
  await assert.rejects(connection.api.settings("conv"), /closed/, "a disposed connection's API answered anyway");
});

test("a surface with no connection fails loudly instead of asking the page's own origin", () => {
  const calls: string[] = [];
  const pageFetch = globalThis.fetch;
  globalThis.fetch = (...args: Parameters<typeof fetch>) => { calls.push(String(args[0])); return pageFetch(...args); };
  try {
    function Probe() {
      const request = useApiRequest();
      // The rejection of a disposed connection is the client's own; this case is about which transport was chosen.
      void request("/api/tools/settings").catch(() => {});
      return React.createElement("span", null, "probe");
    }
    assert.throws(
      () => renderToStaticMarkup(React.createElement(Probe)),
      /mounted outside a connection/,
      "a surface outside a connection invented one",
    );
    assert.deepEqual(calls, [], "no surface fell back to the page origin");

    // Inside a connection, the same hook's request is that connection's: its origin and its credential, once.
    const connection = connectionWith(calls);
    renderToStaticMarkup(React.createElement(WorkbenchConnectionProvider, { value: connection }, React.createElement(Probe)));
    assert.deepEqual(calls, ["https://gateway.example/api/tools/settings"], "the panel asked its own connection");
    connection.client.dispose();
  } finally {
    globalThis.fetch = pageFetch;
  }
});
