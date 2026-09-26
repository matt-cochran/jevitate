import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import type { BrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";

/**
 * #195 part 2 — `jevitate invariants validate <file…>`: the SAME loader/validator `explore
 * --invariants` runs before any browser opens, as its own browser-free command so CI can lint
 * committed invariant files. Invalid ⇒ non-zero exit, with the path-precise problems.
 */

const dir = mkdtempSync(join(tmpdir(), "jev-inv-validate-"));
function file(name: string, content: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
}

const GOOD = {
  observe: { balance: { dom: { selector: "[data-testid=credit-balance]", number: true } } },
  invariants: [
    { id: "balance-never-negative", require: "balance >= 0" },
    { id: "no-billing-403", never: { pageText: "/403 Forbidden/" } },
  ],
};
const WITH_PROBE = {
  observe: { imports: { probe: { get: "/v1/imports?limit=1", json: "$.total" } } },
  invariants: [{ id: "imports-ok", require: "imports >= 0" }],
};

function run(args: string[]): Promise<{ out: string; err: string; exitCode: number | undefined; opened: boolean }> {
  let opened = false;
  const port: BrowserPort = {
    async open() {
      opened = true;
      throw new Error("a validator must never open a browser");
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager("/unused-in-these-tests"), explore: { browserPortFactory: () => port } });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  process.exitCode = undefined;
  return program.parseAsync(["invariants", "validate", ...args], { from: "user" }).then(() => ({
    out: out.join(""),
    err: err.join(""),
    exitCode: process.exitCode as number | undefined,
    opened,
  }));
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("jevitate invariants validate (#195)", () => {
  it("passes a valid file (exit 0) without a browser", async () => {
    const r = await run([file("good.json", GOOD)]);
    expect(r.exitCode).toBe(0);
    expect(r.opened).toBe(false);
    expect(r.out).toMatch(/good\.json/);
    expect(r.out).toMatch(/2 invariants/);
  });

  it("refuses an invalid file with the loader's path-precise problems and a non-zero exit", async () => {
    const bad = file("typo.json", { ...GOOD, invariants: [{ id: "x", require: "delta(balanse) < 0" }, { id: "y", never: { responseStatus: 403 } }] });
    const r = await run([bad]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain('invariants[0].require: unknown observable "balanse"');
    expect(r.out).toMatch(/invariants\[1\]\.never/);
  });

  it("--json: an ok envelope carrying valid:false and every file's problems; exit 1", async () => {
    const good = file("g2.json", GOOD);
    const bad = file("b2.json", { invariants: [{ id: "x", require: "nope < 0" }] });
    const unreadable = file("u2.json", "{not json");
    const r = await run([good, bad, unreadable, "--json"]);
    expect(r.exitCode).toBe(1);
    const env = JSON.parse(r.out.trim()) as {
      v: number;
      ok: boolean;
      data: { valid: boolean; files: Array<{ file: string; valid: boolean; invariants?: number; problems: string[] }> };
    };
    expect(env.v).toBe(1);
    expect(env.ok).toBe(true);
    expect(env.data.valid).toBe(false);
    expect(env.data.files.map((f) => [f.file, f.valid])).toEqual([
      [good, true],
      [bad, false],
      [unreadable, false],
    ]);
    expect(env.data.files[0]?.invariants).toBe(2);
    expect(env.data.files[1]?.problems).toEqual(['invariants[0].require: unknown observable "nope"']);
    expect(env.data.files[2]?.problems[0]).toMatch(/cannot read invariants file/);
  });

  it("--json on valid files: valid:true, exit 0; files that conflict when merged are refused", async () => {
    const a = file("a3.json", GOOD);
    const ok = await run([a, "--json"]);
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.out.trim())).toMatchObject({ ok: true, data: { valid: true } });
    const dup = await run([a, a, "--json"]);
    expect(dup.exitCode).toBe(1);
    const env = JSON.parse(dup.out.trim()) as { data: { valid: boolean; merge: string[] } };
    expect(env.data.valid).toBe(false);
    expect(env.data.merge.join("\n")).toMatch(/repeats an earlier file/);
  });

  it("authorizes probe origins only against --url/--allow (never assumed)", async () => {
    const p = file("probe.json", WITH_PROBE);
    const none = await run([p]);
    expect(none.exitCode).toBe(1);
    expect(none.out).toMatch(/observe\.imports\.probe: .*authorized origins/);
    expect(none.out).toMatch(/--url/);
    const withUrl = await run([p, "--url", "http://127.0.0.1:3000/app"]);
    expect(withUrl.exitCode).toBe(0);
    const offOrigin = await run([file("evil.json", { ...WITH_PROBE, observe: { imports: { probe: { get: "http://evil.test/x" } } } }), "--url", "http://127.0.0.1:3000/app"]);
    expect(offOrigin.exitCode).toBe(1);
    expect(offOrigin.out).toMatch(/origin http:\/\/evil\.test is not an authorized origin/);
  });

  it("refuses --allow without --url (a usage error envelope)", async () => {
    const r = await run([file("g4.json", GOOD), "--allow", "http://127.0.0.1:3000", "--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.out.trim())).toMatchObject({ ok: false, error: { code: "E_INVARIANTS_ARGS" } });
  });
});
