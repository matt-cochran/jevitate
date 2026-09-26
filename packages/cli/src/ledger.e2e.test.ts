import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";

/**
 * #195 part 6 — verify-fix from a fingerprint alone. A served page violates a declared invariant
 * (Import spends credits without delivering an import). A real-Chromium run finds the defect →
 * `ledger add` stores its repro material in the committed regressions store → the run's whole
 * output (result file, Recordings, transcript) is deleted → `ledger verify` and `verify-fix <fp>`
 * still reproduce it from the ledger → once the page is fixed, both report `fixed`. The entry never
 * holds the session the run used.
 */

const page = (fixed: boolean): string => `<!doctype html><html><body><main data-testid="app-shell">
  <h1>Imports</h1>
  <p>Credits: <span data-testid="credit-balance">1,000</span></p>
  <ul data-testid="imports"></ul>
  <button type="button" id="imp">Import</button>
  <script>
    let bal = 1000;
    document.getElementById("imp").onclick = () => {
      bal -= 40;
      document.querySelector("[data-testid=credit-balance]").textContent = bal.toLocaleString("en-US");
      ${fixed ? `const li = document.createElement("li"); li.textContent = "import"; document.querySelector("[data-testid=imports]").appendChild(li);` : ""}
    };
  </script></main></body></html>`;

const SESSION_COOKIE = "sess_LEDGER_E2E_DO_NOT_STORE";

let server: Server;
let origin: string;
let dir: string;
let fixed = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/app") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(fixed));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-ledger-e2e-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

/** Runs one CLI command; returns its JSON envelope and exit code. */
async function cli(args: string[]): Promise<{ env: { ok: boolean; data?: any; error?: { code: string; message: string } }; exitCode: number | undefined }> {
  const lines: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(dir, "no-targets.json") },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return { env: JSON.parse(lines.join("")), exitCode };
}

describe("jevitate ledger (#195 part 6, served fixture)", () => {
  it(
    "a defect added to the ledger is re-verified from its fingerprint alone after the run's output is gone, and passes once fixed",
    async () => {
      const invariants = join(dir, "credits.json");
      await writeFile(
        invariants,
        JSON.stringify({
          observe: {
            balance: { dom: { selector: "[data-testid=credit-balance]", number: true } },
            imports: { dom: { selector: "[data-testid=imports] li", read: "count" } },
          },
          invariants: [{ id: "charge-implies-delivery", require: "delta(balance) < 0 -> delta(imports) >= 1" }],
        }),
      );
      const storageState = join(dir, "session.storage-state.json");
      await writeFile(
        storageState,
        JSON.stringify({
          cookies: [{ name: "sid", value: SESSION_COOKIE, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }],
          origins: [],
        }),
      );
      const runOut = join(dir, "run");
      const regressions = join(dir, "repo", ".jevitate", "regressions");

      // 1. A real run finds the defect.
      const run = await cli([
        "explore",
        "--url",
        `${origin}/app`,
        "--feature",
        "import",
        "--route",
        "/app",
        "--allow",
        origin,
        "--invariants",
        invariants,
        "--storage-state",
        storageState,
        "--max-actions",
        "3",
        "--out",
        runOut,
        "--json",
      ]);
      expect(run.env.ok, JSON.stringify(run.env)).toBe(true);
      expect(run.env.data.missionOutcome).toBe("defects-found");
      const defect = (run.env.data.defects as Array<{ kind: string; fingerprint: string }>).find((d) => d.kind === "invariant");
      expect(defect).toBeDefined();
      const fp = defect!.fingerprint;
      const resultPath = run.env.data.resultPath as string;

      // A secret named by the caller that appears in the material refuses the add (fail closed).
      const refused = await cli(["ledger", "add", resultPath, fp, "--dir", regressions, "--secret", "charge-implies-delivery", "--json"]);
      expect(refused.env.ok).toBe(false);
      expect(refused.env.error?.code).toBe("E_LEDGER_SECRET");
      expect(existsSync(join(regressions, "ledger", `${fp}.json`))).toBe(false);

      // 2. ledger add: the repro material lands in the committed regressions store, keyed by fingerprint.
      const added = await cli(["ledger", "add", resultPath, fp, "--ticket", "JEV-195", "--dir", regressions, "--json"]);
      expect(added.env.ok, JSON.stringify(added.env)).toBe(true);
      expect(added.env.data).toMatchObject({ fingerprint: fp, kind: "invariant", ticket: "JEV-195", updated: false });
      const entryPath = join(regressions, "ledger", `${fp}.json`);
      expect(added.env.data.entryPath).toBe(entryPath);
      const entryText = readFileSync(entryPath, "utf8");
      // Never the session: not its contents, not even its path.
      expect(entryText).not.toContain(SESSION_COOKIE);
      expect(entryText).not.toContain(storageState);
      expect(entryText).not.toContain("storageStatePath");
      expect(entryText).not.toContain('"transcript"');

      const listed = await cli(["ledger", "list", "--dir", regressions, "--json"]);
      expect(listed.env.data.entries.map((e: { fingerprint: string; ticket: string }) => [e.fingerprint, e.ticket])).toEqual([[fp, "JEV-195"]]);

      // 3. The run's output is gone (retention pruned it, or it was never kept).
      await rm(runOut, { recursive: true, force: true });
      expect(existsSync(resultPath)).toBe(false);

      // 4. Still broken: both reproduce it from the ledger alone.
      const stillBroken = await cli(["ledger", "verify", "--dir", regressions, "--replays", "1", "--json"]);
      expect(stillBroken.env.ok, JSON.stringify(stillBroken.env)).toBe(true);
      expect(stillBroken.env.data.entries.map((e: { verdict: string }) => e.verdict)).toEqual(["still-reproduces"]);
      expect(stillBroken.exitCode).toBe(1);
      const vfBroken = await cli(["verify-fix", fp, "--regressions-dir", regressions, "--replays", "1", "--json"]);
      expect(vfBroken.env.ok, JSON.stringify(vfBroken.env)).toBe(true);
      expect(vfBroken.env.data.verdict).toBe("still-reproduces");
      expect(vfBroken.exitCode).toBe(1);

      // 5. The fix ships: both now pass, still from the fingerprint alone.
      fixed = true;
      const vfFixed = await cli(["verify-fix", "--fingerprint", fp, "--regressions-dir", regressions, "--replays", "2", "--json"]);
      expect(vfFixed.env.ok, JSON.stringify(vfFixed.env)).toBe(true);
      expect(vfFixed.env.data.verdict).toBe("fixed");
      expect(vfFixed.exitCode).toBe(0);
      const ledgerFixed = await cli(["ledger", "verify", "--ticket", "JEV-195", "--dir", regressions, "--replays", "2", "--json"]);
      expect(ledgerFixed.env.data.entries.map((e: { verdict: string }) => e.verdict)).toEqual(["fixed"]);
      expect(ledgerFixed.env.data.summary).toMatchObject({ fixed: 1, "still-reproduces": 0 });
      expect(ledgerFixed.exitCode ?? 0).toBe(0);
    },
    300_000,
  );

  it("verify-fix with neither --result nor a ledger entry is an input error naming the fix", async () => {
    const r = await cli(["verify-fix", "--fingerprint", "0123456789abcdef", "--regressions-dir", join(dir, "empty"), "--json"]);
    expect(r.env.ok).toBe(false);
    expect(r.env.error?.code).toBe("E_LEDGER_NOT_FOUND");
    expect(r.env.error?.message).toMatch(/jevitate ledger add/);
    expect(r.exitCode).toBe(2);
  });
});
