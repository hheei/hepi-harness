/**
 * The one execution-side edit the installation capability makes to a skill's own document: setting or clearing the
 * \`disable-model-invocation\` frontmatter key.
 *
 * Adapted from pi-web \`lib/skill-frontmatter.ts\` (\`setDisableModelInvocation\`), preserved at
 * 76bdc57027172eb381a216d647225a6d24f23360, MIT: the pinned bytes and LICENSE sit in
 * \`packages/gateway/vendor/pi-web/\`, where they moved from the retired \`apps/web/vendor/pi-web/\`.
 * The upstream rules are kept: a surgical line edit inside the frontmatter block only, so every other field, its
 * formatting, the fences and the body stay byte for byte as they were; an explicit \`false\` is replaced in place,
 * because prepending a second key would make the file a duplicate-key document the loader then drops; a key already
 * in the requested state leaves the file — and its mtime — untouched; and a document whose key cannot be edited is
 * refused rather than rewritten.
 *
 * One difference from the upstream copy, because the same edit must run on an execution host where this program's own
 * YAML parser is not available (the remote helper is stdlib Python): which key is the document's **own** is decided
 * by the frontmatter's indentation instead of by a parsed mapping, so the rule transcribes exactly into the remote
 * helper and both hosts agree byte for byte. A key nested under another mapping is not the document's own key — it
 * does not disable the skill — so it is never edited in place, and a frontmatter shape no new top-level key can be
 * added to is refused instead of corrupted.
 *
 * The file is not loaded or executed here: text in, text out, and a document this function changes is the same skill
 * afterwards.
 */

const KEY = "disable-model-invocation";
const DOUBLE = '"';
const SINGLE = "'";
const SPACE = "[ \\t]";
const BREAK = "\\r\\n|\\n|\\r";
/** A line that names the key, optionally quoted, and the indentation in front of it. */
const KEY_ATOM = "(?:" + KEY + "|" + DOUBLE + KEY + DOUBLE + "|" + SINGLE + KEY + SINGLE + ")";
const KEY_LINE = new RegExp("^(" + SPACE + "*)(" + KEY_ATOM + SPACE + "*:)([^\\r\\n]*)$");
/** A line that names any frontmatter key, so the block's own level can be found without a parser. */
const ANY_KEY_LINE = new RegExp("^" + SPACE + "*(?:[^ \\t:\\r\\n]+|" + DOUBLE + "[^" + DOUBLE + "\\r\\n]+" + DOUBLE + "|" + SINGLE + "[^" + SINGLE + "\\r\\n]+" + SINGLE + ")" + SPACE + "*:");
const OPENING = new RegExp("^\\uFEFF?---[ \\t]*(" + BREAK + ")");
const CLOSING = new RegExp("(^|" + BREAK + ")---");
const LINE = new RegExp("[^" + BREAK + "]*(" + BREAK + "|$)", "g");
const TRAILING_BREAK = new RegExp("(?:" + BREAK + ")$");

type Line = { readonly text: string; readonly start: number; readonly end: number };

/** The lines of a frontmatter block head, each with its span there, its own line break included in \`end\`. */
function scanLines(head: string): Line[] {
  const lines: Line[] = [];
  LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINE.exec(head)) !== null) {
    if (match[0] === "") break;
    lines.push({ text: match[0].replace(TRAILING_BREAK, ""), start: match.index, end: match.index + match[0].length });
  }
  return lines;
}

const indentOf = (text: string): number => /^[ \t]*/.exec(text)![0].length;

type BlockShape = { readonly base: number; readonly own: readonly Line[] };

/**
 * The block's own key level and the key's own line when the document holds it there. \`undefined\` when no top-level key
 * can exist: the block is a sequence, a flow mapping or a scalar rather than a mapping. An empty block is a mapping
 * with no keys yet, so the key is added at column zero.
 */
function blockShape(lines: readonly Line[]): BlockShape | undefined {
  // A comment line names no key and does not make the block a non-mapping, so it is skipped rather than treated as
  // a value at the document's own level.
  const filled = lines.filter((line) => line.text.trim() !== "" && !line.text.trim().startsWith("#"));
  if (filled.length === 0) return { base: 0, own: [] };
  const keys = filled.filter((line) => ANY_KEY_LINE.test(line.text));
  if (keys.length === 0) return undefined;
  const base = Math.min(...keys.map((line) => indentOf(line.text)));
  const atBase = filled.filter((line) => indentOf(line.text) === base);
  // A line at the block's own level that names no key is a sequence entry, a flow mapping or a scalar: a key written
  // there would not be a sibling of the mapping.
  if (atBase.some((line) => !ANY_KEY_LINE.test(line.text))) return undefined;
  const own = atBase.filter((line) => KEY_LINE.test(line.text));
  // Two keys at one level are a duplicate-key document already; neither is "the" key.
  if (own.length > 1) return undefined;
  return { base, own };
}

type Block =
  | { readonly kind: "none" }
  /** A fence that opens and never closes: there is no block to read, and the document as a whole is not one the loader
   * accepts, so neither setting nor clearing the key can be reported as done. */
  | { readonly kind: "unclosed" }
  | { readonly kind: "closed"; readonly openingEnd: number; readonly closingStart: number; readonly newline: string; readonly head: string };

/** The frontmatter block's head and the content around it, or \`undefined\` when the document has no closed block. */
function block(content: string): Block {
  const opening = OPENING.exec(content);
  if (opening === null) return { kind: "none" };
  const rest = content.slice(opening[0].length);
  const closing = CLOSING.exec(rest);
  if (closing === null) return { kind: "unclosed" };
  const openingEnd = opening[0].length;
  const closingStart = opening[0].length + closing.index + closing[1]!.length;
  return { kind: "closed", openingEnd, closingStart, newline: opening[1]!, head: content.slice(openingEnd, closingStart) };
}

/**
 * The document with \`disable-model-invocation\` set to \`disable\`. Setting an already-set key, and clearing an absent
 * one, return the input unchanged, which is what makes "the file was not rewritten" a fact rather than a claim.
 */
export function setDisableModelInvocation(content: string, disable: boolean): string {
  const found = block(content);
  if (found.kind !== "closed") {
    // A fence that opens and never closes is refused in both directions: there is no block to read, and the document is
    // not one the loader accepts, so reporting success would claim an edit nobody can see.
    if (found.kind === "unclosed") throw new Error("Cannot edit " + KEY + ": unsupported frontmatter formatting");
    if (!disable) return content;
    // No block at all: the SDK reads no frontmatter, so a fresh block is the edit.
    const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
    return bom + "---\n" + KEY + ": true\n---\n" + (bom === "" ? content : content.slice(1));
  }
  const shape = blockShape(scanLines(found.head));
  if (shape === undefined) throw new Error("Cannot edit " + KEY + ": unsupported frontmatter formatting");
  const present = shape.own[0];
  if (present === undefined) {
    if (!disable) return content;
    return content.slice(0, found.openingEnd) + " ".repeat(shape.base) + KEY + ": true" + found.newline + content.slice(found.openingEnd);
  }
  // The key's own line is replaced or dropped in whole, so the other fields, their indentation and their quoting are
  // untouched. The line break that ended it travels with the span, so it is carried over explicitly and the next line
  // keeps exactly one break in front of it.
  const break_ = found.head.slice(present.start + present.text.length, present.end);
  const replacement = disable ? present.text.replace(KEY_LINE, "$1$2 true") + break_ : "";
  return content.slice(0, found.openingEnd) + found.head.slice(0, present.start) + replacement + found.head.slice(present.end) + content.slice(found.closingStart);
}
