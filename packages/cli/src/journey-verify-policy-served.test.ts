import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { runJourneyProgrammatically } from "./journey-api.js";
import { readVerifyRecord } from "./journey-review-store.js";
import { reviewJourneyById } from "./journey-review-api.js";
import { currentJourneyProof } from "./journey-proof-context.js";
import { useSkippingTime } from "../../explore/src/testkit.js";
useSkippingTime({ per: "all" });
let server: Server;
let origin: string;
let root: string;
let queries = 0;
let saves = 0;
function journey(): Journey {
  return { metadata: { id: "mixed", name: "Mixed", promoted: false, params: [], createdAtIso: "2026-11-06T00:00:00Z" }, recording: { version: "1", site: origin, pages: [{ url: "/", steps: [
    { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { role: "button", name: "Save" } } } },
    { step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } }, delta: { verdict: "relevant-change", why: "saved", changes: ["status"], requests: ["POST /api/query → 200", "POST /api/save → 200"], overheadMs: 1 } },
  ] }] } };
}
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") { if (req.url === "/api/query") queries++; if (req.url === "/api/save") saves++; res.writeHead(200).end("{}"); return; }
    res.writeHead(200, { "content-type": "text/html" }).end(`<button>Save</button><p data-testid="status">Ready</p><script>document.querySelector('button').onclick=async()=>{try{await fetch('/api/query',{method:'POST'});const r=await fetch('/api/save',{method:'POST'});if(r.ok)document.querySelector('p').textContent='Saved'}catch{}}</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), "jev-policy-served-"));
  await new FsJourneyStore(join(root, "journeys")).put(journey());
  await writeFile(join(root, "targets.json"), JSON.stringify({ [origin]: { safety: { readRequests: ["/api/query"] } } }));
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
it("block-write lets the declared read prerequisite reach the server and aborts only the save", async () => {
  queries = 0; saves = 0;
  const result = await runJourneyProgrammatically({ dir: join(root, "journeys"), id: "mixed", params: {}, browserPortFactory: () => new PlaywrightBrowserPort() }, { blockWritesAtStep: 1, structuredFailures: true, readRequests: ["/api/query"] });
  expect(queries).toBe(1);
  expect(saves).toBe(0);
  expect(result).toMatchObject({ outcome: "quarantined", at: 1, failurePhase: "postcondition" });
  expect(result.blockedWrites).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/api/save" })]));
});
// Independent check M5: a receipt is bound to the target origin it ran on. `journey review --base-url` judges
// the proof for that same target (fresh at once); with no environment it judges the recorded site
// (localhost:3001), where a proof rebased elsewhere rightly reads stale, cause `target`.
it("native mutate keeps recorded-origin policy when rebased, and `journey review --base-url` the same origin reviews fresh", async () => {
  const source = journey();
  source.recording.site = "http://localhost:3001";
  await new FsJourneyStore(join(root, "journeys")).put(source);
  await writeFile(join(root, "targets.json"), JSON.stringify({
    "http://localhost:3001": { safety: { readRequests: ["/api/query"] } },
    [origin]: { safety: { readRequests: ["/destination-only"] } },
  }));
  const deps = { profiles: new ProfileManager(join(root, "profiles")), journeysDir: join(root, "journeys"), dbPath: join(root, "policy.sqlite"), explore: { targetsConfigPath: join(root, "targets.json"), browserPortFactory: () => new PlaywrightBrowserPort() } };
  const run = async (args: string[]): Promise<unknown> => {
    const output: string[] = [];
    const program = buildProgram(deps);
    program.configureOutput({ writeOut: (s) => output.push(s), writeErr: () => {} });
    process.exitCode = undefined;
    try { await program.parseAsync(args, { from: "user" }); } finally { process.exitCode = undefined; }
    return JSON.parse(output.join(""));
  };
  expect(await run(["journey", "verify", "mixed", "--mutate", "--base-url", origin, "--json"])).toMatchObject({ ok: true });
  expect((await readVerifyRecord(join(root, "journeys"), "mixed"))?.proofContext).toEqual({ readRequests: ["/api/query"] });
  const reviewed = (await run(["journey", "review", "mixed", "--base-url", origin, "--json"])) as { ok: boolean; data: { proof: { verify: unknown } } };
  expect(reviewed.ok).toBe(true);
  expect(reviewed.data.proof.verify).toMatchObject({ stale: false });
});

it("with no environment, review judges the recorded site: the rebased proof reads stale, cause target (M5)", async () => {
  const { review } = await reviewJourneyById(join(root, "journeys"), "mixed", { targetsFile: join(root, "targets.json"), catalogDir: null });
  expect(review.proof.verify).toMatchObject({ stale: true, staleCause: "target" });
  const record = await readVerifyRecord(join(root, "journeys"), "mixed");
  expect(record?.target).toEqual({ origin });
  const stored = (await new FsJourneyStore(join(root, "journeys")).get("mixed"))!;
  expect(currentJourneyProof(stored, record!, ["/api/query"], { origin })).toBe(true);
  expect(currentJourneyProof(stored, record!, ["/api/query"], { origin: "http://localhost:3001" })).toBe(false);
  // The API's own seam gives the same answer as `--base-url`.
  expect((await reviewJourneyById(join(root, "journeys"), "mixed", { targetsFile: join(root, "targets.json"), catalogDir: null, proofOrigin: origin })).review.proof.verify).toMatchObject({ stale: false });
});
