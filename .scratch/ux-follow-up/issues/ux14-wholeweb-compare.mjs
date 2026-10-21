
import {readFileSync, writeFileSync} from "node:fs";
const norm = (s) => s.replace(/^\/apps\/web\//, "").trim();
const parse = (p) => {
  const lines = readFileSync(p, "utf8").split("\n");
  const notOk = lines.filter((l) => /^\s*not ok \d+/.test(l));
  const summary = Object.fromEntries(lines.filter((l) => /^# (tests|pass|fail|cancelled|skipped|todo) /.test(l)).map((l) => [l.split(" ")[1], Number(l.split(" ").pop())]));
  const names = [...new Set(notOk.map((l) => "|" + l.slice(l.indexOf(" - ") + 3).trim()))];
  return {summary, notOkCount: notOk.length, uniqueNotOkNames: names.length, names};
};
const tip = parse(process.argv[2]), base = parse(process.argv[3]);
const normBase = new Set(base.names.map(norm)), normTip = new Set(tip.names.map(norm));
const newOnes = tip.names.filter((n) => !normBase.has(norm(n)));
const goneOnes = base.names.filter((n) => !normTip.has(norm(n)));
const byName = (list, tag) => writeFileSync(process.argv[4] + "/ux14-fail-" + tag + ".txt", list.join("\n") + "\n");
byName(base.names, "base"); byName(tip.names, "tip");
console.log(JSON.stringify({
  base: {summary: base.summary, notOkLines: base.notOkCount, uniqueNotOkNames: base.names.length},
  tip: {summary: tip.summary, notOkLines: tip.notOkCount, uniqueNotOkNames: tip.names.length},
  newFailureNamesOnTip: newOnes,
  failureNamesOnlyOnBase: goneOnes,
  identical: newOnes.length === 0 && goneOnes.length === 0
}, null, 2));
