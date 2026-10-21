import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// registry.ts imports its message modules without an extension, which Node's type stripping cannot resolve.
const { getLocalePlugin, getSupportedLocales } = await createJiti(import.meta.url).import<typeof import("../registry.ts")>("../registry.ts");

/**
 * The language packages answer every key a component asks for, in every locale.
 *
 * A translation lookup that misses returns the key itself, so an unregistered message is not an error a developer
 * sees: a reader sees `files.docxPreviewOversize` where a sentence belongs, and the difference between a missing
 * key and an untranslated one is invisible from the page. The components are the only authority on which keys are
 * used, so the set is read from the source rather than kept as a list someone has to remember to update. Two of
 * ticket 05's new docx keys are built with a placeholder, which is why the required-placeholder set is compared
 * too: `{max}` surviving into a translation is what makes a bound a sentence rather than a surprise.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const uiRoot = join(here, "..", "..", "..", "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

/** Every source file below `directory`, skipping dependencies and the tests themselves. */
const sourceFiles = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !/\.test\.(mjs|ts)$/.test(path)) found.push(path);
  }
  return found;
};

/** Every key a `t("...")` call names, with the file that named it. */
const usedKeys = (): Map<string, string> => {
  const keys = new Map<string, string>();
  for (const file of sourceFiles(join(uiRoot, "src"))) {
    const body = readFileSync(file, "utf8");
    for (const match of body.matchAll(/\bt\(\s*(["'])([^"'\n]+?)\1\s*([),])/g)) {
      if (!keys.has(match[2])) keys.set(match[2], relative(uiRoot, file));
    }
  }
  return keys;
};

const placeholdersOf = (message: string): string[] => [...message.matchAll(/\{([\w.-]+)\}/g)].map((match) => match[1]).sort();

/** The language package one locale id registers, asserted present so its messages are readable. */
function localeOf(id: string): import("../types.ts").LocalePlugin {
  const plugin = getLocalePlugin(id);
  assert.ok(plugin !== undefined, "a supported locale " + id + " registers a package");
  return plugin;
}

/** One message a language package states, asserted present so its text is readable. */
function messageOf(messages: Record<string, string>, key: string, id: string): string {
  const message = messages[key];
  assert.ok(message !== undefined, id + " says nothing for " + key);
  return message;
}

test("each locale registers every key the components translate", () => {
  const keys = usedKeys();
  assert.ok(keys.size > 400, "the scan found " + keys.size + " keys, which is not the whole component tree");
  for (const id of getSupportedLocales()) {
    const messages = localeOf(id).messages;
    const missing = [...keys.keys()].filter((key) => !(key in messages));
    assert.deepEqual(missing, [], id + " has no entry for: " + missing.map((key) => key + " (" + keys.get(key) + ")").join(", "));
  }
});

test("every locale carries English's keys and its required placeholders", () => {
  // The same allowance the vendored pi-web registry test records: a locale may fold an optional count into another
  // placeholder instead of carrying it (zh-CN reads \"already {count} files exist\" with no separate suffix).
  const OPTIONAL: Record<string, string[]> = { "files.conflictSummary": ["countSuffix"] };
  const english = localeOf("en").messages;
  const englishKeys = Object.keys(english).sort();
  for (const id of getSupportedLocales().filter((locale) => locale !== "en")) {
    const messages = localeOf(id).messages;
    assert.deepEqual(Object.keys(messages).sort(), englishKeys, id + " keys must match English");
    for (const key of englishKeys) {
      const optional = OPTIONAL[key] ?? [];
      const required = (message: string) => placeholdersOf(message).filter((name) => !optional.includes(name));
      assert.deepEqual(required(messageOf(messages, key, id)), required(messageOf(english, key, "en")), id + "." + key + " placeholders must match English");
    }
  }
});

test("the Word document preview states its own bound in every locale", () => {
  // Ticket 05's four keys, because their failure mode is invisible: an absent entry shows the key, and a lost
  // `{max}` shows a document whose limit nobody named.
  const keys = usedKeys();
  const docxKeys = [...keys.keys()].filter((key) => key.startsWith("files.docxPreview"));
  assert.deepEqual(docxKeys.sort(), ["files.docxPreviewBadge", "files.docxPreviewEmpty", "files.docxPreviewLimit", "files.docxPreviewOversize"], "unexpected docx keys: " + JSON.stringify(docxKeys));
  for (const id of getSupportedLocales()) {
    const messages = localeOf(id).messages;
    for (const key of docxKeys) assert.ok(messageOf(messages, key, id).length > 0, id + " says nothing for " + key);
    for (const key of ["files.docxPreviewLimit", "files.docxPreviewOversize"]) {
      assert.deepEqual(placeholdersOf(messageOf(messages, key, id)), ["max"], id + "." + key + " must name the bound it refuses at");
    }
  }
});
