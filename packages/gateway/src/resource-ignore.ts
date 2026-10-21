import ignore, { type Ignore } from "ignore";

/**
 * The ignore rules of one resource root, accumulated per directory (adapted from upstream pi-coding-agent@1.1.0
 * `dist/core/skills.js` `addIgnoreRules`/`prefixIgnorePattern` and `dist/core/package-manager.js`, which read
 * `.gitignore`, `.ignore` and `.fdignore` and match the logical entry path relative to the root).
 *
 * One implementation, used twice on the same tree: the execution-side snapshot applies these rules while it walks, so
 * an ignored file or subtree is never read and never crosses the wire, and the resource loader applies the same rules
 * again over the snapshot, so it stays the authority on what a resource is. Both walks enter the same directories in
 * the same order, so the accumulated patterns — and therefore every decision — are identical.
 */
export class ResourceIgnoreRules {
  readonly #matcher: Ignore = ignore();

  /** Add the patterns of one ignore file's text, each prefixed by the directory it was read in. */
  addText(text: string, prefix: string): void {
    const patterns = text.split(/\r?\n/).map((line) => ignorePattern(line, prefix)).filter((line): line is string => line !== undefined);
    if (patterns.length === 0) return;
    this.#matcher.add(patterns);
  }

  ignores(path: string): boolean {
    return this.#matcher.ignores(path);
  }
}

/** One ignore file line as a root-relative pattern, or nothing when the line is blank or a comment. */
export function ignorePattern(line: string, prefix: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return undefined;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) { negated = true; pattern = pattern.slice(1); }
  else if (pattern.startsWith("\\!")) pattern = pattern.slice(1);
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const prefixed = prefix ? prefix + pattern : pattern;
  return negated ? "!" + prefixed : prefixed;
}
