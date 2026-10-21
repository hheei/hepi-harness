/**
 * TAP reading and failure-set comparison, generalized from the scratch comparator
 * `.scratch/ux-follow-up/issues/ux14-wholeweb-compare.mjs`.
 *
 * A TAP log reports failures twice over: the runner's `# fail` counter counts
 * assertions, while `not ok` lines include a file's own rollup beside its nested
 * child assertion. Neither number alone is the failure set, so both are read and
 * the comparison is by exact name.
 *
 * Names are normalized **only** by stripping the checkout prefixes the caller
 * names, because an absolute worktree path is the one genuinely noisy part. A name
 * that belongs to no named checkout keeps its spelling, so a real difference can
 * never be normalized away.
 */

/** Read the summary counters and every `not ok` name, deduplicated. */
export function parseTap(text) {
  const lines = text.split("\n");
  const notOk = lines.filter((line) => /^\s*not ok \d+/.test(line));
  const summary = {};
  for (const line of lines) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line.trim());
    if (match) summary[match[1]] = Number(match[2]);
  }
  const names = [...new Set(notOk.map((line) => {
    const dash = line.indexOf(" - ");
    return (dash === -1 ? line.replace(/^\s*not ok \d+\s*/, "") : line.slice(dash + 3)).trim();
  }).filter(Boolean))];
  return { summary, notOkLines: notOk.length, names };
}

/** Strip `prefix` from the start of `name`, also handling a `file://` spelling of it. */
export function normalizeName(name, prefixes = []) {
  let normalized = name;
  for (const prefix of prefixes) {
    if (!prefix) continue;
    for (const candidate of [prefix, "file://" + prefix]) {
      if (normalized === candidate) return "";
      if (normalized.startsWith(candidate + "/")) normalized = normalized.slice(candidate.length + 1);
      else if (normalized.startsWith(candidate)) normalized = normalized.slice(candidate.length);
    }
  }
  return normalized.trim();
}

/**
 * Compare two TAP logs by failure name. `basePrefixes`/`tipPrefixes` name the two
 * checkouts so only their own paths are stripped.
 *
 * The names that come back are the **normalized** ones. A raw name carries its absolute
 * worktree path, so a recorded failure list would name a temporary directory that no longer
 * exists, and the same failure would read differently on each side of the same report.
 */
export function compareTap(baseText, tipText, { basePrefixes = [], tipPrefixes = [] } = {}) {
  const base = parseTap(baseText);
  const tip = parseTap(tipText);
  const baseNames = new Set(base.names.map((name) => normalizeName(name, basePrefixes)));
  const tipNames = new Set(tip.names.map((name) => normalizeName(name, tipPrefixes)));
  const newOnTip = tip.names
    .filter((name) => !baseNames.has(normalizeName(name, tipPrefixes)))
    .map((name) => normalizeName(name, tipPrefixes));
  const onlyOnBase = base.names
    .filter((name) => !tipNames.has(normalizeName(name, basePrefixes)))
    .map((name) => normalizeName(name, basePrefixes));
  return {
    base: { summary: base.summary, notOkLines: base.notOkLines, uniqueNotOkNames: base.names.length, names: base.names },
    tip: { summary: tip.summary, notOkLines: tip.notOkLines, uniqueNotOkNames: tip.names.length, names: tip.names },
    newOnTip,
    onlyOnBase,
    identical: newOnTip.length === 0 && onlyOnBase.length === 0,
  };
}
