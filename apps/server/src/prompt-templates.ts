/**
 * Adapted from `@earendil-works/pi-coding-agent@1.1.0` `dist/core/prompt-templates.js` (MIT, earendil-works/pi at
 * revision 6fb2e7815167e6b19006fc526d1a5d0f5f998787). The package root re-exports neither function and the
 * `core/prompt-templates` subpath is not exported, so no public API is available; these are behavior-equivalent to the
 * upstream implementations rather than a differently specified substitute. No vendor copy is added, so no unused
 * directory-loader dependencies come with it.
 *
 * Substitution of `$1`, `$@`, `$ARGUMENTS`, `${N:-default}`, `${@:N}` and `${@:N:L}` in template content.
 */
export function substituteArgs(content: string, args: string[]): string {
  const all = args.join(" ");
  return content.replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g, (_match, target, fallback, sliceStart, sliceLength, simple) => {
    if (target !== undefined) {
      const value = target === "@" || target === "ARGUMENTS" ? all : args[Number.parseInt(target, 10) - 1];
      return value === undefined || value === "" ? fallback : value;
    }
    if (sliceStart !== undefined) {
      const start = Math.max(0, Number.parseInt(sliceStart, 10) - 1);
      return sliceLength === undefined ? args.slice(start).join(" ") : args.slice(start, start + Number.parseInt(sliceLength, 10)).join(" ");
    }
    if (simple === "ARGUMENTS" || simple === "@") return all;
    return args[Number.parseInt(simple, 10) - 1] ?? "";
  });
}

/** Arguments of a command line, respecting single and double quotes. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of argsString) {
    if (quote !== null) { if (char === quote) quote = null; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (current !== "") { args.push(current); current = ""; } continue; }
    current += char;
  }
  if (current !== "") args.push(current);
  return args;
}
