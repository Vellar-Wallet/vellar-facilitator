#!/usr/bin/env node
// Assert that a merged PR's CONTENT is actually on main.
//
// WHY THIS EXISTS. Five times in this engagement, content was reported merged
// and was not on main. Every catch was incidental — a test count that looked
// wrong, a PR title in a list, a grep run for another reason. Two mechanisms
// were eventually identified:
//
//   1. A doc script anchored on text that did not exist, so `String.replace()`
//      silently no-opped and the "merged" PR carried no change (#6, #9, #13,
//      and the D-1..D-3 bodies in #23).
//   2. A STACKED PR merged into its parent branch AFTER the parent had already
//      been squash-merged to main, so the child landed somewhere unreachable
//      (#34 — reported MERGED, 17 minutes after its base was squashed away).
//
// `scripts/mutate.mjs` made the first class impossible to report as a pass.
// This is the same problem one level up.
//
// ── WHY NOT `git merge-base --is-ancestor <head> main` ──────────────────────
// Because this repo squash-merges. A squash rewrites the branch into one new
// commit, so the PR's head SHA is NEVER an ancestor of main — the check reports
// failure for perfectly healthy merges, and would have reported the same failure
// for #34. A check that fails identically for the good and the bad case carries
// no information. Ancestry is used here only when a real merge commit exists.
//
// What actually distinguishes the cases is CONTENT: did the lines this PR added
// arrive in main's copy of those files?
//
// Usage:
//   node scripts/verify-merged.mjs 35 36 21 22
//   node scripts/verify-merged.mjs --selftest    # 34 must FAIL
//
// Exit 0 only if every PR passes. Run it after every merge.

import { execFileSync } from "node:child_process";

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const gh = (args) => JSON.parse(sh("gh", args));

/** Lines a human would recognise: long enough to be distinctive, not scaffolding. */
function distinctiveAdditions(patch) {
  const byFile = new Map();
  let file = null;
  for (const line of patch.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) {
      file = m[1];
      if (!byFile.has(file)) byFile.set(file, []);
      continue;
    }
    if (!file || !line.startsWith("+") || line.startsWith("+++")) continue;
    const body = line.slice(1).trim();
    // Skip scaffolding that legitimately recurs everywhere and would pass by
    // coincidence: braces, imports, short fragments, pure punctuation.
    if (body.length < 25) continue;
    if (/^(import |export \{|\}|\);|\* |\/\/ |# )/.test(body)) continue;
    byFile.get(file).push(body);
  }
  return byFile;
}

function verify(pr) {
  const meta = gh(["pr", "view", String(pr), "--json", "state,mergedAt,baseRefName,headRefOid,mergeCommit,title"]);
  const problems = [];
  const notes = [];

  if (meta.state !== "MERGED") problems.push(`state is ${meta.state}, not MERGED`);

  // CHECK 1 — the base. This alone catches the stacked-squash case: #34 was
  // MERGED, but into `fix/g11-canonical-key`, not into main.
  if (meta.baseRefName !== "main") {
    problems.push(
      `merged into "${meta.baseRefName}", NOT main — if that branch was squash-merged first, this content is unreachable`,
    );
  }

  // CHECK 2 — provenance on main. A squash commit referencing (#N), or a real
  // merge commit that is an ancestor.
  const squash = sh("git", ["log", "origin/main", "--oneline", `--grep=(#${pr})`, "-1"]).trim();
  const mergeSha = meta.mergeCommit?.oid;
  let ancestor = false;
  if (mergeSha) {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", mergeSha, "origin/main"], { stdio: "ignore" });
      ancestor = true;
    } catch {
      /* not an ancestor */
    }
  }
  if (!squash && !ancestor) problems.push(`no commit on main references (#${pr}) and no merge commit is an ancestor`);
  else notes.push(squash ? `on main as ${squash.split(" ")[0]}` : `merge commit ${mergeSha.slice(0, 8)} is an ancestor`);

  // CHECK 3 — the content itself. The only check that would have caught the
  // silent-no-op class, where the PR was merged into main correctly and simply
  // contained nothing.
  const patch = sh("gh", ["pr", "diff", String(pr), "--patch"]);
  const additions = distinctiveAdditions(patch);
  let filesChecked = 0;
  for (const [file, lines] of additions) {
    if (lines.length === 0) continue;
    filesChecked++;
    let current;
    try {
      current = sh("git", ["show", `origin/main:${file}`]);
    } catch {
      problems.push(`${file}: added by this PR but absent from main`);
      continue;
    }
    const landed = lines.filter((l) => current.includes(l)).length;
    if (landed === 0) {
      problems.push(`${file}: NONE of its ${lines.length} distinctive added lines are in main`);
    } else if (landed < lines.length * 0.5) {
      notes.push(`${file}: only ${landed}/${lines.length} added lines present — later edits, or a partial landing`);
    }
  }
  if (filesChecked === 0) notes.push("no substantive additions to verify (deletions/renames only)");

  return { pr, title: meta.title, problems, notes };
}

const selftest = process.argv.includes("--selftest");
const prs = selftest ? [34] : process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (prs.length === 0) {
  console.error("usage: node scripts/verify-merged.mjs <pr>...   |   --selftest");
  process.exit(2);
}

let failed = 0;
for (const pr of prs) {
  const r = verify(pr);
  const ok = r.problems.length === 0;
  if (!ok) failed++;
  console.log(`\n  ${ok ? "LANDED" : "NOT LANDED"}  #${r.pr}  ${r.title.slice(0, 62)}`);
  for (const n of r.notes) console.log(`            · ${n}`);
  for (const p of r.problems) console.log(`      FAIL  ${p}`);
}

if (selftest) {
  // #34 is the known-bad case, preserved deliberately: MERGED, but into a branch
  // that had already been squashed away. If this ever reports LANDED, the check
  // has regressed and cannot be trusted on a real merge.
  const pass = failed === 1;
  console.log(`\n  SELF-TEST: #34 must NOT land — ${pass ? "correct" : "REGRESSED, this script is not trustworthy"}`);
  process.exit(pass ? 0 : 1);
}

console.log(`\n  ${prs.length} PR(s) checked, ${failed} not landed.`);
process.exit(failed ? 1 : 0);
