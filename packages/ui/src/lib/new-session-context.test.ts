import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { contextForCwd, currentWorktreeOf, describeProjectChoices, newSessionContextKey, projectChoices } =
  await createJiti(import.meta.url).import<typeof import("./new-session-context.ts")>("./new-session-context.ts");

const main = { path: "/work/app", branch: "main", isMain: true };
const context = {
  cwd: main.path,
  project: { key: "app-key", root: main.path, displayRoot: main.path },
  worktrees: [main], currentWorktreePath: main.path,
  projects: [{ key: "app-key", root: main.path, displayRoot: main.path }],
};

test("composer adopts a newly created worktree immediately and excludes retained project choices", () => {
  const created = { cwd: "/work/app-worktrees/fix", project: context.project, branch: "fix/login" };
  const moved = contextForCwd(context, created.cwd, created);
  assert.deepEqual(moved, {
    ...context, cwd: created.cwd, currentWorktreePath: created.cwd,
    worktrees: [main, { path: created.cwd, branch: "fix/login", isMain: false }],
  });
  assert.equal(currentWorktreeOf(moved)?.path, created.cwd);
  assert.notEqual(newSessionContextKey(moved), newSessionContextKey(context));
  assert.equal(contextForCwd(context, main.path), context);
  const kept = { key: "kept", root: "/workspace/kept", retained: true };
  assert.deepEqual(projectChoices({ ...context, project: kept, projects: [kept, ...context.projects] }), context.projects);
  assert.deepEqual(describeProjectChoices([
    { key: "1", root: "/workspace/a", displayRoot: "/work/client/app" },
    { key: "2", root: "/workspace/b", displayRoot: "/work/server/app" },
  ]).map(({ name, note }) => [name, note]), [["app", "client"], ["app", "server"]]);
});
