import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { resourceSnapshot, type ResourceSnapshot, type SshRunner, type SshRunnerRequest } from "../src/index.ts";
import { createWorkspaceResources } from "../../../apps/server/src/workspace-resources.ts";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import { pythonSshRunner, recordFrames } from "./ssh-transport.ts";
import { createFakeSshHost } from "./fake-ssh.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../src/workspaces.ts";

/**
 * One discovery is one helper run over SSH. The whole resource scope set — the account, its home, every root, the
 * context and prompt files, and the text of every ignore file and candidate resource — comes back from a single run of
 * the remote helper, instead of the host being resolved again and every file read again for each one.
 */

/**
 * A runner that counts the helper runs it performs, so a test asserts on the transport and not on a log line. A
 * one-shot request is one run and a session's request frame is one run, so the count means the same on both transports.
 */
function counting(inner: SshRunner): { runner: SshRunner; runs: SshRunnerRequest[] } {
  const runs: SshRunnerRequest[] = [];
  const runner: SshRunner = { execute: async (request) => { runs.push(request); return await inner.execute(request); } };
  const open = inner.open;
  if (open !== undefined) {
    runner.open = (request) => {
      const child = open(request);
      recordFrames(child, [], (frame) => { runs.push({ ...request, command: [...request.command, frame.mode, ...frame.args], signal: AbortSignal.timeout(0) }); });
      return child;
    };
  }
  return { runs, runner };
}

/** A remote account home and workspace with one skill each, and a system prompt and a prompt template. */
async function remoteHost(base: string): Promise<{ home: string; root: string }> {
  const home = join(base, "home");
  const root = join(base, "workspace");
  await mkdir(join(home, ".agents", "skills", "global-notes"), { recursive: true });
  await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
  await mkdir(join(root, ".agents", "skills", "deploy"), { recursive: true });
  await writeFile(join(home, ".agents", "skills", "global-notes", "SKILL.md"), "---\nname: global-notes\ndescription: Take global notes\n---\nGlobal notes body.\n");
  await writeFile(join(root, ".agents", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app\n---\nDeploy steps body.\n");
  await writeFile(join(home, ".pi", "agent", "SYSTEM.md"), "REMOTE SYSTEM PROMPT");
  await writeFile(join(home, ".pi", "agent", "prompts", "summarize.md"), "---\ndescription: Summarize\n---\nSummarize $1.\n");
  return { home, root };
}

test("one discovery over the SSH transport runs the remote helper once", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-ssh-snapshot-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const { home, root } = await remoteHost(base);
  const { runner, runs } = counting(pythonSshRunner({ user: "remote-operator", home }).runner);
  const files = new SshFilesystem({ id: "ssh-gateway", profiles: [{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }])), runner });
  t.after(async () => { await files.close(); });
  const result = await files.execute({ workspaceId: "remote-a", method: "resourceSnapshot" }) as { ok: true; value: { host: { user: string; home: string; roots: { path: string }[] }; directories: unknown[]; files: { path: string; text: string; read: string }[] } };
  assert.equal(runs.length, 1, "the whole scope set is one helper run, not " + runs.length);
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
  assert.equal(result.value.host.user, "remote-operator");
  assert.equal(result.value.host.home, home);
  assert.ok(result.value.host.roots.some((entry) => entry.path === join(root, ".agents", "skills")), "the workspace's own skills root is in the snapshot");
  assert.ok(result.value.host.roots.some((entry) => entry.path === join(home, ".agents", "skills")), "the account's skills root is in the snapshot");
  const skill = result.value.files.find((file) => file.path === join(root, ".agents", "skills", "deploy", "SKILL.md"));
  assert.ok(skill !== undefined, "the skill file is in the snapshot");
  assert.equal(skill.read, "frontmatter");
  assert.match(skill.text, /description: Deploy the app/);
  assert.doesNotMatch(skill.text, /Deploy steps body/, "a skill body is not carried by the snapshot");
  const prompt = result.value.files.find((file) => file.path === join(home, ".pi", "agent", "prompts", "summarize.md"));
  assert.ok(prompt !== undefined && prompt.read === "whole", "a prompt template keeps its body");
  assert.match(prompt.text, /Summarize \$1\./);
  const system = result.value.files.find((file) => file.path === join(home, ".pi", "agent", "SYSTEM.md"));
  assert.ok(system !== undefined && system.read === "whole");
});

test("one discovery over a host reached through the default transport runs the remote helper once", async (t) => {
  // The default composition — `createSystemSshRunner` with no master — reaches a host the fake serves in this process:
  // the helper program, the framed session and the host's own account are the fake's, while the gateway's resolution,
  // framing and session reuse are the code under test. No daemon, port, key or login takes part.
  const host = createFakeSshHost({ root: "/srv/app", user: "remote-operator", home: "/home/remote-operator" });
  host.mkdir("/srv/app/.agents/skills/deploy");
  host.writeFile("/srv/app/.agents/skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Reached over the transport\n---\nDeploy body.\n");
  host.writeFile("/home/remote-operator/.pi/agent/SYSTEM.md", "REMOTE SYSTEM PROMPT");
  const { runner, runs } = counting(host.runner);
  const files = new SshFilesystem({ id: "ssh-gateway", profiles: [{ id: "host-a", host: host.profile.host, remoteRoot: host.root, port: 2222, identityFile: "/keys/one", knownHostsFile: "/keys/known" }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "host-a", host: host.profile.host, remoteRoot: host.root, port: 2222, identityFile: "/keys/one", knownHostsFile: "/keys/known" }])), runner });
  t.after(async () => { await files.close(); });
  const result = await files.execute({ workspaceId: "remote-host-a", method: "resourceSnapshot" }) as { ok: true; value: { host: { user: string; home: string }; files: { path: string; read: string; text: string }[] } };
  assert.equal(runs.length, 1, "one helper run over the transport, not " + runs.length);
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
  assert.equal(result.value.host.user, "remote-operator");
  assert.equal(result.value.host.home, "/home/remote-operator");
  const skill = result.value.files.find((file) => file.path === join(host.root, ".agents", "skills", "deploy", "SKILL.md"));
  assert.ok(skill !== undefined, "the skill file is in the snapshot");
  assert.equal(skill.read, "frontmatter");
  assert.match(skill.text, /description: Reached over the transport/);
  assert.doesNotMatch(skill.text, /Deploy body/, "a skill body is not carried by the snapshot");
  const system = result.value.files.find((file) => file.path === join("/home/remote-operator", ".pi", "agent", "SYSTEM.md"));
  assert.ok(system !== undefined && system.read === "whole", "a system prompt keeps its body");
});

test("the local and SSH producers prune the same ignored and supporting content", async (t) => {
  // Pruning is the part of the walk the two producers each implement, so it is where they can drift. Both are given
  // the same tree: an ignored subtree, a declared skill with supporting documents beside it, and a loose markdown
  // file that is a skill. The snapshot must carry exactly the same paths and the same text on either host.
  const base = await mkdtemp(join(tmpdir(), "hepi-snapshot-prune-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const { home, root } = await remoteHost(base);
  const skills = join(root, ".agents", "skills");
  await writeFile(join(skills, ".gitignore"), "ignored/\nnotes.md\n");
  await mkdir(join(skills, "ignored", "deep"), { recursive: true });
  await writeFile(join(skills, "ignored", "SKILL.md"), "---\nname: ignored\ndescription: Ignored\n---\nBody.\n");
  await writeFile(join(skills, "ignored", "deep", "SKILL.md"), "---\nname: deeper\ndescription: Deeper\n---\nBody.\n");
  await writeFile(join(skills, "notes.md"), "---\nname: notes\ndescription: Notes\n---\nBody.\n");
  await mkdir(join(skills, "deploy", "assets"), { recursive: true });
  await writeFile(join(skills, "deploy", "reference.md"), "# Reference\n");
  await writeFile(join(skills, "deploy", "assets", "deep.md"), "# Deep\n");
  await writeFile(join(skills, "loose.md"), "---\nname: loose\ndescription: Loose\n---\nLoose body.\n");
  const identity = { user: "remote-operator", home };
  const local = await resourceSnapshot(root, identity);
  const { runner } = pythonSshRunner(identity);
  const files = new SshFilesystem({ id: "ssh-gateway", profiles: [{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }])), runner });
  t.after(async () => { await files.close(); });
  const remote = await files.execute({ workspaceId: "remote-a", method: "resourceSnapshot" }) as { ok: true; value: typeof local };
  assert.equal(remote.ok, true, JSON.stringify(remote).slice(0, 300));
  const paths = (snapshot: typeof local) => ({ files: snapshot.files.map((file) => file.path).sort(), directories: snapshot.directories.map((entry) => entry.path).sort() });
  assert.deepEqual(paths(remote.value), paths(local), "both producers read and prune the same paths");
  assert.deepEqual(remote.value.files, local.files, "and carry the same text for them");
  const held = local.files.map((file) => file.path);
  assert.ok(!held.some((path) => path.includes("/ignored/")), "an ignored subtree is pruned: " + held.join(", "));
  assert.ok(!held.includes(join(skills, "notes.md")), "an ignored file is pruned: " + held.join(", "));
  assert.ok(!held.some((path) => path.endsWith("reference.md")), "a supporting document is pruned: " + held.join(", "));
  assert.ok(!held.some((path) => path.includes("/assets/")), "nothing below a declared skill is read: " + held.join(", "));
  assert.ok(held.includes(join(skills, "deploy", "SKILL.md")), "the declaration is kept");
  assert.ok(held.includes(join(skills, "loose.md")), "a loose markdown file is a skill");
});

test("the SSH helper answers the loader's own walk without a second run", async (t) => {
  // The remote producer is the one that cannot be inspected from here, so it is exercised over the real transport:
  // the helper prunes, and the loader over its snapshot adopts exactly what a local discovery adopts for the same tree.
  const base = await mkdtemp(join(tmpdir(), "hepi-ssh-loader-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const { home, root } = await remoteHost(base);
  const skills = join(root, ".agents", "skills");
  await writeFile(join(skills, ".gitignore"), "ignored/\n");
  await mkdir(join(skills, "ignored"), { recursive: true });
  await writeFile(join(skills, "ignored", "SKILL.md"), "---\nname: ignored\ndescription: Ignored\n---\nBody.\n");
  await writeFile(join(skills, "deploy", "reference.md"), "# Reference\n");
  const identity = { user: "remote-operator", home };
  const { runner, runs } = counting(pythonSshRunner(identity).runner);
  const files = new SshFilesystem({ id: "ssh-gateway", profiles: [{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }])), runner });
  t.after(async () => { await files.close(); });
  const snapshot = await files.execute({ workspaceId: "remote-a", method: "resourceSnapshot" }) as { ok: true; value: ResourceSnapshot };
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot).slice(0, 300));
  assert.equal(runs.length, 1, "one helper run carries the whole scope set, not " + runs.length);
  const held = snapshot.value.files.map((file) => file.path);
  assert.ok(!held.some((path) => path.includes("/ignored/")), "the helper prunes an ignored subtree: " + held.join(", "));
  assert.ok(!held.some((path) => path.endsWith("reference.md")), "the helper prunes a supporting document: " + held.join(", "));
  const environment = { executionHost: async () => ({ ok: true as const, value: snapshot.value.host }), resourceSnapshot: async () => ({ ok: true as const, value: snapshot.value }) };
  const resources = createWorkspaceResources({ projectTrusted: true });
  const state = await resources.discover(environment as never, BACKGROUND_CONTEXT);
  assert.equal(state.status, "loaded", JSON.stringify(state).slice(0, 300));
  if (state.status !== "loaded") return;
  assert.deepEqual(state.catalog.filter((entry) => entry.kind === "skill").map((entry) => entry.name).sort(), ["deploy", "global-notes"]);
});

test("a negation, a directory rule and a nested globstar prune alike on both producers, and an ignored skill is never read", async (t) => {
  // The three rule shapes the fallback used to mishandle: a negation that re-includes a path, a directory-only rule,
  // and a `**` in the middle of a pattern. Each must be decided the same way on both producers — one grammar, read by
  // `node-ignore` locally and by the helper's port of it — and an ignored subtree must be pruned before it is read, so
  // an ignored skill's declaration neither crosses the wire nor is counted against the bounds.
  const base = await mkdtemp(join(tmpdir(), "hepi-snapshot-rules-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const { home, root } = await remoteHost(base);
  const skills = join(root, ".agents", "skills");
  // `ignored/*` and not `ignored/`: gitignore cannot re-include a path under an excluded parent, so the parent has
  // to stay matchable for the negation below it to mean anything. This is the shape a negation is written in.
  await writeFile(join(skills, ".gitignore"), "ignored/*\n!ignored/kept/\n**/generated/**\n");
  // Ignored by `ignored/*`, re-included by the negation: the one skill under an ignored directory that is a resource.
  await mkdir(join(skills, "ignored", "kept"), { recursive: true });
  await writeFile(join(skills, "ignored", "kept", "SKILL.md"), "---\nname: kept\ndescription: Kept\n---\nBody.\n");
  // Ignored, and unreadable: a producer that read it before deciding would report a permission failure, and one that
  // transmitted it would carry the declaration. Neither happens: the directory is pruned and never opened.
  await mkdir(join(skills, "ignored", "secret"), { recursive: true });
  await writeFile(join(skills, "ignored", "secret", "SKILL.md"), "---\nname: secret\ndescription: Secret\n---\nBody.\n");
  await chmod(join(skills, "ignored", "secret"), 0o000);
  // Matched by `**/generated/**` at any depth: a mid-pattern globstar, not a literal prefix.
  await mkdir(join(skills, "nested", "generated"), { recursive: true });
  await writeFile(join(skills, "nested", "generated", "SKILL.md"), "---\nname: generated\ndescription: Generated\n---\nBody.\n");
  try {
    const identity = { user: "remote-operator", home };
    const local = await resourceSnapshot(root, identity);
    const { runner, runs } = counting(pythonSshRunner(identity).runner);
    const files = new SshFilesystem({ id: "ssh-gateway", profiles: [{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }])), runner });
    t.after(async () => { await files.close(); });
    const remote = await files.execute({ workspaceId: "remote-a", method: "resourceSnapshot" }) as { ok: true; value: typeof local };
    assert.equal(remote.ok, true, JSON.stringify(remote).slice(0, 300));
    assert.equal(runs.length, 1, "one helper run, not " + runs.length);
    assert.deepEqual(remote.value.files, local.files, "both producers answer the same");
    const carried = local.files.map((file) => file.path);
    assert.ok(!carried.some((path) => path.includes("/secret/")), "an ignored subtree is never read or transmitted: " + carried.join(", "));
    assert.ok(!carried.some((path) => path.includes("/generated/")), "a nested globstar prunes at any depth: " + carried.join(", "));
    assert.ok(carried.includes(join(skills, "ignored", "kept", "SKILL.md")), "a negation re-includes what a directory rule excluded: " + carried.join(", "));
    const environment = { executionHost: async () => ({ ok: true as const, value: local.host }), resourceSnapshot: async () => ({ ok: true as const, value: local }) };
    const resources = createWorkspaceResources({ projectTrusted: true });
    const state = await resources.discover(environment as never, BACKGROUND_CONTEXT);
    assert.equal(state.status, "loaded", JSON.stringify(state).slice(0, 300));
    if (state.status !== "loaded") return;
    // The catalog is the loader's own decision over the pruned snapshot, and it is the same catalog either host gave.
    assert.deepEqual(state.catalog.filter((entry) => entry.kind === "skill").map((entry) => entry.name).sort(), ["deploy", "global-notes", "kept"]);
  } finally {
    await chmod(join(skills, "ignored", "secret"), 0o755);
  }
});

test("a declared skill is terminal, so its supporting documents stay out of the snapshot", async (t) => {
  // A directory declaring SKILL.md is that one skill, so its supporting documents and everything below it stay out of
  // the snapshot on either host.
  const base = await mkdtemp(join(tmpdir(), "hepi-snapshot-terminal-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const { home, root } = await remoteHost(base);
  const skills = join(root, ".agents", "skills");
  await writeFile(join(skills, ".gitignore"), "!kept/\n");
  await mkdir(join(skills, "kept"), { recursive: true });
  await writeFile(join(skills, "kept", "SKILL.md"), "---\nname: kept\ndescription: Kept\n---\nBody.\n");
  await writeFile(join(skills, "kept", "README.md"), "---\nname: readme\ndescription: Supporting\n---\nNot a resource.\n");
  await mkdir(join(skills, "kept", "extra"), { recursive: true });
  await writeFile(join(skills, "kept", "extra", "SKILL.md"), "---\nname: nested\ndescription: Nested\n---\nBody.\n");
  const identity = { user: "remote-operator", home };
  const local = await resourceSnapshot(root, identity);
  const { runner } = pythonSshRunner(identity);
  const files = new SshFilesystem({ id: "ssh-gateway", profiles: [{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }])), runner });
  t.after(async () => { await files.close(); });
  const remote = await files.execute({ workspaceId: "remote-a", method: "resourceSnapshot" }) as { ok: true; value: typeof local };
  assert.equal(remote.ok, true, JSON.stringify(remote).slice(0, 300));
  assert.deepEqual(remote.value.files, local.files, "both producers answer the same");
  const carried = local.files.map((file) => file.path).filter((path) => path.startsWith(join(skills, "kept")));
  assert.deepEqual(carried, [join(skills, "kept", "SKILL.md")], "only the declaration crosses the wire: " + carried.join(", "));
});

test("an ignored subtree is never read, so an unreadable ignored skill and a huge one cost nothing", async (t) => {
  // The shape the review used to break the fallback: an ordinary `ignored/` with a `!keep.md` negation, an ignored
  // skill that cannot be opened at all, and 70 ignored files of 250 KB. A producer that pruned only the rules it could
  // read attempted the unreadable read, carried the declaration, and pushed the payload past the bound — a valid
  // catalog reported as a failed snapshot. Pruning before the read is what makes all three of those not happen.
  const base = await mkdtemp(join(tmpdir(), "hepi-snapshot-ignored-read-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const { home, root } = await remoteHost(base);
  const skills = join(root, ".agents", "skills");
  await writeFile(join(skills, ".gitignore"), "ignored/\nlocked/\n!keep.md\n");
  // 70 ignored files of 250 KB: 17.5 MB, over the whole snapshot bound if it were counted.
  await mkdir(join(skills, "ignored"), { recursive: true });
  const bulk = "---\nname: bulk\ndescription: " + "d".repeat(64) + "\n---\n" + "x".repeat(250 * 1024);
  for (let index = 0; index < 70; index += 1) await writeFile(join(skills, "ignored", "bulk" + index + ".md"), bulk);
  // An ignored skill that cannot be opened at all.
  await mkdir(join(skills, "locked"), { recursive: true });
  await writeFile(join(skills, "locked", "SKILL.md"), "---\nname: locked\ndescription: Locked\n---\nBody.\n");
  await chmod(join(skills, "locked"), 0o000);
  try {
    const identity = { user: "remote-operator", home };
    const local = await resourceSnapshot(root, identity);
    const { runner, runs } = counting(pythonSshRunner(identity).runner);
    const files = new SshFilesystem({ id: "ssh-gateway", profiles: [{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }])), runner });
    t.after(async () => { await files.close(); });
    const remote = await files.execute({ workspaceId: "remote-a", method: "resourceSnapshot" }) as { ok: true; value: typeof local };
    assert.equal(runs.length, 1, "one helper run, not " + runs.length);
    assert.equal(remote.ok, true, "an ignored subtree never fails the snapshot: " + JSON.stringify(remote).slice(0, 300));
    assert.deepEqual(remote.value.files, local.files, "both producers answer the same");
    const carried = local.files.map((file) => file.path);
    assert.ok(!carried.some((path) => path.includes("/ignored/")), "nothing under the ignored directory is read or transmitted: " + carried.join(", "));
    assert.ok(!carried.some((path) => path.includes("/locked/")), "an unreadable ignored skill is not attempted, so it is not a failure either: " + carried.join(", "));
    // The snapshot is the whole serialized response, and it is small because the ignored bulk never entered it.
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, value: local }), "utf8") < 64 * 1024, "an ignored subtree is not counted against the bounds");
    const environment = { executionHost: async () => ({ ok: true as const, value: local.host }), resourceSnapshot: async () => ({ ok: true as const, value: local }) };
    const resources = createWorkspaceResources({ projectTrusted: true });
    const state = await resources.discover(environment as never, BACKGROUND_CONTEXT);
    assert.equal(state.status, "loaded", JSON.stringify(state).slice(0, 300));
    if (state.status !== "loaded") return;
    assert.deepEqual(state.catalog.filter((entry) => entry.kind === "skill").map((entry) => entry.name).sort(), ["deploy", "global-notes"]);
  } finally {
    await chmod(join(skills, "locked"), 0o755);
  }
});

test("both producers carry an unreadable directory and an oversized skill as the same facts", async (t) => {
  // A failure to read is a fact about one path, not a failed snapshot, and it must be the same fact on either host:
  // a directory the walk cannot list and a skill over the per-file limit are carried as their error codes, so the
  // loader raises exactly where a per-file walk would have. A producer that dropped either would answer "not there".
  const base = await mkdtemp(join(tmpdir(), "hepi-snapshot-failure-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const { home, root } = await remoteHost(base);
  const skills = join(root, ".agents", "skills");
  await mkdir(join(skills, "locked"), { recursive: true });
  await writeFile(join(skills, "locked", "SKILL.md"), "---\nname: locked\ndescription: Locked\n---\nBody.\n");
  await writeFile(join(skills, "huge.md"), "---\nname: huge\ndescription: Huge\n---\n" + "x".repeat(17 * 1024 * 1024));
  await chmod(join(skills, "locked"), 0o000);
  try {
    const identity = { user: "remote-operator", home };
    const local = await resourceSnapshot(root, identity);
    const { runner } = pythonSshRunner(identity);
    const files = new SshFilesystem({ id: "ssh-gateway", profiles: [{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }])), runner });
    t.after(async () => { await files.close(); });
    const remote = await files.execute({ workspaceId: "remote-a", method: "resourceSnapshot" }) as { ok: true; value: typeof local };
    assert.equal(remote.ok, true, JSON.stringify(remote).slice(0, 300));
    const facts = (snapshot: typeof local) => ({
      unreadable: snapshot.directories.filter((entry) => !("entries" in entry)).map((entry) => entry.path + ":" + ("failure" in entry ? entry.failure.code : "")),
      failed: snapshot.files.filter((file) => !("text" in file)).map((file) => file.path + ":" + ("failure" in file ? file.failure.code : "")),
    });
    assert.deepEqual(facts(remote.value), facts(local), "both hosts report the same unreadable paths");
    assert.deepEqual(facts(local).unreadable, [join(skills, "locked") + ":permission_denied"], "an unlistable directory is a fact, not an absent one");
    assert.deepEqual(facts(local).failed, [join(skills, "huge.md") + ":invalid"], "an oversized skill is a fact, not a truncated declaration");
  } finally { await chmod(join(skills, "locked"), 0o755); }
});

test("the local and SSH producers return the same snapshot for the same host", async (t) => {
  // The two producers are the only duplicated part of this design: the local gateway lists and reads in process, the
  // SSH helper does it in Python on the host. Every decision belongs to the loader, so for one tree the two must agree
  // on the roots, the directories, the entries and the text of every file — otherwise a conversation's catalog would
  // depend on which host it happened to run on.
  const base = await mkdtemp(join(tmpdir(), "hepi-snapshot-parity-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const { home, root } = await remoteHost(base);
  await writeFile(join(root, ".agents", "skills", ".gitignore"), "ignored/\n");
  await mkdir(join(root, ".agents", "skills", "ignored"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "ignored", "SKILL.md"), "---\nname: ignored\ndescription: Ignored\n---\nBody.\n");
  await mkdir(join(root, ".agents", "skills", "nested"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "nested", "SKILL.md"), "---\nname: nested\ndescription: Nested\n---\nNested body.\n");
  await symlink(join(root, ".agents", "skills", "nested"), join(root, ".agents", "skills", "alias"));
  const identity = { user: "remote-operator", home };
  const local = await resourceSnapshot(root, identity);
  const { runner } = pythonSshRunner(identity);
  const files = new SshFilesystem({ id: "ssh-gateway", profiles: [{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }])), runner });
  t.after(async () => { await files.close(); });
  const remote = await files.execute({ workspaceId: "remote-a", method: "resourceSnapshot" }) as { ok: true; value: typeof local };
  assert.equal(remote.ok, true, JSON.stringify(remote).slice(0, 300));
  assert.deepEqual(remote.value.host, local.host, "the same host metadata");
  // mtimeMs is the one field left out: Node and Python round the same nanosecond timestamp differently in the last
  // bits of the double, so it is not comparable across the two runtimes, and no loader decision reads it. Every field
  // that does decide something — the logical path, the canonical target, both kinds, the size and the text — is exact.
  const withoutClock = (snapshot: typeof local) => ({
    directories: snapshot.directories.map((directory) =>
      "entries" in directory
        ? { path: directory.path, real: directory.real, entries: directory.entries.map((entry) => ({ info: { ...entry.info, mtimeMs: 0 }, real: entry.real, realKind: entry.realKind })) }
        : { path: directory.path, real: directory.real, unreadable: directory.failure.code }),
    files: snapshot.files,
  });
  assert.deepEqual(withoutClock(remote.value), withoutClock(local), "the same directories, entries, file paths and text");
});
