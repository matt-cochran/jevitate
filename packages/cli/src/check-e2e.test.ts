import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import type { CheckResult } from "./check-api.js";

/**
 * #137 served e2e: `jevitate check --suite` against a real page in a real browser. The suite has
 * one promoted Journey that passes and a declared invariant the page violates (clicking Import
 * spends credits without delivering an import). The check must exit non-zero, and its JUnit file
 * must show the Journey passed and the invariant sweep failed.
 */

const APP = `<!doctype html><html><body><main data-testid="app-shell">
  <h1>Imports</h1>
  <p>Credits: <span data-testid="credit-balance">1,000</span></p>
  <ul data-testid="imports"></ul>
  <button type="button" id="imp">Import</button>
  <script>
    let bal = 1000;
    document.getElementById("imp").onclick = () => {
      bal -= 40;
      document.querySelector("[data-testid=credit-balance]").textContent = bal.toLocaleString("en-US");
    };
  </script></main></body></html>`;

/** #195: the same app plus a harmless control, so a run refused Import still exercises something. */
const APP_WITH_REFRESH = APP.replace(
  '<button type="button" id="imp">Import</button>',
  '<button type="button" id="imp">Import</button> <button type="button" id="ref" onclick="document.title=\'refreshed\'">Refresh</button>',
);

let server: Server;
let origin: string;
let dir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/app2") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP_WITH_REFRESH);
      return;
    }
    if (path === "/app") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-check-e2e-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe("jevitate check — served suite (#137)", () => {
  it(
    "a passing Journey and a violated invariant: exits non-zero with a correct JUnit file",
    async () => {
      const journeysDir = join(dir, "journeys");
      await new FsJourneyStore(journeysDir).put({
        metadata: { id: "imports-page", name: "Imports page loads", promoted: true, params: [], createdAtIso: "2026-09-24T00:00:00.000Z" },
        recording: {
          version: "1.0.0",
          site: origin,
          pages: [
            {
              url: "/app",
              steps: [
                { step: { kind: "navigate", url: "/app", expect: { kind: "urlIncludes", text: "/app" } } },
                { step: { kind: "navigate", url: "/app", expect: { kind: "textIncludes", target: { testId: "app-shell" }, text: "Imports" } } },
              ],
            },
          ],
        },
      });
      await writeFile(
        join(dir, "credits.json"),
        JSON.stringify({
          observe: {
            balance: { dom: { selector: "[data-testid=credit-balance]", number: true } },
            imports: { dom: { selector: "[data-testid=imports] li", read: "count" } },
          },
          invariants: [{ id: "charge-implies-delivery", require: "delta(balance) < 0 -> delta(imports) >= 1" }],
        }),
      );
      await writeFile(
        join(dir, "suite.json"),
        JSON.stringify({
          version: 1,
          name: "served",
          budget: { maxActions: 20, maxMinutes: 5 },
          targets: [{ name: "imports", url: `${origin}/app`, journeys: ["imports-page"], invariants: ["credits.json"] }],
        }),
      );

      const lines: string[] = [];
      const program = buildProgram({
        profiles: new ProfileManager("/unused"),
        journeysDir,
        explore: { browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(dir, "no-targets.json") },
      });
      program.configureOutput({ writeOut: (s) => lines.push(s) });
      program.exitOverride();
      const out = join(dir, "out");
      process.exitCode = undefined;
      await program.parseAsync(["check", "--suite", join(dir, "suite.json"), "--out", out, "--target-build", "sha-abc", "--json"], { from: "user" });
      const exitCode = process.exitCode;
      process.exitCode = undefined;

      const env = JSON.parse(lines.join("")) as { ok: boolean; data: CheckResult };
      expect(env.ok).toBe(true);
      const r = env.data;
      expect(exitCode).toBe(1);
      expect(r).toMatchObject({ verdict: "fail", exitCode: 1, targetBuild: "sha-abc" });
      expect(r.items.map((i) => [i.kind, i.name, i.verdict])).toEqual([
        ["journey", "imports-page", "passed"],
        ["mission", "invariants", "failed"],
      ]);
      const gating = r.findings.filter((f) => f.gating);
      expect(gating).toHaveLength(1);
      expect(gating[0]).toMatchObject({ category: "invariant", identity: { signal: "invariant:charge-implies-delivery", route: "/app" } });
      expect(gating[0]?.reproduce).toMatch(/^jevitate verify-fix --result .*feature-.*\.result\.json --fingerprint [0-9a-f]{16}$/);

      const xml = await readFile(join(out, "junit.xml"), "utf8");
      expect(xml).toMatch(/<testsuites name="jevitate check: served" tests="2" failures="1" errors="0" skipped="0"/);
      expect(xml).toMatch(/<testsuite name="imports" tests="2" failures="1" errors="0" skipped="0"/);
      expect(xml).toMatch(/<testcase classname="jevitate\.imports\.journey" name="imports-page" time="[\d.]+">\n\s+<properties>/);
      const journeyCase = /<testcase [^>]*name="imports-page"[^]*?<\/testcase>/.exec(xml)?.[0] ?? "";
      expect(journeyCase).not.toBe("");
      expect(journeyCase).not.toMatch(/<failure|<error|<skipped/);
      expect(xml).toMatch(/<testcase classname="jevitate\.imports\.mission\.feature" name="invariants" time="[\d.]+">[^]*?<failure message="1 gating finding\(s\): Invariant &quot;charge-implies-delivery&quot; violated on \/app" type="invariant">/);

      // Every result carries the engine and the target build; SARIF and the report were written.
      for (const p of r.results) {
        const raw = JSON.parse(await readFile(p, "utf8")) as { result: { targetBuild?: string; engine?: { version?: string } } };
        expect(raw.result.targetBuild).toBe("sha-abc");
        expect(typeof raw.result.engine?.version).toBe("string");
      }
      const sarif = JSON.parse(await readFile(join(out, "jevitate.sarif"), "utf8")) as { version: string; runs: Array<{ results: Array<{ level: string }> }> };
      expect(sarif.version).toBe("2.1.0");
      expect(sarif.runs[0]?.results.map((x) => x.level)).toEqual(["error"]);
      expect(await readFile(join(out, "report.md"), "utf8")).toContain("charge-implies-delivery");
    },
    240_000,
  );

  it(
    "#195: a per-item explore option takes effect — the same sweep with deny on Import passes where the open one fails",
    async () => {
      await writeFile(
        join(dir, "credits.json"),
        JSON.stringify({
          observe: {
            balance: { dom: { selector: "[data-testid=credit-balance]", number: true } },
            imports: { dom: { selector: "[data-testid=imports] li", read: "count" } },
          },
          invariants: [{ id: "charge-implies-delivery", require: "delta(balance) < 0 -> delta(imports) >= 1" }],
        }),
      );
      await writeFile(
        join(dir, "suite-deny.json"),
        JSON.stringify({
          version: 1,
          name: "deny",
          budget: { maxActions: 40, maxMinutes: 5 },
          targets: [
            {
              name: "imports",
              url: `${origin}/app2`,
              invariants: ["credits.json"],
              missions: [
                { name: "open", strategy: "feature", feature: "invariants" },
                { name: "guarded", strategy: "feature", feature: "invariants", deny: ["/^Import$/"] },
              ],
            },
          ],
        }),
      );
      const lines: string[] = [];
      const program = buildProgram({
        profiles: new ProfileManager("/unused"),
        journeysDir: join(dir, "journeys"),
        explore: { browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(dir, "no-targets.json") },
      });
      program.configureOutput({ writeOut: (s) => lines.push(s) });
      program.exitOverride();
      process.exitCode = undefined;
      await program.parseAsync(["check", "--suite", join(dir, "suite-deny.json"), "--out", join(dir, "out-deny"), "--json"], { from: "user" });
      process.exitCode = undefined;
      const env = JSON.parse(lines.join("")) as { ok: boolean; data: CheckResult };
      expect(env.ok).toBe(true);
      expect(env.data.items.map((i) => [i.name, i.verdict])).toEqual([
        ["open", "failed"],
        ["guarded", "passed"],
      ]);
      // The guarded run's safety policy refused Import by the item's own deny; it clicked Refresh only.
      type Step = { op: string | null; target: string; actOk: boolean; reason?: string };
      const transcripts = await Promise.all(
        env.data.results.map(async (p) => (JSON.parse(await readFile(p, "utf8")) as { result: { transcript: Step[] } }).result.transcript),
      );
      const open = transcripts[0] ?? [];
      const guarded = transcripts[1] ?? [];
      expect(open.some((s) => s.op === "click" && s.target === 'button "Import"' && s.actOk)).toBe(true);
      expect(guarded.some((s) => s.op === "click" && s.target === 'button "Import"')).toBe(false);
      expect(guarded.find((s) => s.target === 'button "Import"')?.reason).toBe('refused by the safety policy: "Import" matches --deny "/^Import$/"');
    },
    240_000,
  );
});
