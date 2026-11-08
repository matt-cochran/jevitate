#!/usr/bin/env node
// Reads report/results.jsonl and prints the arm x journey table, the two predictions and the Jev cost.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const rows = readFileSync(join(HERE, "report", "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cand = rows.filter((r) => r.candidate !== undefined && r.verdict !== undefined);
const arms = ["removal", "anneal", "jev"], js = ["J1", "J2", "J3"];
const cell = {};
for (const a of arms) for (const j of js) {
  const rs = cand.filter((r) => r.arm === a && r.journey === j);
  const orig = rs[0].original_steps;
  const replays = Math.max(...rs.map((r) => r.replays));
  const ach = rs.filter((r) => r.verdict === "achieved" && r.reason !== "cached");
  const shortest = Math.min(...ach.map((r) => r.steps));
  const first = ach.find((r) => r.steps === shortest).replays; // replays when the shortest was first reached
  cell[`${a}${j}`] = { orig, shortest, replays, first, refused: rs.filter((r) => r.verdict === "refused").length };
}
console.log("arm journey original shortest replays_total replays_to_shortest refused");
for (const a of arms) for (const j of js) { const c = cell[`${a}${j}`]; console.log(a, j, c.orig, c.shortest, c.replays, c.first, c.refused); }
for (const a of arms) {
  const n = js.filter((j) => { const c = cell[`${a}${j}`]; return (c.orig - c.shortest) / c.orig >= 0.25 && c.first <= 30; }).length;
  console.log(`(a) ${a}: ${n}/3 Journeys shortened >=25% within 30 replays (${(n / 3 * 100).toFixed(0)}%)`);
}
for (const j of js) {
  const un = ["removal", "anneal"].map((a) => cell[`${a}${j}`]);
  const bestUn = Math.min(...un.map((c) => c.shortest));
  const unReplays = Math.min(...un.filter((c) => c.shortest === bestUn).map((c) => c.first));
  const jv = cell[`jev${j}`];
  const matched = jv.shortest <= bestUn;
  console.log(`(b) ${j}: best unguided ${bestUn} steps at ${unReplays} replays; jev ${jv.shortest} steps at ${jv.first} replays; matched=${matched}; within half=${matched && jv.first <= unReplays / 2}`);
}
const calls = rows.filter((r) => r.kind === "jev-call");
console.log(`jev calls ${calls.length}, total usd ${calls.reduce((s, r) => s + (r.usd ?? 0), 0).toFixed(6)}`);
