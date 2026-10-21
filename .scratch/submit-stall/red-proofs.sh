#!/usr/bin/env bash
# Red proofs for the snapshot review fixes. Each mutation reverts one fix, runs the test that owns it, and restores the
# file from git. A mutation whose test still passes is not a proof.
#
# Run: bash .scratch/submit-stall/red-proofs.sh
set -u
cd "$(dirname "$0")/../.."
OUT=.scratch/submit-stall/red
mkdir -p "$OUT"

mutate() { # mutate <file> <anchor> <replacement>
  node -e '
    const {readFileSync,writeFileSync}=require("node:fs");
    const [file,from,to]=process.argv.slice(1);
    const text=readFileSync(file,"utf8");
    if(!text.includes(from)){console.error("mutation anchor missing in "+file);process.exit(2);}
    writeFileSync(file,text.replace(from,to));
  ' "$1" "$2" "$3"
}

proof() { # proof <label> <test-file> <test-name>
  if node --test --test-name-pattern="$3" "$2" >"$OUT/$1.log" 2>&1; then
    echo "$1: NOT A PROOF (test still passes)"
  else
    echo "$1: red (log $OUT/$1.log)"
  fi
}

mutate packages/gateway/src/filesystem.ts 'if (pruning && rules.ignores(' 'if (false && rules.ignores('
proof prune-before-read apps/server/test/resource-snapshot.test.ts "ignored subtree is never read"
git checkout packages/gateway/src/filesystem.ts

mutate packages/gateway/src/filesystem.ts 'const terminal = kind === "skills" && found.some(' 'const terminal = false && found.some('
proof skill-terminal apps/server/test/resource-snapshot.test.ts "contributes only its declaration"
git checkout packages/gateway/src/filesystem.ts

mutate packages/gateway/src/filesystem.ts 'if (info.size > MAX_FILE_BYTES) return { failure: failureOf(tooLarge(info.size)) };' 'if (false) return { failure: failureOf(tooLarge(info.size)) };'
proof per-file-limit apps/server/test/resource-snapshot.test.ts "past the per-file limit"
git checkout packages/gateway/src/filesystem.ts

mutate packages/gateway/src/filesystem.ts 'if (response > MAX_SNAPSHOT_BYTES) throw new FileError(' 'if (false) throw new FileError('
proof serialized-bound apps/server/test/resource-snapshot.test.ts "serialized payload bound"
git checkout packages/gateway/src/filesystem.ts

mutate packages/gateway/src/filesystem.ts 'if (names instanceof FileError) { unreadable(directory, real, names); return; }' 'if (names instanceof FileError) { return; }'
proof unreadable-directory packages/gateway/test/resource-snapshot.test.ts "unreadable directory"
git checkout packages/gateway/src/filesystem.ts

mutate packages/gateway/src/resource-ignore.ts 'if (patterns.some(pruningIsOpaque)) this.#opaque = true;' 'if (false) this.#opaque = true;'
proof opaque-parity packages/gateway/test/resource-snapshot.test.ts "turns pruning off on both producers"
git checkout packages/gateway/src/resource-ignore.ts

mutate packages/gateway/src/ssh-filesystem.ts 'if terminal and entry[\"info\"][\"name\"] != \"SKILL.md\":' 'if False and entry[\"info\"][\"name\"] != \"SKILL.md\":'
proof skill-terminal-ssh packages/gateway/test/resource-snapshot.test.ts "declared skill is terminal even when an uncovered rule"
git checkout packages/gateway/src/ssh-filesystem.ts

echo "tree: $(git status --short | wc -l) modified"
