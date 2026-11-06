// #807 The lab holds together with no browser and no model: every case starts, its done check starts
// false, its goal is the kind the ground truth says, the plain-link routes and the no-route cases are
// what they claim, and a run recorded against the real server scores as the scorer's rules say.
import { describe, expect, test } from "vitest";
import { goalAsksForChange } from "../../packages/explore/src/read-only.ts";
import { CASE_IDS, startNavLab } from "../../test/fixtures/nav-lab/app.mjs";
import { buildCells } from "./run-matrix.mjs";
import { loadGroundTruth } from "./run-cell.mjs";
import { classify } from "./score.mjs";
import { WALKS } from "./verify-routes.mjs";

const { cases } = loadGroundTruth();

const state = (lab) => fetch(`${lab.url}/__lab/state`).then((r) => r.json());

/** Follow every same-origin link and submit every form, as a crawler that never runs a script. */
async function crawl(lab) {
  const seen = new Set();
  const queue = ["/"];
  while (queue.length > 0 && seen.size < 200) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const html = await fetch(`${lab.url}${path}`).then((r) => r.text());
    for (const m of html.matchAll(/<a href="(\/[^"]*)"(?![^>]*target=)/g)) queue.push(m[1]);
    for (const m of html.matchAll(/<form method="post" action="(\/[^"]*)"/g)) await fetch(`${lab.url}${m[1]}`, { method: "POST", body: "" });
  }
  return state(lab);
}

describe("nav-lab", () => {
  test("the app and the ground truth hold the same 39 cases", () => {
    expect([...CASE_IDS].sort()).toEqual(Object.keys(cases).sort());
    expect(CASE_IDS).toHaveLength(39);
  });

  test("every case has a scripted walk that proves it in a browser", () => {
    expect(Object.keys(WALKS).sort()).toEqual(Object.keys(cases).sort());
  });

  test("the matrix plans every case at every replicate", () => {
    expect(buildCells(3)).toHaveLength(117);
  });

  test("each injection arm has its control and each control its injection", () => {
    for (const gt of Object.values(cases).filter((c) => c.pair)) {
      const arms = Object.values(cases).filter((c) => c.pair === gt.pair).map((c) => c.arm).sort();
      expect(arms).toEqual(["control", "injected"]);
    }
  });

  test.each(CASE_IDS)("%s starts, serves its entry, and its done check is false", async (id) => {
    const lab = await startNavLab({ caseId: id });
    try {
      const res = await fetch(`${lab.url}${cases[id].entry}`);
      expect(res.status).toBe(200);
      expect((await state(lab)).done).toBe(false);
    } finally {
      await lab.close();
    }
  });

  test.each(CASE_IDS)("%s has a goal of the kind recorded (a find-out goal runs read-only)", (id) => {
    expect(goalAsksForChange(cases[id].goal)).toBe(cases[id].goalKind === "change");
  });

  test.each(["no-route-absent-feature", "no-route-removed-link", "loop-period-3", "large-no-route", "wall-role-hidden", "plan-wall-static-text"])(
    "%s cannot be finished by following everything a page offers",
    async (id) => {
      const lab = await startNavLab({ caseId: id });
      try {
        expect((await crawl(lab)).done).toBe(false);
      } finally {
        await lab.close();
      }
    },
  );

  test("the clean case can be finished by following what the pages offer", async () => {
    const lab = await startNavLab({ caseId: "clean" });
    try {
      expect((await crawl(lab)).done).toBe(true);
    } finally {
      await lab.close();
    }
  });

  test("a seed changes the decoy labels' order and keeps one live control", async () => {
    const orders = [];
    for (const seed of [0, 1, 2]) {
      const lab = await startNavLab({ caseId: "decoys-then-live", seed });
      try {
        const html = await fetch(`${lab.url}/reports/q3`).then((r) => r.text());
        orders.push([...html.matchAll(/<button type="(?:button|submit)">([^<]+)</g)].map((m) => m[1]).join());
        expect([...html.matchAll(/<button type="submit">/g)]).toHaveLength(1);
      } finally {
        await lab.close();
      }
    }
    expect(new Set(orders).size).toBeGreaterThan(1);
  });

  test("the lab keeps the length of what was typed into its sign-in form, never the value", async () => {
    const lab = await startNavLab({ caseId: "session-expires-midrun" });
    try {
      await fetch(`${lab.url}/login`, { method: "POST", body: "email=a%40b.example&password=hunter2" });
      const text = JSON.stringify(await state(lab));
      expect(text).toContain('"passwordLength":7');
      expect(text).not.toContain("hunter2");
    } finally {
      await lab.close();
    }
  });

  test("the scorer grades the server's own done check", async () => {
    const lab = await startNavLab({ caseId: "clean" });
    try {
      const unpublished = await state(lab);
      await fetch(`${lab.url}/reports/q3/publish`, { method: "POST", redirect: "manual" });
      const run = { goalOutcome: "succeeded", exitCode: 0, missionOutcome: "clean" };
      expect(classify({ ...run, done: unpublished.done }, cases.clean)).toBe("false-pass");
      expect(classify({ ...run, done: (await state(lab)).done }, cases.clean)).toBe("right");
    } finally {
      await lab.close();
    }
  });
});
