#!/usr/bin/env node
// Mutation harness — applies a source mutation, runs a test file, restores.
//
// WHY THIS EXISTS AS A TOOL RATHER THAN AN AD-HOC SCRIPT.
//
// `String.prototype.replace()` returns the ORIGINAL STRING when the pattern does
// not match. It does not throw, it does not warn. Every ad-hoc mutation script
// written by hand in this repo has had the same shape:
//
//     src = src.replace(anchor, mutated);   // if `anchor` is wrong: silent no-op
//     run the tests                          // they pass, because nothing changed
//     report "the mutation did not break anything"
//
// That reads identically to "this code is not covered by the mutation" and to
// "the test caught it" — the two conclusions are opposite and the output is the
// same. It has produced a wrong result TWICE in this repo:
//
//   1. 2026-08-10 — a doc-writing script anchored on text from an unmerged PR.
//      Sections were silently dropped from three merges and blamed on GitHub's
//      squash before the real cause was found.
//   2. 2026-08-11 — the displacement mutation run reported TWO mutations as
//      "survived" that had never executed. Both were caught by suspicion, not by
//      process. One of them, once actually applied, revealed a genuinely weak
//      test.
//
// Twice is not an accident. So the anchor check is structural here: a mutation
// whose anchor is absent, or ambiguous, ABORTS. It can never be reported as a
// surviving mutation, because it never runs.
//
// Usage:
//   node scripts/mutate.mjs mutations/<name>.json
//
// Each mutation file is a JSON array of:
//   { "label": "...", "file": "src/x.ts", "find": "...", "replace": "...",
//     "test": "src/x.test.ts", "expect": "fail" }
//
// `expect` defaults to "fail": the point of a mutation is that a test catches
// it. A mutation that is EXPECTED to survive (an equivalent mutant) must say so
// explicitly with "pass", so that equivalence is a claim someone wrote down
// rather than a silence.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const spec = process.argv[2];
if (!spec) {
  console.error("usage: node scripts/mutate.mjs <mutations.json>");
  process.exit(2);
}

const mutations = JSON.parse(readFileSync(spec, "utf8"));
const results = [];
let aborted = 0;

for (const m of mutations) {
  const expect = m.expect ?? "fail";
  const original = readFileSync(m.file, "utf8");

  // STRUCTURAL ANCHOR CHECK — the whole point of this file.
  const occurrences = original.split(m.find).length - 1;
  if (occurrences === 0) {
    console.error(`\n  ABORT  ${m.label}\n         anchor not found in ${m.file} — this mutation never ran.`);
    aborted++;
    continue;
  }
  if (occurrences > 1) {
    // Ambiguity is as bad as absence: replacing the first of several matches
    // mutates something other than what the label claims.
    console.error(
      `\n  ABORT  ${m.label}\n         anchor matches ${occurrences}x in ${m.file} — ambiguous, so which line ` +
        `was mutated is unknown. Narrow it.`,
    );
    aborted++;
    continue;
  }

  writeFileSync(m.file, original.replace(m.find, m.replace));
  let passed;
  try {
    execFileSync("npx", ["vitest", "run", m.test, "--silent"], { stdio: "pipe" });
    passed = true;
  } catch {
    passed = false;
  } finally {
    writeFileSync(m.file, original); // restore before anything else can run
  }

  const survived = passed;
  const ok = expect === "fail" ? !survived : survived;
  results.push({ label: m.label, survived, ok });
  console.log(`  ${ok ? "OK    " : "SURVIVED"}  ${m.label}${ok ? "" : "   <-- the test did NOT catch this"}`);
}

const bad = results.filter((r) => !r.ok).length;
console.log(
  `\n  ${results.length} mutation(s) run, ${bad} unexpected, ${aborted} aborted before running.` +
    (aborted ? "\n  An aborted mutation is NOT a passing one — fix the anchor and re-run." : ""),
);
process.exit(bad || aborted ? 1 : 0);
