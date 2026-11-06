import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import * as dataDir from "./data-dir.js";
import { buildProgram } from "./program.js";
import { planJourneyVerification } from "./journey-verify.js";

const roots: string[] = [];
afterEach(async () => { process.exitCode = undefined; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function policyJourney(site: string, id = "policy"): Journey {
  return { metadata: { id, name: "Policy", promoted: false, params: [], createdAtIso: "2026-11-06T00:00:00Z" }, recording: { version: "1", site, pages: [{ url: "/", steps: [
    { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { role: "button", name: "Save" } } } },
    { step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } }, delta: { verdict: "relevant-change", why: "queried", changes: ["status"], requests: ["POST /api/query → 200"], overheadMs: 1 } },
  ] }] } };
}
it("native plan uses configured read POST classification exactly like the planner", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-policy-cli-")); roots.push(root);
  const dir = join(root, "journeys"); const targets = join(root, "targets.json");
  await new FsJourneyStore(dir).put(policyJourney("http://localhost:3001"));
  await writeFile(targets, JSON.stringify({ "http://localhost:3001": { safety: { readRequests: ["/api/query"] } } }));
  const output: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager(join(root, "profiles")), journeysDir: dir, explore: { targetsConfigPath: targets } });
  program.configureOutput({ writeOut: (s) => output.push(s), writeErr: () => {} });
  await program.parseAsync(["journey", "verify", "policy", "--plan", "--json"], { from: "user" });
  const result = JSON.parse(output.join("")) as { data: { mutations: unknown[] } };
  expect(result.data.mutations).toEqual((await planJourneyVerification({ dir, id: "policy", readRequests: ["/api/query"] })).mutations);
});

it("malformed policy returns a typed native failure before replay or receipt replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-policy-invalid-")); roots.push(root);
  const dir = join(root, "journeys"); const targets = join(root, "targets.json");
  await new FsJourneyStore(dir).put(policyJourney("http://localhost:3001"));
  await writeFile(targets, "{");
  const proof = join(dir, ".verify", "policy.json");
  await mkdir(join(dir, ".verify"), { recursive: true });
  await writeFile(proof, "retained-proof-unchanged");
  for (const mode of ["--plan", "--mutate"]) {
    const output: string[] = [];
    const program = buildProgram({ profiles: new ProfileManager(join(root, "profiles")), journeysDir: dir, explore: { targetsConfigPath: targets, browserPortFactory: () => { throw new Error("browser must not open"); } } });
    program.configureOutput({ writeOut: (s) => output.push(s), writeErr: () => {} });
    await program.parseAsync(["journey", "verify", "policy", mode, "--json"], { from: "user" });
    expect(JSON.parse(output.join(""))).toMatchObject({ ok: false, error: { code: "E_TARGET_CONFIG" } });
    expect(await readFile(proof, "utf8")).toBe("retained-proof-unchanged");
  }
});

it("shared resolver snapshots recorded-origin policy without opening referenced sessions or merging aliases", async () => {
  const { journeyTargetSafety } = await import("./journey-target-policy.js");
  const root = await mkdtemp(join(tmpdir(), "jev-policy-resolver-")); roots.push(root);
  const targets = join(root, "targets.json");
  const source = policyJourney("http://localhost:3001");
  await writeFile(targets, JSON.stringify({
    "http://localhost:3001": { safety: { readRequests: ["/b", "/a", "/b"] }, storageState: "/nonexistent/session-never-opened.json" },
    "http://127.0.0.1:3001": { safety: { readRequests: ["/alias-only"] } },
    "http://localhost:4001": { safety: { readRequests: ["/destination-only"] } },
  }));
  const captured = journeyTargetSafety(source, targets)?.readRequests;
  expect(captured).toEqual(["/a", "/b"]);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(journeyTargetSafety(policyJourney("http://127.0.0.1:3001"), targets)?.readRequests).toEqual(["/alias-only"]);
  expect(journeyTargetSafety(policyJourney("http://unconfigured.test"), targets)).toBeUndefined();
  expect(journeyTargetSafety(source, join(root, "missing.json"))).toBeUndefined();
  expect(journeyTargetSafety(policyJourney("invalid-site"), targets)).toBeUndefined();
  await writeFile(targets, JSON.stringify({ "http://localhost:3001": { safety: { readRequests: ["/changed"] } } }));
  expect(captured).toEqual(["/a", "/b"]);
  expect(journeyTargetSafety(source, targets)?.readRequests).toEqual(["/changed"]);
});

it("default resolver uses the existing data-dir target file", async () => {
  const { journeyTargetSafety } = await import("./journey-target-policy.js");
  const root = await mkdtemp(join(tmpdir(), "jev-policy-default-")); roots.push(root);
  const targets = join(root, "targets.json");
  await writeFile(targets, JSON.stringify({ "http://localhost:3001": { safety: { readRequests: ["/default"] } } }));
  const seam = vi.spyOn(dataDir, "resolveDataDir").mockImplementation((segments) => join(root, ...segments));
  try { expect(journeyTargetSafety(policyJourney("http://localhost:3001"))?.readRequests).toEqual(["/default"]); }
  finally { seam.mockRestore(); }
});
