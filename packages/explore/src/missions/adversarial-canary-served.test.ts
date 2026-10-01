import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission, type AdversarialMissionParams, type AdversarialOutcome } from "./adversarial.js";
import type { MisuseStrategy } from "../adversarial/misuse.js";
import { withSession } from "../testkit.js";

/**
 * #301 — the inert markup canary: a comment form that renders submitted comments with innerHTML
 * (unescaped) must surface a stored `markup-injection` defect; the same form rendering with
 * textContent (escaped) must not.
 */

const state = { unsafe: [] as string[], safe: [] as string[] };

const COMMENTS = (kind: "unsafe" | "safe"): string => `<!doctype html><html><body>
  <h1>Comments</h1>
  <ul id="list"></ul>
  <form id="f">
    <label>Comment <textarea name="comment" aria-label="Comment"></textarea></label>
    <button type="submit">Post comment</button>
  </form>
  <script>
    async function render() {
      const items = await (await fetch('/api/${kind}/comments')).json();
      const list = document.getElementById('list');
      list.textContent = '';
      for (const c of items) {
        ${
          kind === "unsafe"
            ? "list.insertAdjacentHTML('beforeend', '<li title=\"' + c + '\">' + c + '</li>');"
            : "const li = document.createElement('li'); li.title = c; li.textContent = c; list.appendChild(li);"
        }
      }
    }
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const ta = document.querySelector('textarea');
      await fetch('/api/${kind}/comments', { method: 'POST', body: ta.value });
      ta.value = '';
      await render();
    });
    render();
  </script>
</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const html = (body: string): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    };
    const m = /^\/api\/(unsafe|safe)\/comments$/.exec(path);
    if (m !== null) {
      const list = m[1] === "unsafe" ? state.unsafe : state.safe;
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString("utf8")));
        req.on("end", () => {
          if (body.trim() !== "" && body.length < 10_000) list.push(body);
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(list));
      return;
    }
    if (path === "/comments/unsafe") return html(COMMENTS("unsafe"));
    if (path === "/comments/safe") return html(COMMENTS("safe"));
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function hunt(
  seedPath: string,
  strategies: readonly MisuseStrategy[],
  extra: Partial<AdversarialMissionParams> = {},
): Promise<AdversarialOutcome> {
  return withSession(
    "adv-301-",
    async (session) => {
      const actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin]));
      return runAdversarialMission({
        page: session.page,
        actor,
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
        generation: new FakeGenerationGateway(),
        seedUrl: `${origin}${seedPath}`,
        allowlist: [origin],
        strategies,
        ...extra,
      });
    },
    origin,
  );
}

describe("#301 — the inert markup canary", () => {
  it(
    "finds a stored markup-injection on a page that renders comments unescaped (innerHTML)",
    async () => {
      state.unsafe = [];
      const result = await hunt("/comments/unsafe", ["boundary-submit"], { bounds: { maxDecisions: 5 } });
      expect(result.outcome).toBe("defects-found");
      const found = result.defects.filter((d) => d.kind === "markup-injection");
      expect(found.map((d) => d.markupInjection?.payload).sort()).toEqual(["attribute", "html"]);
      for (const d of found) {
        expect(d.markupInjection?.field).toBe("Comment");
        expect(d.markupInjection?.afterSubmit).toBe(true);
        expect(d.markupInjection?.afterReload).toBe(true);
        expect(d.markupInjection?.stored).toBe(true);
        expect(d.title).toMatch(/rendered as markup .* — stored/);
      }
      // The payloads stayed inert: what the app stored is the canary, never anything executable.
      for (const c of state.unsafe) expect(c).not.toMatch(/<script|\son\w+\s*=|javascript:/i);
    },
    180_000,
  );

  it(
    "finds nothing on the same form when it escapes the comment (textContent)",
    async () => {
      state.safe = [];
      const result = await hunt("/comments/safe", ["boundary-submit"], { bounds: { maxDecisions: 5 } });
      expect(result.defects.filter((d) => d.kind === "markup-injection")).toEqual([]);
      // The canaries really were submitted (and shown as text), and checked after a reload.
      expect(state.safe.some((c) => c.includes("data-jev-canary"))).toBe(true);
      const checks = result.transcript.filter((e) => e.strategy === "canary-check");
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.every((e) => /not rendered as markup/.test(e.reason ?? ""))).toBe(true);
    },
    180_000,
  );
});
