import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; the lazy chunk is a held request, so it stays real time.
useSkippingTime({ per: "all" });

/**
 * #398 served — a chat panel mounted lazily after the launcher click (a dynamic import the server
 * answers after a delay). `journey run` replays the Journey green; the same Journey as an
 * `explore --from-journey` prefix must replay just as green, never `journey-stale`.
 */

const HOME = `<!doctype html><html><head><title>Home</title></head><body><main>
  <h1>Home</h1>
  <a href="#chat" data-testid="chat-launcher-link">Chat with us</a>
  <div id="chat-root"></div>
  <script>
    document.querySelector("[data-testid=chat-launcher-link]").addEventListener("click", () => {
      import("/chat-panel.js").then((m) => m.mount(document.getElementById("chat-root")));
    });
  </script></main></body></html>`;

const CHAT_PANEL = `export function mount(root) {
  root.innerHTML = '<section aria-label="Chat"><input data-testid="chat-input" aria-label="Message">'
    + '<button type="button" data-testid="chat-send">Send</button><ol id="log"></ol></section>';
  root.querySelector("[data-testid=chat-send]").onclick = () => {
    const li = document.createElement("li");
    li.textContent = root.querySelector("[data-testid=chat-input]").value;
    li.setAttribute("data-testid", "chat-message");
    root.querySelector("#log").appendChild(li);
  };
}`;

let server: Server;
let origin: string;
let dir: string;
let journeysDir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HOME);
    if (path === "/chat-panel.js") {
      // The lazily loaded chunk arrives late (a dynamic import over a slow network).
      return void setTimeout(() => res.writeHead(200, { "content-type": "text/javascript" }).end(CHAT_PANEL), 400);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-lazy-prefix-"));
  journeysDir = join(dir, "journeys");
  await new FsJourneyStore(journeysDir).put(chatJourney());
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function chatJourney(): Journey {
  return {
    metadata: { id: "chat", name: "Send a chat message", promoted: true, params: [], createdAtIso: "2026-10-01T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { role: "heading", name: "Home" } } } },
            { step: { kind: "click", target: { testId: "chat-launcher-link" }, expect: { kind: "urlIncludes", text: "#chat" } } },
            { step: { kind: "fill", target: { testId: "chat-input" }, value: { redacted: false, value: "hello" }, expect: { kind: "visible", target: { testId: "chat-input" } } } },
            { step: { kind: "click", target: { testId: "chat-send" }, expect: { kind: "visible", target: { testId: "chat-message" } } } },
            { step: { kind: "assert", check: { kind: "textIncludes", target: { testId: "chat-message" }, text: "hello" } } },
          ],
        },
      ],
    },
  };
}

interface CliRun {
  readonly out: string;
  readonly err: string;
  readonly exitCode: number | undefined;
  readonly envelope: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } | undefined;
}

async function cli(args: string[]): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
    dbPath: join(dir, "no-site-policy.sqlite"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort() },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
  process.exitCode = undefined;
  const text = out.join("");
  let envelope: CliRun["envelope"];
  try {
    envelope = JSON.parse(text.trim().split("\n").at(-1) ?? "") as CliRun["envelope"];
  } catch {
    envelope = undefined;
  }
  return { out: text, err: err.join(""), exitCode, envelope };
}

describe("#398 a lazily mounted panel replays the same as a prefix as in journey run (served)", () => {
  it("journey run replays the Journey green", async () => {
    const r = await cli(["journey", "run", "chat", "--json"]);
    expect(r.envelope?.ok, r.out + r.err).toBe(true);
    expect(r.envelope?.data).toMatchObject({ outcome: "ok" });
  }, 120_000);

  it.each([
    ["3", ["--strategy", "adversarial"]],
    ["4", ["--strategy", "adversarial"]],
    ["3", ["--strategy", "exploratory"]],
    ["3", ["--strategy", "coverage"]],
    ["3", ["--strategy", "goal", "--goal", "send a chat message"]],
    ["3", ["--strategy", "usability", "--goal", "send a chat message", "--app-class", "saas"]],
  ])("explore --from-journey --at-step %s %j replays the prefix (never journey-stale)", async (atStep, strategy) => {
    const r = await cli([
      "explore", "--from-journey", "chat", "--at-step", atStep, "--journeys-dir", journeysDir,
      ...strategy, "--fake-ai", "--max-actions", "1", "--out", join(dir, `at-${atStep}-${strategy[1]}`), "--json",
    ]);
    expect(r.envelope?.ok, r.out + r.err).toBe(true);
    expect((r.envelope?.data?.failure as { kind?: string } | undefined)?.kind, JSON.stringify(r.envelope?.data?.failure)).not.toBe("journey-stale");
    expect(r.envelope?.data?.branch).toMatchObject({ journeyId: "chat", step: Number(atStep) });
  }, 180_000);
});
