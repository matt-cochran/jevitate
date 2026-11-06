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
it("native mutate keeps recorded-origin policy when rebased and immediately reviews fresh", async () => {
  const source = journey();
  source.recording.site = "http://localhost:3001";
  await new FsJourneyStore(join(root, "journeys")).put(source);
  await writeFile(join(root, "targets.json"), JSON.stringify({
    "http://localhost:3001": { safety: { readRequests: ["/api/query"] } },
    [origin]: { safety: { readRequests: ["/destination-only"] } },
  }));
  const output: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager(join(root, "profiles")), journeysDir: join(root, "journeys"), dbPath: join(root, "policy.sqlite"), explore: { targetsConfigPath: join(root, "targets.json"), browserPortFactory: () => new PlaywrightBrowserPort() } });
  program.configureOutput({ writeOut: (s) => output.push(s), writeErr: () => {} });
  process.exitCode = undefined;
  try { await program.parseAsync(["journey", "verify", "mixed", "--mutate", "--base-url", origin, "--json"], { from: "user" }); } finally { process.exitCode = undefined; }
  expect(JSON.parse(output.join(""))).toMatchObject({ ok: true });
  const { review } = await reviewJourneyById(join(root, "journeys"), "mixed", { targetsFile: join(root, "targets.json"), catalogDir: null });
  expect(review.proof.verify).toMatchObject({ stale: false });
  expect((await readVerifyRecord(join(root, "journeys"), "mixed"))?.proofContext).toEqual({ readRequests: ["/api/query"] });
});
