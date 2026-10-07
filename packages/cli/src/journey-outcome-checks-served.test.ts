import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { NetworkCheck, OutcomeCheck } from "@jevitate/recording";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #400 — a Journey's end-state assertions (`metadata.endState`: every success-check kind) and a
 * step's `expectRequests` are judged by `journey run` with the goal run's own evaluator: page checks
 * on the final page, `reloadThen` after one reload, network checks over the replay's own requests
 * (a step's from the moment that step began).
 */

let saved = "draft";
const page = (): string => `<!doctype html><html><head><title>Editor</title></head><body><main data-saved="no">
  <h1>Editor</h1>
  <p id="live">Live: ${saved}</p>
  <label>Title <input aria-label="Title" value=""></label>
  <button type="button" id="save">Save</button>
  <button type="button" id="preview">Preview</button>
  <button type="button" id="noop">Nothing</button>
  <p role="status" id="status"></p>
  <ul><li>a</li><li>b</li></ul>
  <script>
    const submit = (path) => {
      const v = document.querySelector('input').value;
      fetch(path, { method: 'POST', body: v }).then(() => {
        const s = document.getElementById('status');
        s.textContent = 'Saved: ' + v;
        s.classList.add('flash');
        setTimeout(() => s.classList.remove('flash'), 300);
        document.querySelector('main').setAttribute('data-saved', 'yes');
      });
    };
    document.getElementById('save').onclick = () => submit('/api/save');
    document.getElementById('preview').onclick = () => submit('/api/preview');
  </script>
</main></body></html>`;

let server: Server;
let origin: string;
let dir: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        if (req.url === "/api/save") saved = body;
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-outcome-"));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function journey(id: string, o: { button: string; text: string; endState?: OutcomeCheck[]; stepRequests?: NetworkCheck[] }): Journey {
  return {
    metadata: {
      id,
      name: "Edit and save",
      promoted: false,
      params: [],
      createdAtIso: "2026-10-07T00:00:00.000Z",
      ...(o.endState === undefined ? {} : { endState: o.endState }),
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/app",
          steps: [
            { step: { kind: "navigate", url: "/app", expect: { kind: "visible", target: { role: "heading", name: "Editor" } } } },
            { step: { kind: "fill", target: { label: "Title" }, value: { redacted: false, value: o.text }, expect: { kind: "valueEquals", target: { label: "Title" }, value: o.text } } },
            {
              step: { kind: "click", target: { role: "button", name: o.button }, expect: { kind: "count", target: { role: "button", name: o.button }, min: 0 } },
              ...(o.stepRequests === undefined ? {} : { expectRequests: o.stepRequests }),
            },
          ],
        },
      ],
    },
  };
}

async function cli(journeysDir: string, args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
    dbPath: join(dir, "no-site-policy.sqlite"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort() },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: () => undefined });
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), exitCode };
}

async function run(j: Journey): Promise<{ exitCode: number | undefined; data: { outcome: string; reason?: string } }> {
  const journeysDir = join(dir, j.metadata.id);
  await new FsJourneyStore(journeysDir).put(j);
  const r = await cli(journeysDir, ["journey", "run", j.metadata.id, "--json"]);
  return { exitCode: r.exitCode, data: (JSON.parse(r.out) as { data: { outcome: string; reason?: string } }).data };
}

const status2xx: NetworkCheck = { kind: "responseStatus", method: "POST", pathGlob: "/api/save", status: { class: 2 } };

describe("journey run judges a Journey's end state and step request expectations (#400, served)", () => {
  it("every success-check kind holds after a persisted save: ok", async () => {
    const r = await run(
      journey("all-kinds", {
        button: "Save",
        text: "Hello one",
        endState: [
          { kind: "page", assertion: { kind: "textIncludes", target: { css: "#status" }, text: "Saved: Hello one" } },
          { kind: "page", assertion: { kind: "valueEquals", target: { label: "Title" }, value: "Hello one" } },
          { kind: "page", assertion: { kind: "count", target: { css: "li" }, min: 2, max: 2 } },
          { kind: "page", assertion: { kind: "attr", target: { css: "main" }, name: "data-saved", value: "yes" } },
          { kind: "page", assertion: { kind: "flashed", target: { css: "#status" }, className: "flash" } },
          { kind: "reloadThen", assertion: { kind: "textIncludes", target: { css: "#live" }, text: "Live: Hello one" } },
          { kind: "requestMade", method: "POST", pathGlob: "/api/save" },
          status2xx,
        ],
        stepRequests: [status2xx],
      }),
    );
    expect(r.data).toMatchObject({ outcome: "ok" });
    expect(r.exitCode ?? 0).toBe(0);
  }, 120_000);

  it("a save that shows but does not persist fails its reloadThen check, named", async () => {
    const r = await run(
      journey("not-persisted", {
        button: "Preview",
        text: "Hello two",
        endState: [
          { kind: "page", assertion: { kind: "textIncludes", target: { css: "#status" }, text: "Saved: Hello two" } },
          { kind: "reloadThen", assertion: { kind: "textIncludes", target: { css: "#live" }, text: "Live: Hello two" } },
        ],
      }),
    );
    expect(r.data.outcome).toBe("quarantined");
    expect(r.data.reason).toMatch(/success check not met after the last step: reloadThen:textIncludes:css=#live\|Live: Hello two/);
    expect(r.data.reason).not.toMatch(/Saved: Hello two/);
    expect(r.exitCode).not.toBe(0);
  }, 120_000);

  it("a step whose expected write never went out fails, naming the step", async () => {
    const r = await run(journey("no-write", { button: "Nothing", text: "Hello three", stepRequests: [status2xx] }));
    expect(r.data.outcome).toBe("quarantined");
    expect(r.data.reason).toMatch(/step 3 \(click [^)]*\): responseStatus:POST \/api\/save=2xx — no POST request matched/);
  }, 120_000);

  it("a step request expectation counts only what was sent from that step on", async () => {
    // The write happens at step 3; step 4 (a click that sends nothing) claims it — it must fail.
    const j = journey("before-step", { button: "Save", text: "Hello four" });
    j.recording.pages[0]!.steps.push({
      step: { kind: "click", target: { role: "button", name: "Nothing" }, expect: { kind: "count", target: { role: "button", name: "Nothing" }, min: 0 } },
      expectRequests: [status2xx],
    });
    const r = await run(j);
    expect(r.data.outcome).toBe("quarantined");
    expect(r.data.reason).toMatch(/step 4 /);
  }, 120_000);
});
