
/**
 * The review's own reproduction, re-run at the fixed revision: an ordinary `ignored/` with a `!keep.md` negation, an
 * ignored skill that cannot be opened, an ignored subtree of 250 KB files, and a nested-globstar pattern. Each row
 * is one label, one producer, and what it answered — a catalog, an upload list, or an error.
 *
 * Run: node .scratch/submit-stall/ignore-review-repro.mjs
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resourceSnapshot } from "../../packages/gateway/src/filesystem.ts";
import { SshFilesystem } from "../../packages/gateway/src/ssh-filesystem.ts";
import { pythonSshRunner } from "../../packages/gateway/test/ssh-transport.ts";
import { createWorkspaceResources } from "../../apps/server/src/workspace-resources.ts";

const CONTEXT = { sessionId: "s", workspaceId: "w", cwd: "" };

async function host(base, name) {
  const home = join(base, name, "home");
  const root = join(base, name, "repo");
  await mkdir(join(home, ".agents", "skills", "top"), { recursive: true });
  await writeFile(join(home, ".agents", "skills", "top", "SKILL.md"), "---\nname: top\ndescription: Top\n---\nBody.\n");
  await mkdir(join(root, ".agents", "skills", "good"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "good", "SKILL.md"), "---\nname: good\ndescription: Good\n---\nBody.\n");
  return { home, root };
}

async function ask(snapshot, root) {
  const environment = { executionHost: async () => ({ ok: true, value: snapshot.host }), resourceSnapshot: async () => ({ ok: true, value: snapshot }) };
  const resources = createWorkspaceResources({ projectTrusted: true });
  try {
    const state = await resources.discover(environment, { ...CONTEXT, cwd: root });
    return { catalog: state.status === "loaded" ? state.catalog.filter((entry) => entry.kind === "skill").map((entry) => entry.name).sort() : state.status };
  } catch (error) {
    return { error: error.code + ": " + error.message };
  }
}

async function report(label, root, identity) {
  for (const [producer, read] of [["local", async () => resourceSnapshot(root, identity)], ["ssh", async () => {
    const { runner } = pythonSshRunner(identity);
    const files = new SshFilesystem({ id: "ssh-gateway", profiles: [{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(root, "..", "id"), knownHostsFile: join(root, "..", "known_hosts") }], runner });
    try {
      return await files.execute({ workspaceId: "remote-a", method: "resourceSnapshot" });
    } finally {
      await files.close();
    }
  }]]) {
    let row;
    try {
      const answer = await read();
      if (answer.ok === false) { row = { error: answer.error }; }
      else {
        const snapshot = answer.value ?? answer;
        row = { catalog: (await ask(snapshot, root)).catalog, uploaded: snapshot.files.filter((file) => file.path.includes("/skills/") && !file.path.endsWith(".gitignore")).map((file) => file.path.replace(root, "")) };
      }
    } catch (error) {
      row = { error: error.code + ": " + error.message };
    }
    console.log(JSON.stringify({ label, producer, ...row }));
  }
}

const base = await mkdtemp(join(tmpdir(), "hepi-ignore-review-"));
try {
  // The review's first shape: an ignored directory, a negation, and an ignored skill that cannot be opened.
  const first = await host(base, "first");
  const skills = join(first.root, ".agents", "skills");
  await writeFile(join(skills, ".gitignore"), "ignored/\n!keep.md\n");
  await mkdir(join(skills, "ignored"), { recursive: true });
  await writeFile(join(skills, "ignored", "SKILL.md"), "---\nname: ignored\ndescription: ignored\n---\n");
  await chmod(join(skills, "ignored"), 0o000);
  await report("negation-with-unreadable-ignored-skill", first.root, { user: "operator", home: first.home });
  await chmod(join(skills, "ignored"), 0o755);

  // The review's second shape: a mid-pattern globstar, which the old reading took for a literal prefix.
  const second = await host(base, "second");
  const secondSkills = join(second.root, ".agents", "skills");
  await writeFile(join(secondSkills, ".gitignore"), "**/generated/**\n");
  await mkdir(join(secondSkills, "nested", "generated"), { recursive: true });
  await writeFile(join(secondSkills, "nested", "generated", "SKILL.md"), "---\nname: generated\ndescription: generated\n---\n");
  await report("nested-globstar", second.root, { user: "operator", home: second.home });

  // The review's third shape: 70 ignored files of 250 KB, which used to overflow the payload bound.
  const third = await host(base, "third");
  const thirdSkills = join(third.root, ".agents", "skills");
  await writeFile(join(thirdSkills, ".gitignore"), "ignored/\n!keep.md\n");
  await mkdir(join(thirdSkills, "ignored"), { recursive: true });
  const bulk = "---\nname: bulk\ndescription: " + "d".repeat(64) + "\n---\n" + "x".repeat(250 * 1024);
  for (let index = 0; index < 70; index += 1) await writeFile(join(thirdSkills, "ignored", "bulk" + index + ".md"), bulk);
  await report("negation-with-70-ignored-250kb-files", third.root, { user: "operator", home: third.home });
} finally {
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
}
