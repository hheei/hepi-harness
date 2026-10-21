import assert from "node:assert/strict";
import { test } from "node:test";
import { createFileSurface, type FileSurfaceRequest } from "../src/files-surface.ts";

/**
 * The browser's answer for each cause a workbench read can have.
 *
 * `files-surface.ts` is the one place a host refusal becomes an HTTP answer a browser can act on, and the causes are
 * not interchangeable: a gateway composed without a workbench, a host that could not be reached, and a read the host
 * failed to complete each ask for a different next move. Until this revision every one of them except two collapsed into
 * a single `501` claiming the host "is composed without the workbench surface" — a statement about the deployment that
 * was false in the common case, because opening a file that was deleted after the listing was cached reads as the
 * host's `operation_failed`.
 *
 * The Backend is stubbed here on purpose: what is under test is the translation from a refusal to a status and code,
 * which is this module's own. The routes that carry those refusals end to end — real ingress, real Backend, real
 * gateways, local and SSH — are asserted in `ingress-ssh-workbench.test.ts`.
 */

type Refusal = { ok: false; code: string };

/** One surface over a Backend that answers every call with the same body, plus the calls it was asked to make. */
function surface(answer: unknown, calls: string[] = []) {
  const handler = createFileSurface({
    call: async (path) => { calls.push(path); return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }); },
  });
  return { handler, calls };
}

function request(path: string, init: { method?: string; search?: Record<string, string> } = {}): FileSurfaceRequest {
  const url = new URL("http://surface.test" + path + (init.search === undefined ? "" : "?" + new URLSearchParams(init.search).toString()));
  return { method: init.method ?? "GET", url, headers: {} };
}

/** The refusal every workbench-backed browser path reaches the surface with. */
async function refusalOf(answer: Refusal, path: string, search: Record<string, string>): Promise<{ status: number; body: { code?: string; error?: string } }> {
  const { handler } = surface(answer);
  const response = await handler(request(path, { search }));
  assert.ok(response, "the surface did not answer " + path);
  return { status: response.status, body: await response.json() as { code?: string; error?: string } };
}

const CAUSES: readonly { readonly code: string; readonly status: number; readonly named: string; readonly says: string }[] = [
  { code: "unknown_workspace", status: 404, named: "unknown_workspace", says: "no such workspace in this deployment" },
  { code: "path_denied", status: 403, named: "path_denied", says: "the host refused that path" },
  { code: "not_found", status: 404, named: "not_found", says: "the host has no" },
  { code: "gateway_offline", status: 503, named: "gateway_offline", says: "could not be reached" },
  { code: "not_supported", status: 501, named: "not_supported", says: "composed without a workbench" },
  { code: "operation_failed", status: 500, named: "operation_failed", says: "could not answer for" },
];

test("each cause a workbench read can have reaches the browser as its own answer", async () => {
  for (const path of [
    ["/api/files/workspace/ws/report.md", { type: "read" }] as const,
    ["/api/files/workspace/ws", { type: "list" }] as const,
  ]) {
    for (const cause of CAUSES) {
      const answer = await refusalOf({ ok: false, code: cause.code }, path[0], path[1]);
      assert.equal(answer.status, cause.status, cause.code + " for " + path[0] + " answered " + answer.status);
      assert.equal(answer.body.code, cause.named, cause.code + " keeps its own name: " + answer.body.code);
      assert.match(answer.body.error ?? "", new RegExp(cause.says), cause.code + " states its own cause");
    }
  }
});

test("a read that failed is never reported as a missing capability", async () => {
  for (const code of ["operation_failed", "gateway_offline"]) {
    for (const path of [["/api/files/workspace/ws/report.md", { type: "read" }] as const, ["/api/git/status", { cwd: "/workspace/ws" }] as const]) {
      const answer = await refusalOf({ ok: false, code }, path[0], path[1]);
      assert.ok(!JSON.stringify(answer.body).includes("without the workbench"), code + " on " + path[0] + " claimed a missing capability: " + answer.body.error);
      assert.notEqual(answer.body.code, "not_supported", code + " is not a capability answer");
    }
  }
});

test("the absent surface is still the 501 it was, and says what is absent", async () => {
  const answer = await refusalOf({ ok: false, code: "not_supported" }, "/api/git/status", { cwd: "/workspace/ws" });
  assert.equal(answer.status, 501);
  assert.match(answer.body.error ?? "", /changed files/);
});

test("a workbench answer that is not JSON is a failure, not a capability claim", async () => {
  const handler = createFileSurface({ call: async () => new Response("<html>not json</html>", { status: 200 }) });
  const response = await handler(request("/api/files/workspace/ws/report.md", { search: { type: "read" } }));
  assert.ok(response);
  assert.equal(response.status, 500, "an unreadable Backend answer became " + response.status);
  assert.equal((await response.json() as { code: string }).code, "operation_failed");
});

test("the capabilities this surface does not have keep their own named 501", async () => {
  const { handler } = surface({ ok: true, value: [] });
  for (const type of ["watch", "preview", "allow-link"]) {
    const response = await handler(request("/api/files/workspace/ws/report.md", { search: { type } }));
    assert.ok(response);
    const body = await response.json() as { code: string; accepted: boolean; error: string };
    assert.equal(response.status, 501, type + " answered " + response.status);
    assert.equal(body.code, "unsupported", type + " is named as an unsupported operation, not a host refusal");
    assert.equal(body.accepted, false);
  }
});

test("the refusal causes travel back through the Backend's own body", async () => {
  const calls: string[] = [];
  // A Backend that answers the transport's own 503 (the workbench route maps a thrown offline error to it) must not
  // have that turned into "this host cannot serve a file listing".
  const handler = createFileSurface({
    call: async (path) => {
      calls.push(path);
      const offline = new Response(JSON.stringify({ ok: false, code: "gateway_offline" }), { status: 503, headers: { "content-type": "application/json" } });
      return path === "/api/workbench" ? offline : new Response(JSON.stringify({ ok: true, value: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const response = await handler(request("/api/files/workspace/ws", { search: { type: "list" } }));
  assert.ok(response);
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { code: string }).code, "gateway_offline");
  assert.ok(calls.includes("/api/workbench"), "the listing was not asked of the Backend");
});

test("a Word document is served as its own bytes and never asked of the workbench", async () => {
  // The surface's routing decision, stated once: a docx is a package, so the host's text preview of it is a binary
  // placeholder that says nothing about the document. The browser reads the bytes instead (packages/ui/src/lib/
  // docx-preview.ts), which is why this path asks the byte route and not /api/workbench — a docx that went through the
  // workbench would arrive as an unusable 200 KiB of nothing.
  const calls: string[] = [];
  const docxBytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4]);
  const handler = createFileSurface({
    call: async (path) => {
      calls.push(path);
      return path.startsWith("/api/files/bytes")
        ? new Response(docxBytes, { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-length": String(docxBytes.byteLength) } })
        : new Response(JSON.stringify({ ok: true, value: { content: "", binary: true, truncated: false, sizeBytes: docxBytes.byteLength } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const response = await handler(request("/api/files/workspace/ws/report.docx", { search: { type: "read" } }));
  assert.ok(response);
  assert.equal(response.status, 200, "a docx read answered " + response.status);
  assert.equal(response.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...docxBytes], "the document arrived altered");
  assert.ok(!calls.some((path) => path === "/api/workbench"), "a docx was previewed as text: " + JSON.stringify(calls));
  assert.ok(calls.some((path) => path.startsWith("/api/files/bytes")), "the byte route was not asked: " + JSON.stringify(calls));
  // Its meta answer is what the viewer reads before deciding to fetch, so the bound is checkable without a body.
  const meta = await handler(request("/api/files/workspace/ws/report.docx", { search: { type: "meta" } }));
  assert.ok(meta);
  assert.equal(((await meta.json() as { previewKind?: string }).previewKind), "docx", "the meta answer lost the preview kind");
});