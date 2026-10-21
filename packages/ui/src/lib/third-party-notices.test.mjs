/**
 * The notice the workbench's artifacts have to carry, and the copy that puts it there.
 *
 * `@hepi/ui` bundles a third-party reader into a shipped chunk (`src/lib/docx-preview.ts` imports `mammoth`, a
 * production dependency), and esbuild keeps only `@license`/`@preserve` comments — `mammoth`'s browser build has
 * neither — so the bundle states no copyright of its own. What carries it is `THIRD_PARTY_NOTICES.md` at this package's
 * root, which each host's build copies into the directory it distributes.
 *
 * Two things are asserted here and nothing is retyped: the notice's content against the **installed** package's own
 * manifest and `LICENSE` (a pin bump that changes the licence, the holder or the version fails here instead of shipping
 * an artifact whose notice says something else), and the copy itself against a real output directory, because a build
 * that reports success while leaving the notice out is the failure mode this exists to prevent.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { THIRD_PARTY_NOTICES, copyThirdPartyNotices } = await jiti.import("@hepi/ui/lib/third-party-notices");

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "..", "..");
const require = createRequire(import.meta.url);
const notice = await readFile(THIRD_PARTY_NOTICES, "utf8");
const installed = require("mammoth/package.json");
const upstreamLicense = await readFile(require.resolve("mammoth/LICENSE"), "utf8");

test("the notice names the reader this package bundles, in the version installed", () => {
  assert.equal(installed.license, "BSD-2-Clause", "the installed package states a different licence");
  assert.match(notice, /mammoth/, "the notice does not name the bundled reader");
  assert.match(notice, /BSD-2-Clause/, "the notice does not name the licence the package declares");
  // The version the notice states is the version actually installed: read from the package, not retyped here.
  assert.ok(notice.includes(installed.version), "the notice is stale against " + installed.version);
});

test("the notice carries the copyright line the upstream licence itself states", () => {
  const copyright = upstreamLicense.split(/\r?\n/).find((line) => line.startsWith("Copyright (c)"));
  assert.ok(copyright, "the installed licence states no copyright line");
  assert.ok(notice.includes(copyright), "the notice dropped " + copyright);
});

test("the notice has one owner: no host keeps a second copy that can drift", () => {
  // Each host copies this file at build time. A leftover file in a host's public directory would be served instead of
  // the owner's, and the two would disagree silently.
  for (const copy of ["apps/web/public/THIRD_PARTY_NOTICES.md", "apps/app/public/THIRD_PARTY_NOTICES.md"]) {
    assert.equal(existsSync(join(repoRoot, copy)), false, copy + " duplicates the notice this package owns");
  }
});

test("the preview reads the document as text and never asks the host to convert it", async () => {
  // The invariants the licence record stands on: the reader is this package's, and no host-side conversion exists to
  // licence — so there is nothing else here whose notice could be stale.
  assert.match(notice, /docx-preview\.ts/, "the notice does not say what uses the reader");
  const source = await readFile(join(repoRoot, "packages/ui/src/lib/docx-preview.ts"), "utf8");
  assert.match(source, /await import\("mammoth"\)/, "the preview no longer imports the recorded reader");
  assert.match(source, /extractRawText\(/, "the preview no longer extracts text from the document");
  assert.doesNotMatch(source, /convertToHtml\(/, "the preview would place the document's own markup on the page");
});

test("the copy places the notice inside the directory a build distributes", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "hepi-notice-copy-"));
  const copied = await copyThirdPartyNotices(outDir);
  assert.equal(copied.path, join(outDir, "THIRD_PARTY_NOTICES.md"));
  assert.equal(copied.bytes, Buffer.byteLength(notice), "the copy was truncated or substituted");
  assert.equal(await readFile(copied.path, "utf8"), notice, "the artifact carries text the owner does not");
});

test("a build that cannot place the notice fails instead of shipping without it", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "hepi-notice-copy-"));
  const missing = join(outDir, "absent.md");
  assert.equal(existsSync(missing), false, "the fixture left a notice behind");
  await assert.rejects(() => copyThirdPartyNotices(outDir, missing), /ENOENT|no such file/);
});

test("both hosts' builds carry the notice into the directory they distribute", async () => {
  // The plugin is what makes the copy part of the artifact; a config that dropped it would build a page with no notice.
  for (const config of ["apps/web/vite.config.ts", "apps/app/vite.config.ts"]) {
    const source = await readFile(join(repoRoot, config), "utf8");
    assert.match(source, /thirdPartyNoticesPlugin\(\)/, config + " builds without placing the notice in its output");
  }
});
