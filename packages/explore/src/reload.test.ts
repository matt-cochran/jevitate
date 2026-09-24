import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { act, snapshot } from "./index.js";
import { withSession } from "./testkit.js";

/**
 * The `reload` op (#65): a real navigation to the same page. It discards unsaved edits, accepts a
 * `beforeunload` "leave the page?" prompt (and says so), and never throws.
 */

const PAGE = `<!doctype html><html><body>
  <form id="profile"><label>Name <input name="name" aria-label="Name" value="Ada" /></label>
  <button>Save</button></form>
  <a href="/elsewhere">Elsewhere</a>
  <script>
    let dirty = false;
    document.querySelector("input").addEventListener("input", () => { dirty = true; });
    window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
  </script>
</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("act — reload", () => {
  it(
    "reloads the page, discarding an unsaved edit, and reports the unsaved-changes prompt it accepted",
    async () => {
      await withSession(
        "explore-act-reload-",
        async (session) => {
          await session.page.goto(`${origin}/profile`);
          const actor = CastActor.named("act").whoCan(new BrowseTheWeb(session, [origin]));
          const snap = await snapshot(session.page);
          const name = snap.controls.find((c) => c.name === "Name");
          if (name === undefined) throw new Error("no Name field");
          expect((await act(actor, { op: "type", control: name, value: "Grace" })).ok).toBe(true);

          const r = await act(actor, { op: "reload", control: null });
          expect(r.ok).toBe(true);
          expect(r.mutated).toBe(true);
          expect(r.note).toContain("unsaved changes");
          await session.page.waitForLoadState("domcontentloaded");
          expect(await session.page.getByLabel("Name").inputValue()).toBe("Ada");
        },
        origin,
      );
    },
    120_000,
  );

  it(
    "a clean page reloads without a prompt note",
    async () => {
      await withSession(
        "explore-act-reload-clean-",
        async (session) => {
          await session.page.goto(`${origin}/profile`);
          const actor = CastActor.named("act").whoCan(new BrowseTheWeb(session, [origin]));
          const r = await act(actor, { op: "reload", control: null });
          expect(r).toEqual({ ok: true, mutated: true });
        },
        origin,
      );
    },
    120_000,
  );
});

describe("snapshot — form membership, submit controls and link destinations", () => {
  it(
    "keys controls by their form, marks the submit button, and resolves a link's href",
    async () => {
      await withSession(
        "explore-snapshot-form-",
        async (session) => {
          await session.page.goto(`${origin}/profile`);
          const snap = await snapshot(session.page);
          const byName = (n: string) => snap.controls.find((c) => c.name === n);
          expect(byName("Name")?.form).toBe("form#profile");
          expect(byName("Save")?.form).toBe("form#profile");
          expect(byName("Save")?.submits).toBe(true);
          expect(byName("Name")?.submits).toBe(false);
          expect(byName("Elsewhere")?.form).toBeNull();
          expect(byName("Elsewhere")?.href).toBe(`${origin}/elsewhere`);
        },
        origin,
      );
    },
    120_000,
  );
});
