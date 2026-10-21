
import { readFileSync, readdirSync } from "node:fs";
const dir = ".scratch/chat-lifecycle";
const spec = readFileSync(dir + "/spec.md", "utf8");
const stories = spec.split("## User Stories")[1].split("## Implementation Decisions")[0]
  .match(/^\d+\. As (?:a|an) [a-z-]+/gm).map(s => parseInt(s));
console.log("spec stories:", stories.length, "range", stories[0], "-", stories[stories.length-1]);
const files = readdirSync(dir + "/issues").filter(f => f.endsWith(".md")).sort();
console.log("tickets:", files.length);
const covered = new Set();
const ids = files.map(f => f.slice(0,2));
for (const f of files) {
  const t = readFileSync(dir + "/issues/" + f, "utf8");
  const m = t.match(/^\*\*Stories:\*\* (.+)$/m);
  if (!m) { console.log("NO STORIES LINE:", f); continue; }
  for (const part of m[1].split(",")) {
    const p = part.trim();
    if (/^\d+$/.test(p)) covered.add(parseInt(p));
    else if (/^(\d+)[–-](\d+)$/.test(p)) { const [,a,b] = p.match(/^(\d+)[–-](\d+)$/); for (let i=+a;i<=+b;i++) covered.add(i); }
    else console.log("BAD story token", f, JSON.stringify(p));
  }
  const bb = t.match(/^\*\*Blocked by:\*\* (.+)$/m);
  if (!bb) console.log("NO BLOCKED BY:", f);
  const st = t.match(/^\*\*Status:\*\* (.+)$/m);
  if (!st) console.log("NO STATUS:", f);
  const seam = /^\*\*Seam:\*\*/m.test(t);
  if (!seam) console.log("NO SEAM:", f);
}
const missing = stories.filter(n => !covered.has(n));
const extra = [...covered].filter(n => !stories.includes(n)).sort((a,b)=>a-b);
console.log("uncovered stories:", missing.length ? missing.join(",") : "none");
console.log("story numbers not in spec:", extra.length ? extra.join(",") : "none");
// blocker references valid and acyclic
const byId = new Map();
for (const f of files) byId.set(f.slice(0,2), readFileSync(dir+"/issues/"+f,"utf8"));
let bad = 0;
for (const [id, t] of byId) {
  const m = t.match(/^\*\*Blocked by:\*\* (.+)$/m);
  if (/^None/.test(m[1])) continue;
  for (const ref of m[1].match(/\b(\d{2}):/g) ?? []) {
    const r = ref.slice(0,2);
    if (!byId.has(r)) { console.log("DANGLING blocker", id, "->", r); bad++; }
    if (r >= id) { console.log("NON-ORDERED blocker", id, "->", r); bad++; }
  }
}
console.log("blocker problems:", bad);
// breakdown references every ticket file
const bd = readFileSync(dir + "/ticket-breakdown.md", "utf8");
for (const f of files) if (!bd.includes("issues/" + f)) console.log("breakdown missing link:", f);
console.log("breakdown links ok");
