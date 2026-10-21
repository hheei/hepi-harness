/**
 * Repository discovery shared by the check scripts: which Markdown files are in
 * scope for a link check, which fragments those links point at, which guides the
 * documentation index covers, and which script targets actually exist.
 *
 * The walk is explicit rather than a glob, because a glob silently misses nested
 * files (`lib/i18n/*.test.mjs`) and the omission is invisible in the result.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Directory names never worth walking: dependency trees, build output, generated
 * graphs, and the skill store.
 *
 * The pinned `.pi/skills` checkout is excluded by relative path below; `.pi/agents`
 * and other first-party project configuration remain in scope.
 */
export const SKIP_DIRS = new Set([
  ".git",
  ".agents",
  "node_modules",
  "vendor",
  ".next",
  "graphify-out",
  ".dev",
  "data",
]);

/** Every file below `root` whose name `accepts` says yes, sorted by relative path. */
export function walkFiles(root, accepts) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || relative(root, join(dir, entry.name)) === join(".pi", "skills")) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && accepts(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found
    .map((path) => relative(root, path))
    .sort();
}

/** Every `.md` file below `root`, recursively, in sorted order. */
export function markdownFiles(root) {
  return walkFiles(root, (name) => name.endsWith(".md"));
}

/** Every `*.test.mjs` below `root`, explicitly enumerated (a glob misses nesting). */
export function unitTestFiles(root) {
  return walkFiles(root, (name) => name.endsWith(".test.mjs")).map((path) => "./" + path);
}

/**
 * Remove fenced code blocks so a shell snippet is not read as a link, replacing each
 * with the same number of blank lines so reported line numbers stay the file's own.
 */
export function withoutCodeFences(text) {
  return text.replace(/```[\s\S]*?```/g, (block) => "\n".repeat(block.split("\n").length - 1));
}

/**
 * Every relative Markdown link target in `text`, with its 1-based line number.
 *
 * A link carries a path, a fragment, or both, and each part is kept: `guide.md#step`
 * must find the file *and* the heading inside it, while `#step` names a heading in
 * this same file. External schemes are not repository paths.
 */
export function relativeLinks(text) {
  const links = [];
  const stripped = withoutCodeFences(text);
  const pattern = /\]\s*\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(stripped)) !== null) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (/^(https?:|mailto:|tel:)/.test(raw)) continue;
    const hash = raw.indexOf("#");
    const target = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    const fragment = hash === -1 ? "" : raw.slice(hash + 1).trim();
    if (target === "" && fragment === "") continue;
    links.push({
      raw,
      target,
      fragment,
      line: stripped.slice(0, match.index).split("\n").length,
    });
  }
  return links;
}

/**
 * The anchor a Markdown heading produces, by the convention the repository actually
 * links with: lowercase, punctuation dropped, spaces to hyphens, inline formatting
 * and backticks removed, duplicate suffixes (`-1`, `-2`) preserved as written.
 */
export function headingAnchor(heading) {
  return heading
    .trim()
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ /g, "-");
}

/** Every anchor a document declares, from its ATX headings. */
export function anchorsOf(text) {
  const anchors = new Set();
  for (const line of withoutCodeFences(text).split("\n")) {
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (match) anchors.add(headingAnchor(match[2]));
  }
  return anchors;
}

/**
 * Broken relative links across `root`: `{file, line, target, resolved}` per miss, and
 * `{file, line, fragment, targetFile}` when the file resolves but its heading does not.
 *
 * A file that exists is not proof that the link works: `guide.md#step-4` that lands on a
 * file with no such heading is just as broken as a missing file, and only the fragment
 * check notices. Both are reported together so one run gives the whole picture.
 */
export function brokenLinks(root, files = markdownFiles(root)) {
  const broken = [];
  const source = new Map(files.map((file) => [file, readFileSync(join(root, file), "utf8")]));
  const anchors = new Map();
  const anchorsFor = (file) => {
    if (!anchors.has(file)) anchors.set(file, anchorsOf(source.get(file) ?? ""));
    return anchors.get(file);
  };
  for (const file of files) {
    for (const link of relativeLinks(source.get(file))) {
      const targetFile = link.target === ""
        ? file
        : relative(root, resolve(root, dirname(file), decodeURIComponent(link.target)));
      let exists = false;
      try {
        exists = statSync(resolve(root, targetFile)) !== undefined;
      } catch {
        exists = false;
      }
      if (!exists) {
        broken.push({ file, line: link.line, target: link.raw, resolved: resolve(root, targetFile) });
        continue;
      }
      if (link.fragment === "") continue;
      if (!targetFile.endsWith(".md")) continue;
      if (!anchorsFor(targetFile).has(decodeURIComponent(link.fragment).toLowerCase())) {
        broken.push({ file, line: link.line, target: link.raw, fragment: decodeURIComponent(link.fragment), targetFile });
      }
    }
  }
  return broken;
}

/**
 * The guides a documentation index does not link to.
 *
 * An index that stops covering a guide is how a document goes quietly unreachable: the
 * file still resolves, so no link check notices, and a reader browsing the index never
 * sees it. Only documents below `dir` are considered, since the index is the entry point
 * for its own directory.
 */
export function uncoveredGuides(root, indexFile = "docs/README.md", dir = "docs") {
  const indexText = readFileSync(join(root, indexFile), "utf8");
  const covered = new Set();
  for (const link of relativeLinks(indexText)) {
    const resolved = resolve(root, dirname(indexFile), decodeURIComponent(link.target));
    covered.add(relative(root, resolved));
  }
  return markdownFiles(root)
    .filter((file) => file.startsWith(dir + "/") && file !== indexFile)
    .filter((file) => !covered.has(file));
}

/**
 * The entry files a package's scripts name.
 *
 * Returns one entry per file argument of every `node`/`tsx` invocation in every script,
 * resolved against the package directory. All of them: `node --test a.test.mjs b.test.mjs`
 * names two files, and reporting only the first would let the second go missing unnoticed.
 * Nothing here expands a glob or a shell word - `test/*.ts` is not a file, so it is skipped
 * rather than guessed at. A missing file is reported, never dropped: a script that cannot
 * run is a fact about the repository.
 */
export function scriptEntrypoints(packageDir, manifest) {
  const fileArgument = /\.(mjs|cjs|js|ts|tsx)$/;
  const entries = [];
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    for (const segment of command.split(/&&|\|\||;|\|/)) {
      const tokens = segment.trim().split(/\s+/).filter(Boolean);
      const runtime = tokens.findIndex((token) => token === "node" || token === "tsx");
      if (runtime === -1) continue;
      for (const token of tokens.slice(runtime + 1)) {
        if (token.startsWith("-")) continue;
        if (token.includes("*") || token.includes("$")) continue;
        if (!fileArgument.test(token)) break;
        const resolved = resolve(packageDir, token);
        let exists = false;
        try {
          exists = statSync(resolved).isFile();
        } catch {
          exists = false;
        }
        entries.push({ package: packageDir, script: name, target: token, resolved, exists });
      }
    }
  }
  return entries;
}
