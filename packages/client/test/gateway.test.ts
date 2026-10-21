import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GatewayWorktrees, WorkspaceRegistry, type WorktreeServer } from "../../gateway/src/index.ts";
import { createFakeSshHost } from "../../gateway/test/fake-ssh.ts";
import { run } from "../src/cli.ts";

/**
 * The worktree surface the CLI's own gateway serves, driven the way the backend drives it: a real `hepi-client gateway`
 * composition, listening on loopback, reached over `POST /v1/worktrees` with a bearer token.
 *
 * The host behind that composition is the in-memory fake this repository's gateway suite uses, so a create really
 * writes a checkout and a remove really deletes it — the listing is read back from the host's own model, not from the
 * answer under test — without a git process or a repository on this machine. Only the host is substituted: the
 * registry, the route, the token check and the CLI's own startup path are the ones production runs.
 */
test("the gateway the CLI starts serves worktree list, create and remove", { timeout: 15_000 }, async () => {
  const host = createFakeSshHost({ root: "/srv/repo", user: "builder", home: "/home/builder" });
  host.initRepository("/srv/repo", "main");
  const token = "worktree-token";
  let ready: (running: { origin: string; close(): Promise<void> }) => void = () => {};
  const started = new Promise<{ origin: string; close(): Promise<void> }>(resolveStarted => { ready = resolveStarted; });
  // The CLI's own gateway composition, with the worktree host this test controls. The state directory is the only
  // thing it writes, because the call journal lives in one.
  const state = await mkdtemp(join(tmpdir(), "hepi-client-worktrees-"));
  const gateway = run(
    ["gateway", "--root", host.root, "--data-dir", state, "--port", "0"],
    {
      env: { HEPI_GATEWAY_TOKEN: token },
      out: () => {},
      err: () => {},
      onStarted: ready,
      worktrees: workspaces => new GatewayWorktrees(workspaces, host.git, host.existingPaths),
    },
  );
  const running = await Promise.race([
    started,
    gateway.then(code => { throw new Error("the gateway exited with " + code + " instead of listening"); }),
  ]);
  const call = async (body: Record<string, unknown>) => {
    const response = await fetch(running.origin + "/v1/worktrees", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await response.json() as { ok: boolean; code?: string; value?: unknown };
  };
  try {
    const listed = await call({ operation: "list", workspaceId: "local" });
    assert.equal(listed.ok, true);
    // The listing describes the checkout the host itself holds: its path, its branch, and that it is the main one.
    assert.deepEqual((listed.value as { worktrees: unknown }).worktrees, [{ path: host.root, branch: "main", isMain: true }]);
    // A workspace this gateway does not serve is answered as unknown, so the route is composed rather than stubbed.
    assert.deepEqual(await call({ operation: "list", workspaceId: "elsewhere" }), { ok: false, code: "unknown_workspace" });
    const branch = "client-worktree-check";
    const created = await call({ operation: "create", workspaceId: "local", branch });
    assert.equal(created.ok, true);
    const path = (created.value as { path: string }).path;
    // The host's own model, asked directly, is the evidence that the checkout is really there and on that branch.
    assert.equal(host.exists(path), true);
    assert.equal(host.branchOf(path), branch);
    const removed = await call({ operation: "remove", workspaceId: "local", path });
    assert.deepEqual(removed, { ok: true, value: { removed: path } });
    assert.equal(host.exists(path), false);
    assert.deepEqual(host.worktreesOf(host.root), [{ path: host.root, branch: "main" }]);
  } finally {
    await running.close();
    assert.equal(await gateway, 0);
    await rm(state, { recursive: true, force: true });
  }
});
