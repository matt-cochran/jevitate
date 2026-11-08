#!/usr/bin/env node
// Distils the model-free coverage explorations (jevitate explore --strategy coverage --fake-ai, one
// per Journey's app page; see report/README in the experiment report) into a pool of alternative
// controls per route: { route: [{role, name, testId?}] }. Usage: node explore-pool.mjs J1 ~/gt/explore/J1
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const [journey, dir] = process.argv.slice(2);
const tfile = readdirSync(dir).find((f) => f.endsWith(".transcript.json"));
const transcript = JSON.parse(readFileSync(join(dir, tfile), "utf8"));
const pool = {};
const add = (route, c) => {
  const list = (pool[route] ??= []);
  const k = (x) => `${x.role}|${x.name}`;
  const hit = list.find((x) => k(x) === k(c));
  if (hit) { if (c.testId && !hit.testId) hit.testId = c.testId; } else list.push(c);
};
const parse = (s) => /^(\w+) "(.*)"$/.exec(s);
for (const s of transcript) {
  const route = new URL(s.url).pathname;
  for (const c of s.controls ?? []) {
    const m = parse(c);
    if (m && (m[1] === "link" || m[1] === "button")) add(route, { role: m[1], name: m[2] });
  }
  const m = parse(s.target ?? "");
  if (m && s.descriptor?.testId && (m[1] === "link" || m[1] === "button")) add(route, { role: m[1], name: m[2], testId: s.descriptor.testId });
}
mkdirSync(join(HERE, "exploration"), { recursive: true });
writeFileSync(join(HERE, "exploration", `${journey}.json`), JSON.stringify({ journey, source: tfile, steps: transcript.length, pool }, null, 1) + "\n");
console.log(journey, Object.fromEntries(Object.entries(pool).map(([r, l]) => [r, l.length])));
