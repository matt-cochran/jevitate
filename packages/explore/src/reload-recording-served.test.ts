import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore } from "./explore.js";
import { PreferenceJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #754: a goal run's reload — the #303 persistence re-check after a write, or the model's reload op —
 * is recorded as the `reload` Step (replayed as `page.reload()` of the LIVE URL), never a `navigate`
 * to the query-free pathname.
 *
 * The fixture's Create button POSTs, gets a fresh server-generated id per call, and client-side-routes
 * to `?id=<id>`; a full load of `/item?id=<id>` renders the same edit form. Replaying the recording
 * therefore creates a DIFFERENT id, and the step after the reload still finds that new edit form.
 */

const EDIT = (id: string): string =>
  `<h1>Edit ${id}</h1><label>Title <input aria-label="Title" /></label><button type="button">Save</button>`;
const LIST = `<!doctype html><html><head><title>Items</title></head><body><main><h1>Items</h1><button id="create">Create</button></main><script>
  document.getElementById("create").onclick = async () => {
    const r = await fetch("/api/items", { method: "POST" });
    const { id } = await r.json();
    history.pushState({}, "", "/item?id=" + id);
    document.querySelector("main").innerHTML = '<h1>Edit ' + id + '</h1><label>Title <input aria-label="Title" /></label><button type="button">Save</button>';
  };
</script></body></html>`;

let server: Server;
let origin: string;
/** Every server-generated id, in creation order: the authoring run's then the replay's. */
const created: string[] = [];

let authoring: Awaited<ReturnType<typeof explore>>;
let replayOutcome: string;
let replayUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/api/items" && req.method === "POST") {
      const id = `gen-${created.length + 1}`;
      created.push(id);
      return void res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id }));
    }
    if (url.startsWith("/item")) {
      const id = new URLSearchParams(url.split("?")[1] ?? "").get("id") ?? "";
      return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>Items</title></head><body><main>${EDIT(id)}</main></body></html>`);
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(LIST);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  authoring = await withSession(
    "reload-record-author-",
    (session) =>
      explore({
        actor: CastActor.named("author").whoCan(new BrowseTheWeb(session, [origin])),
        judge: new PreferenceJudge((n) => (n === 0 ? [{ op: "click", name: "Create" }] : n === 1 ? [{ op: "click", name: "Save" }] : [])),
        gen: new FakeGenerationGateway(),
        goal: "create an item and save its title",
        allowlist: [origin],
        startUrl: `${origin}/`,
        bounds: { maxDecisions: 4 },
        actionDeltas: { volatilityGapMs: 300 },
      }),
    origin,
  );

  ({ outcome: replayOutcome, url: replayUrl } = await withSession(
    "reload-record-replay-",
    async (fresh) => {
      const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(fresh, [origin]));
      const result = await new RecordingInterpreter().run(actor, authoring.recording);
      return { outcome: result.outcome, url: fresh.page.url() };
    },
    origin,
  ));
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("#754 — goal-run reloads are recorded as `reload` and replay the live URL (served)", () => {
  const steps = (): string[] => authoring.recording.pages.flatMap((p) => p.steps.map((s) => s.step.kind));

  it("records the persistence re-check after the create click as a `reload` step, never a `navigate`", () => {
    expect(steps()).toEqual(["navigate", "click", "reload", "click"]);
  });

  it("records page URLs and step postconditions with no generated id", () => {
    const { pages } = authoring.recording;
    const postconditions = pages.flatMap((p) => p.steps.flatMap((s) => ("expect" in s.step ? [s.step.expect] : [])));
    expect(JSON.stringify({ urls: pages.map((p) => p.url), postconditions })).not.toContain(created[0]!);
  });

  it("replays the recorded create/reload/save journey to completion", () => {
    expect(replayOutcome).toBe("completed");
  });

  it("replays the reload against the replay's own freshly created id", () => {
    expect(replayUrl).toContain(created[1]!);
  });
});
