import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { verifyJourneyMutations } from "./journey-verify.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all" });
let server: Server;
let origin: string;
let dir: string;
let writes = 0;
const html = `<!doctype html><html><head><title>Threads</title></head><body><h1>Threads</h1>
<label>Thread <select aria-label="Thread"><option value="thread-001">One</option><option value="thread-002">Two</option></select></label>
<p id="status">thread-001</p><script>document.querySelector('select').addEventListener('change', e => { document.getElementById('status').textContent = e.target.value; fetch('/selected/' + e.target.value); });</script></body></html>`;
function journey(id: string, declared: boolean): Journey {
  return { metadata: { id, name: "Choose thread", params: ["threadId"], promoted: false, createdAtIso: "2026-10-26T00:00:00Z", mutationPairs: [{ check: "step-request:2:0", mustFailWhen: "swap-param:threadId" }], ...(declared ? { targetedProofs: [{ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step-request:2:0", "step:3"] }] } : {}), endState: [{ kind: "page", assertion: { kind: "valueEquals", target: { label: "Thread" }, value: { var: "threadId" } } }] }, recording: { version: "1", site: origin, pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { role: "heading", name: "Threads" } } } }, { step: { kind: "select", target: { label: "Thread" }, value: { var: "threadId" }, expect: { kind: "valueEquals", target: { label: "Thread" }, value: { var: "threadId" } } }, expectRequests: [{ kind: "requestMade", method: "GET", pathGlob: "/selected/thread-001" }] }, { step: { kind: "assert", check: { kind: "textIncludes", target: { css: "#status" }, text: "${threadId}" } } }] }] } };
}
beforeAll(async () => {
  server = createServer((req, res) => { if (req.method !== "GET") writes++; if (req.url?.startsWith("/selected/")) res.writeHead(200).end("ok"); else res.writeHead(200, { "content-type": "text/html" }).end(html); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; dir = await mkdtemp(join(tmpdir(), "jev-708-served-"));
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
describe("#708 declared request defense through actual Chromium", () => {
  it("keeps automatic refusal, then proves the cascade with a declared request relaxation and passing control", async () => {
    const store = new FsJourneyStore(dir);
    const verify = async (declared: boolean) => {
      const j = journey(declared ? "declared" : "automatic", declared); await store.put(j);
      return verifyJourneyMutations({ dir, id: j.metadata.id, params: { threadId: "thread-001" }, browserPortFactory: () => new PlaywrightBrowserPort() });
    };
    const automatic = await verify(false);
    expect(automatic.assertions.find((a) => a.site === "end-state:0")?.targetedRefusal, JSON.stringify(automatic)).toBe("step-request:2:0 is not a step postcondition");
    expect(automatic.suggestedTargetedProofs).toContainEqual({ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step-request:2:0"] });
    const declared = await verify(true);
    expect(declared.assertions.find((a) => a.site === "end-state:0")).toMatchObject({ verdict: "sensitive", declaredProof: true, relaxedSites: ["step-request:2:0", "step:3"] });
    expect(declared.verdict).toBe("proven");
    expect(declared.mutations.find((m) => m.id === "swap-param:threadId")?.targeted?.find((p) => p.site === "end-state:0")?.control).toBe("passed");
    expect(writes).toBe(0);
    expect((await store.get("declared"))?.recording.pages[0]!.steps[1]!.expectRequests).toHaveLength(1);
  }, 120_000);
});
