#!/usr/bin/env node
// d-docs-outcomes guard: the exit-code and verdict tables in the user docs say what the code does.
//
// Compares, row by row:
//   docs/outcomes.md   "Exit codes"                       ↔ EXIT_CODES (packages/cli/src/exit-codes.ts)
//                      "Mission outcomes and exit codes"  ↔ MISSION_EXIT_CODES (packages/domain/src/mission-outcome.ts)
//                      Journey run outcomes               ↔ JOURNEY_MISSION_OUTCOME / journeyExitCode (journey-outcome.ts)
//                      goalOutcome → missionOutcome       ↔ GOAL_OUTCOME_FOLD / outcomeExitCode
//                      goalOutcome × defectOutcome        ↔ goalMissionOutcome
//                      the job answer's exit codes        ↔ journeyExitCode(outcome, { attainment, doneCheckPolicy })
//                      attainment / basis / policy tables ↔ JOB_ATTAINMENTS, JOB_BASES, DONE_CHECK_POLICIES (job-attainment.ts)
//                      boundary kinds and signals         ↔ BoundaryEvidenceSchema (packages/adjudicator/src/evidence.ts), GOAL_REASONS
//   README.md          the outcome table                  ↔ MISSION_EXIT_CODES
//   docs/contracts/evidence.md   names every schema evidence.ts exports, every field of each object schema and every enum value
//   docs/contracts/done-check.md names every DoneCheckSpecSchema field, check kind, E_DONE_CHECK_* code and lint rule
// and that docs/outcomes.md keeps the sentence "A proof's strength depends on a target you can reset".
//
// Reads the BUILT packages (dist/), like scripts/api-surface.test.mjs: run `pnpm -r build` first. Part of
// `pnpm lint`: with no dist/ it skips outside CI (CI set) and fails in CI, where lint runs after the build.
// Usage: node --test scripts/check-docs-exit-codes.mjs   (or node scripts/check-docs-exit-codes.mjs)

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

// `pnpm lint` runs this check. CI lints after `pnpm -r build`, so there a missing dist/ is an error; a local
// `pnpm lint` before any build skips the check (with a note) instead of failing on an unbuilt tree.
const BUILT = ["packages/domain/dist/index.js", "packages/cli/dist/exit-codes.js", "packages/adjudicator/dist/index.js", "packages/journey/dist/index.js"];
const unbuilt = BUILT.filter((rel) => !existsSync(join(REPO, rel)));
if (unbuilt.length > 0 && process.env.CI === undefined) {
  process.stderr.write(`check-docs-exit-codes: skipped, not built (${unbuilt.join(", ")}): run \`pnpm -r build\` first\n`);
  process.exit(0);
}

async function load(rel) {
  const path = join(REPO, rel);
  if (!existsSync(path)) throw new Error(`${rel} is missing: run \`pnpm -r build\` first`);
  return import(pathToFileURL(path).href);
}

const domain = await load("packages/domain/dist/index.js");
const cliExit = await load("packages/cli/dist/exit-codes.js");
const adjudicator = await load("packages/adjudicator/dist/index.js");
const journey = await load("packages/journey/dist/index.js");

// ── Markdown tables ───────────────────────────────────────────────────────────────────────────

/** A table row's cells: split on `|` not escaped as `\|`, trimmed, with `\|` restored. */
function cellsOf(line) {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Every table in a document: `{ header, rows, line }`, in order. */
function tablesOf(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].trim().startsWith("|") || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    const header = cellsOf(lines[i]).map(plain);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) rows.push(cellsOf(lines[j]));
    out.push({ header, rows, line: i + 1 });
    i = j - 1;
  }
  return out;
}

/** A cell's text without backticks. */
function plain(cell) {
  return cell.replace(/`/g, "").trim();
}

/** The first table whose header starts with `cols` (backticks ignored). */
function tableWith(text, cols, where) {
  const t = tablesOf(text).find((tb) => cols.every((c, i) => tb.header[i] === c));
  assert.ok(t, `${where}: no table with header ${cols.map((c) => `| ${c} `).join("")}|`);
  return t;
}

/** The backticked words in a cell, or the plain cell split on `/` and `,` when it has none. */
function wordsOf(cell) {
  const ticked = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  if (ticked.length > 0) return ticked;
  return cell.split(/[/,]/).map((w) => w.trim()).filter((w) => w !== "");
}

const sameSet = (actual, expected, what) =>
  assert.deepEqual([...new Set(actual)].sort(), [...new Set(expected)].sort(), `${what}: the docs list ${JSON.stringify([...new Set(actual)].sort())}, the code ${JSON.stringify([...new Set(expected)].sort())}`);

const outcomes = read("docs/outcomes.md");
const readme = read("README.md");
const evidenceDoc = read("docs/contracts/evidence.md");
const doneCheckDoc = read("docs/contracts/done-check.md");

// ── docs/outcomes.md ──────────────────────────────────────────────────────────────────────────

test("outcomes.md 'Exit codes': one row per EXIT_CODES class, with its number", () => {
  const { rows } = tableWith(outcomes, ["Exit", "Class", "Meaning"], "docs/outcomes.md");
  const classOf = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const byCode = new Map();
  for (const [exit, cls] of rows) {
    const code = plain(exit);
    if (/^\d+$/.test(code)) byCode.set(Number(code), plain(cls));
  }
  for (const [key, code] of Object.entries(cliExit.EXIT_CODES)) {
    assert.equal(byCode.get(code), classOf(key), `exit ${code}: the docs say class '${byCode.get(code)}', exit-codes.ts says '${classOf(key)}'`);
  }
  sameSet([...byCode.keys()], Object.values(cliExit.EXIT_CODES), "numeric exit codes");
});

test("outcomes.md 'Mission outcomes and exit codes' ↔ MISSION_EXIT_CODES", () => {
  const { rows } = tableWith(outcomes, ["Outcome", "Exit code", "Meaning"], "docs/outcomes.md");
  const listed = [];
  for (const [outcome, exit] of rows) {
    for (const o of wordsOf(outcome)) {
      listed.push(o);
      assert.equal(Number(plain(exit)), domain.MISSION_EXIT_CODES[o], `mission outcome '${o}': docs exit ${plain(exit)}, code ${domain.MISSION_EXIT_CODES[o]}`);
    }
  }
  sameSet(listed, domain.MISSION_OUTCOMES.filter((o) => o !== "pending-review"), "mission outcomes (pending-review is a Journey-only outcome)");
});

test("outcomes.md Journey run outcomes ↔ JOURNEY_MISSION_OUTCOME and journeyExitCode", () => {
  const { rows } = tableWith(outcomes, ["Journey outcome", "Exit code", "Mission outcome"], "docs/outcomes.md");
  const listed = [];
  for (const [outcome, exit, mission] of rows) {
    const o = plain(outcome);
    listed.push(o);
    assert.equal(plain(mission), domain.JOURNEY_MISSION_OUTCOME[o], `Journey outcome '${o}': docs mission outcome ${plain(mission)}`);
    assert.equal(Number(plain(exit)), domain.journeyExitCode(o), `Journey outcome '${o}': docs exit ${plain(exit)}`);
  }
  sameSet(listed, domain.JOURNEY_RUN_OUTCOMES, "Journey run outcomes");
});

test("outcomes.md goalOutcome → missionOutcome ↔ GOAL_OUTCOME_FOLD and outcomeExitCode", () => {
  const { rows } = tableWith(outcomes, ["goalOutcome", "missionOutcome", "Exit code"], "docs/outcomes.md");
  const listed = [];
  for (const [goal, mission, exit] of rows) {
    const g = plain(goal);
    listed.push(g);
    assert.equal(plain(mission), domain.foldGoalOutcome(g), `goalOutcome '${g}': docs missionOutcome ${plain(mission)}, fold ${domain.foldGoalOutcome(g)}`);
    assert.equal(Number(plain(exit)), domain.outcomeExitCode(g), `goalOutcome '${g}': docs exit ${plain(exit)}`);
  }
  for (const g of domain.GOAL_ONLY_OUTCOMES) assert.ok(listed.includes(g), `goalOutcome '${g}' (GOAL_ONLY_OUTCOMES) has no row`);
  for (const g of listed) assert.ok(domain.isGoalOutcome(g), `'${g}' is not a goalOutcome`);
});

test("outcomes.md goalOutcome × defectOutcome ↔ goalMissionOutcome", () => {
  const { rows } = tableWith(outcomes, ["goalOutcome", "defectOutcome: none", "defectOutcome: defects"], "docs/outcomes.md");
  const listed = [];
  const cellOutcome = (cell, goal) => {
    const m = /^(?:`([^`]+)`|that outcome)\s*\((\d+)\)$/.exec(cell.trim());
    assert.ok(m, `goal × defect cell '${cell}' is not "\`outcome\` (code)" or "that outcome (code)"`);
    return { outcome: m[1] ?? goal, code: Number(m[2]) };
  };
  for (const [goals, none, defects] of rows) {
    for (const g of wordsOf(goals)) {
      listed.push(g);
      for (const [cell, status] of [[none, "none"], [defects, "defects"]]) {
        const want = domain.goalMissionOutcome(g, status);
        const got = cellOutcome(cell, g);
        assert.equal(got.outcome, want, `goalOutcome '${g}', defects ${status}: docs ${got.outcome}, code ${want}`);
        assert.equal(got.code, domain.MISSION_EXIT_CODES[want], `goalOutcome '${g}', defects ${status}: docs exit ${got.code}`);
      }
    }
  }
  for (const g of domain.GOAL_ONLY_OUTCOMES) assert.ok(listed.includes(g), `goalOutcome '${g}' has no goal × defect row`);
});

test("outcomes.md job exit codes ↔ journeyExitCode(outcome, { attainment, doneCheckPolicy })", () => {
  const { rows } = tableWith(outcomes, ["Steps", "job.attainment", "doneCheckPolicy", "Exit"], "docs/outcomes.md");
  const seen = new Set();
  for (const [steps, attainment, policy, exit] of rows) {
    const [o, a, p] = [plain(steps), plain(attainment), plain(policy)];
    assert.ok(domain.JOURNEY_RUN_OUTCOMES.includes(o), `job exit row: '${o}' is not a Journey run outcome`);
    assert.ok(domain.isJobAttainment(a), `job exit row: '${a}' is not a job attainment`);
    assert.ok(domain.isDoneCheckPolicy(p), `job exit row: '${p}' is not a doneCheckPolicy`);
    const want = domain.journeyExitCode(o, { attainment: a, doneCheckPolicy: p });
    assert.equal(Number(plain(exit)), want, `steps ${o}, job ${a}, policy ${p}: docs exit ${plain(exit)}, code ${want}`);
    seen.add(`${o}|${a}|${p}`);
  }
  for (const a of domain.JOB_ATTAINMENTS) for (const p of domain.DONE_CHECK_POLICIES) assert.ok(seen.has(`ok|${a}|${p}`), `no job exit row for a passing run with job ${a} under ${p}`);
});

test("outcomes.md attainment, basis and policy tables ↔ JOB_ATTAINMENTS, JOB_BASES, DONE_CHECK_POLICIES", () => {
  const att = tableWith(outcomes, ["attainment", "Meaning"], "docs/outcomes.md");
  sameSet(att.rows.map(([a]) => plain(a)), domain.JOB_ATTAINMENTS, "job.attainment values");
  const basis = tableWith(outcomes, ["basis", "attainment"], "docs/outcomes.md");
  sameSet(basis.rows.map(([b]) => plain(b)), domain.JOB_BASES, "job.basis values");
  for (const [b, a] of basis.rows) {
    const as = wordsOf(a);
    for (const x of as) assert.ok(domain.isJobAttainment(x), `basis ${plain(b)}: '${x}' is not an attainment`);
    // The adjudicator decides achieved / not-achieved only from a done-check reading; every other basis is unverified.
    sameSet(as, plain(b) === "done-check" ? ["achieved", "not-achieved"] : ["unverified"], `attainments under basis ${plain(b)}`);
  }
  const policy = tableWith(outcomes, ["Setting", "Effect"], "docs/outcomes.md");
  const named = policy.rows.map(([s, e]) => ({ value: /"doneCheckPolicy":\s*"([^"]+)"/.exec(s)?.[1], effect: e })).filter((r) => r.value !== undefined);
  sameSet(named.map((r) => r.value), domain.DONE_CHECK_POLICIES, "doneCheckPolicy values");
  const defaults = named.filter((r) => /\bdefault\b/i.test(r.effect)).map((r) => r.value);
  assert.deepEqual(defaults, [domain.DEFAULT_DONE_CHECK_POLICY], `the docs mark ${JSON.stringify(defaults)} as the default doneCheckPolicy, the code '${domain.DEFAULT_DONE_CHECK_POLICY}'`);
});

test("outcomes.md boundary table ↔ BoundaryEvidenceSchema and GOAL_REASONS", () => {
  const { rows } = tableWith(outcomes, ["boundary.kind", "boundary.signal"], "docs/outcomes.md");
  const shape = adjudicator.BoundaryEvidenceSchema.shape;
  sameSet(rows.map(([k]) => plain(k)), shape.kind.options, "boundary kinds");
  const signals = rows.flatMap(([, s]) => wordsOf(s));
  sameSet(signals, shape.signal.options, "boundary signals");
  for (const s of signals) assert.ok(domain.GOAL_REASONS.includes(s), `boundary signal '${s}' is not a goalReason`);
  assert.equal(domain.GOAL_OUTCOME_FOLD.boundary, "inconclusive", "a boundary folds to inconclusive");
});

test("outcomes.md keeps the countsForGate sentence", () => {
  assert.ok(outcomes.includes("A proof's strength depends on a target you can reset"), "docs/outcomes.md lost the sentence \"A proof's strength depends on a target you can reset\"");
});

// ── README.md ─────────────────────────────────────────────────────────────────────────────────

test("README outcome table ↔ MISSION_EXIT_CODES", () => {
  const { rows } = tableWith(readme, ["Outcome", "Exit", "Meaning"], "README.md");
  const listed = [];
  for (const [outcome, exit] of rows) {
    for (const o of wordsOf(outcome)) {
      listed.push(o);
      assert.equal(Number(plain(exit)), domain.MISSION_EXIT_CODES[o], `README: outcome '${o}' exit ${plain(exit)}, code ${domain.MISSION_EXIT_CODES[o]}`);
    }
  }
  sameSet(listed, domain.MISSION_OUTCOMES.filter((o) => o !== "pending-review"), "README mission outcomes");
});

// ── docs/contracts ────────────────────────────────────────────────────────────────────────────

/** The names `export const <Name>Schema` / `export function <Name>Schema` in evidence.ts. */
function exportedSchemaNames() {
  const src = read("packages/adjudicator/src/evidence.ts");
  return [...src.matchAll(/^export\s+(?:const|function)\s+(\w+Schema)\b/gm)].map((m) => m[1]);
}

const ticked = (doc, word) => doc.includes(`\`${word}\``);

test("evidence.md names every schema evidence.ts exports, with every field and enum value", () => {
  const names = exportedSchemaNames();
  assert.ok(names.length >= 10, `found only ${names.length} exported schemas in evidence.ts`);
  for (const name of names) {
    assert.ok(ticked(evidenceDoc, name) || evidenceDoc.includes(`(\`${name}\`)`), `docs/contracts/evidence.md does not name \`${name}\``);
    const schema = adjudicator[name];
    if (typeof schema !== "object" || schema === null) continue; // KnownSchema is a function
    if (schema.shape !== undefined) {
      for (const key of Object.keys(schema.shape)) assert.ok(ticked(evidenceDoc, key), `evidence.md: ${name} field \`${key}\` is not documented`);
    } else if (Array.isArray(schema.options) && schema.options.every((o) => typeof o === "string")) {
      for (const v of schema.options) assert.ok(ticked(evidenceDoc, v), `evidence.md: ${name} value \`${v}\` is not documented`);
    }
  }
});

test("done-check.md names every DoneCheckSpecSchema field, check kind, E_DONE_CHECK_* code and lint rule", () => {
  for (const key of Object.keys(journey.DoneCheckSpecSchema.shape)) assert.ok(ticked(doneCheckDoc, key), `done-check.md: field \`${key}\` is not documented`);
  for (const kind of journey.DONE_CHECK_KINDS) assert.ok(ticked(doneCheckDoc, kind), `done-check.md: check kind \`${kind}\` is not documented`);
  const codes = Object.entries(journey).filter(([k, v]) => k.startsWith("E_DONE_CHECK_") && typeof v === "string").map(([, v]) => v);
  assert.ok(codes.length >= 5, `found only ${codes.length} E_DONE_CHECK_* codes in @jevitate/journey`);
  for (const code of codes) assert.ok(ticked(doneCheckDoc, code), `done-check.md: \`${code}\` is not documented`);
  const lintSrc = read("packages/journey/src/done-check.ts");
  const rules = /export type DoneCheckLintRule = ([^;]+);/.exec(lintSrc)?.[1].match(/"([^"]+)"/g)?.map((r) => r.slice(1, -1)) ?? [];
  assert.ok(rules.length > 0, "DoneCheckLintRule not found in done-check.ts");
  for (const rule of rules) assert.ok(ticked(doneCheckDoc, rule), `done-check.md: lint rule \`${rule}\` is not documented`);
  for (const b of domain.JOB_BASES) assert.ok(ticked(doneCheckDoc, b), `done-check.md: basis \`${b}\` is not in the verdict table`);
});
