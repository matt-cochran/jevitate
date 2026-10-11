import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission } from "./adversarial.js";
import { withSession, useSkippingTime } from "../testkit.js";

useSkippingTime({ per: "all" });

/**
 * #403 — `--allow` is the only origin an adversarial run may WRITE to. A form whose submit posts
 * somewhere else (a fetch, or a native form action) would carry the run's misuse values to an origin
 * the operator never authorized: that write is aborted in the browser, recorded as blocked (its origin
 * named, and how to allow it) — never as a defect of the app. Reads from that origin (a CDN script)
 * stay unblocked.
 */

/** What the off-allowlist origin received. */
let received: Array<{ method: string; path: string }> = [];
let elsewhere: Server;
let other: string;
let app: Server;
let origin: string;

const FETCH_FORM = (): string => `<!doctype html><html><body><h1>Contact us</h1>
  <script src="${other}/lib.js"></script>
  <form id="contact">
    <label>Message <input name="message" aria-label="Message" value="hello"></label>
    <button type="submit">Send</button>
  </form>
  <p role="status" data-testid="status"></p>
  <script>
    document.getElementById("contact").addEventListener("submit", async (e) => {
      e.preventDefault();
      const res = await fetch("${other}/collect", { method: "POST", headers: { "content-type": "text/plain" }, body: new FormData(e.target).get("message") });
      document.querySelector("[data-testid=status]").textContent = res.ok ? "Sent" : "Try again";
    });
  </script>
</body></html>`;

const NATIVE_FORM = (): string => `<!doctype html><html><body><h1>Feedback</h1>
  <form method="post" action="${other}/feedback">
    <label>Comment <input name="comment" aria-label="Comment" value="fine"></label>
    <button type="submit">Save</button>
  </form>
</body></html>`;

/** #484: an upload whose busy indicator only clears when the (off-allowlist) request answers. */
const UPLOAD_FORM = (): string => `<!doctype html><html><body><h1>Upload</h1>
  <form id="upload">
    <label>Name <input name="name" aria-label="Name" value="report.pdf"></label>
    <button type="submit">Upload</button>
  </form>
  <div id="busy"></div>
  <script>
    document.getElementById("upload").addEventListener("submit", async (e) => {
      e.preventDefault();
      document.getElementById("busy").innerHTML = '<div role="progressbar" aria-label="Uploading" style="width:20px;height:20px"></div>';
      await fetch("${other}/upload", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }).then(() => {
        document.getElementById("busy").innerHTML = "";
      }, () => undefined);
    });
  </script>
</body></html>`;

/** #484: a page that reports the (blocked) send in its own words, naming the path — a consequence, not a defect. */
const NOTIFY_FORM = (): string => `<!doctype html><html><body><h1>Notify</h1>
  <form id="notify">
    <label>Message <input name="message" aria-label="Message" value="hello"></label>
    <button type="submit">Notify</button>
  </form>
  <script>
    document.getElementById("notify").addEventListener("submit", async (e) => {
      e.preventDefault();
      await fetch("${other}/collect", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }).catch(() => {
        console.error("message never delivered to ${other}/collect");
      });
    });
  </script>
</body></html>`;

beforeAll(async () => {
  elsewhere = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    received.push({ method: req.method ?? "", path });
    req.resume();
    if (path === "/lib.js") {
      res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" }).end("window.libLoaded = true;");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("ok");
  });
  await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
  // `localhost` vs `127.0.0.1`: a different origin AND a different site from the app.
  other = `http://localhost:${(elsewhere.address() as AddressInfo).port}`;
  app = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/contact") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FETCH_FORM());
      return;
    }
    if (path === "/notify") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(NOTIFY_FORM());
      return;
    }
    if (path === "/upload") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(UPLOAD_FORM());
      return;
    }
    if (path === "/feedback") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(NATIVE_FORM());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
});
beforeEach(() => {
  received = [];
});

const run = (path: string, allowWriteRequests?: string[]) =>
  withSession(
    "adv-offallow-",
    async (session) =>
      runAdversarialMission({
        page: session.page,
        actor: CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin])),
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
        generation: new FakeGenerationGateway(),
        seedUrl: `${origin}${path}`,
        allowlist: [origin],
        bounds: { maxDecisions: 3 },
        strategies: ["boundary-submit"],
        ...(allowWriteRequests === undefined ? {} : { safety: { allowWriteRequests } }),
      }),
    origin,
  );

describe("adversarial: misuse writes never leave for an origin outside --allow (#403)", () => {
  it(
    "a fetch POST to another origin is aborted and recorded as blocked; that origin's script still loads",
    async () => {
      const r = await run("/contact");
      expect(received.filter((x) => x.method === "POST")).toEqual([]);
      expect(received).toContainEqual({ method: "GET", path: "/lib.js" });
      const blocked = r.blockedWrites ?? [];
      expect(blocked.length).toBeGreaterThan(0);
      expect(blocked[0]).toMatchObject({ method: "POST", path: `${other}/collect` });
      expect(blocked[0]?.hint).toContain(`${other} is not an --allow origin`);
      expect(blocked[0]?.hint).toContain(`--allow-write "${other}/<path glob>"`);
      // jevitate's own refusal: never a defect of the app (no failed request, no "Failed to fetch").
      expect(r.defects).toEqual([]);
      const step = r.transcript.find((e) => e.op === "click" && /blocked write/.test(e.reason ?? ""));
      expect(step?.reason).toContain(`POST ${other}/collect`);
    },
    180_000,
  );

  it(
    "a native form POST to another origin never reaches it, and the page stays put",
    async () => {
      const r = await run("/feedback");
      expect(received.filter((x) => x.method === "POST")).toEqual([]);
      expect((r.blockedWrites ?? []).map((b) => `${b.method} ${b.path}`)).toContain(`POST ${other}/feedback`);
      expect(r.defects).toEqual([]);
    },
    180_000,
  );

  it(
    "an origin-qualified --allow-write lets that write through",
    async () => {
      const r = await run("/contact", [`${other}/collect`]);
      expect(received.filter((x) => x.method === "POST").length).toBeGreaterThan(0);
      expect(r.blockedWrites).toBeUndefined();
    },
    180_000,
  );
});

describe("adversarial: a write jevitate blocked is an environment fault, never an app defect (#484)", () => {
  it(
    "warns that the blocked loopback origin is a port --allow does not include",
    async () => {
      const r = await run("/contact");
      expect(r.blockedWrites?.[0]?.allowMismatch?.blockedOrigin).toBe(other);
    },
    180_000,
  );

  it(
    "lists each blocked write under environment faults",
    async () => {
      const r = await run("/contact");
      expect(r.environmentFaults?.causes[0]?.message).toContain(`POST ${other}/collect: not an --allow origin, never sent`);
    },
    180_000,
  );

  it(
    "links a busy indicator the blocked upload left spinning to that write instead of reporting a hang",
    async () => {
      const r = await run("/upload");
      expect({ hangs: r.hangs.length, causedBy: r.blockedConsequences?.map((c) => `${c.kind} ${c.causedBy.write}`) }).toEqual({
        hangs: 0,
        causedBy: [`hang:ui-no-progress POST ${other}/upload`],
      });
    },
    180_000,
  );

  it(
    "the transcript reads a finding the blocked write caused as an environment fault, never a defect",
    async () => {
      const r = await run("/notify");
      const step = r.transcript.find((e) => (e.reason ?? "").includes(`never delivered to ${other}/collect`));
      expect(step?.reason).toContain(`environment fault (caused by a blocked write, never sent): message never delivered to ${other}/collect`);
    },
    180_000,
  );
});
