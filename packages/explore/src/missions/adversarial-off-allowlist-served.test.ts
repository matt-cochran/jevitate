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
