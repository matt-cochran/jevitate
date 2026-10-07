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

useSkippingTime({ per: "all" });

/**
 * #398 served — a chat launcher like Zonetico's (ChatLauncher.astro + header-entry-island.ts): an in-page
 * hash link that a module script enhances. Once bound, its click finds the chat block's capability root,
 * scrolls it into view and focuses the root's static message box; that focus mounts the live chat (a
 * lazily imported runtime that first checks availability over RPC), whose input is `chat-input`.
 * Unbound, the click is a plain hash link and the chat never mounts.
 */

const FILLER = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i + 1} about the business.</p>`).join("");

const HOME = `<!doctype html><html><head><title>Bayview</title>
  <script type="module" src="/island.js"></script></head><body>
  <header><h1>Bayview Plumbing</h1><a class="button chat-launcher" href="#chat-block" data-chat-launcher="chat-block" data-testid="chat-launcher-link">Chat with us<span aria-hidden="true">↗</span></a></header>
  <main>${FILLER}
  <section id="chat-block"><div class="native-capability" data-capability-root data-activation="chat" data-capability="chat">
    <p data-capability-status role="status" aria-live="polite"></p>
    <div class="vc-root vc-inline" data-chat-static><div class="vc-panel" role="region" aria-label="Bayview Assistant" data-testid="chat-panel-static">
      <div class="vc-log" role="log"><div class="vc-bubble">Hi, what can we help you with?</div></div>
      <div class="vc-composer"><textarea class="vc-input" rows="1" aria-label="Message" data-chat-draft data-testid="chat-input-static"></textarea><button type="button" disabled>Send</button></div>
    </div></div>
  </div></section></main></body></html>`;

const ISLAND = `
let pending = null;
const load = () => (pending ??= import("/runtime.js"));
function bindChatLaunchers(doc = document) {
  for (const link of doc.querySelectorAll("[data-chat-launcher]")) {
    if (link.dataset.chatLauncherBound) continue;
    link.dataset.chatLauncherBound = "true";
    link.addEventListener("click", (event) => {
      const root = doc.getElementById(link.dataset.chatLauncher || "")?.querySelector("[data-capability-root]");
      if (!root) return;
      event.preventDefault();
      const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      root.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      const opener = root.querySelector("[data-capability-activate]")
        ?? [...root.querySelectorAll(".vc-launcher")].find((el) => el.style.display !== "none");
      opener?.click();
      const focus = (tries) => {
        const input = root.querySelector('textarea, input:not([type="hidden"])');
        if (input) input.focus({ preventScroll: true });
        else if (tries > 0) setTimeout(() => focus(tries - 1), 150);
      };
      focus(10);
    });
  }
}
function bootCapabilities(doc = document) {
  for (const root of doc.querySelectorAll("[data-capability-root]")) {
    if (root.dataset.capabilityMounted) continue;
    root.dataset.capabilityMounted = "true";
    let activated = null;
    const activate = () => (activated ??= load().then((m) => m.mountCapability(root)));
    for (const type of ["focusin", "pointerdown", "touchstart"]) root.addEventListener(type, activate, { once: true, passive: true });
    root.querySelector("[data-chat-draft]")?.addEventListener("input", activate, { once: true });
  }
}
bindChatLaunchers();
bootCapabilities();
`;

const RUNTIME = `
export async function mountCapability(root) {
  const res = await fetch("/rpc/CheckAvailability", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!res.ok) { root.querySelector("[data-capability-status]").textContent = "unavailable"; return; }
  root.querySelector("[data-chat-static]")?.remove();
  const panel = document.createElement("div");
  panel.setAttribute("data-testid", "chat-panel");
  panel.innerHTML = '<ol data-testid="chat-log"></ol><textarea data-testid="chat-input" aria-label="Message"></textarea><button type="button" data-testid="chat-send">Send</button>';
  panel.querySelector("[data-testid=chat-send]").onclick = () => {
    const li = document.createElement("li");
    li.setAttribute("data-testid", "chat-message-visitor");
    li.textContent = panel.querySelector("textarea").value;
    panel.querySelector("ol").appendChild(li);
  };
  root.appendChild(panel);
}
`;

let server: Server;
let origin: string;
let dir: string;
let journeysDir: string;
const served: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    served.push(`${req.method} ${path}`);
    if (path === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HOME);
    if (path === "/island.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(ISLAND);
    if (path === "/runtime.js") return void setTimeout(() => res.writeHead(200, { "content-type": "text/javascript" }).end(RUNTIME), 200);
    if (path === "/rpc/CheckAvailability") return void setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), 100);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-launcher-prefix-"));
  journeysDir = join(dir, "journeys");
  await new FsJourneyStore(journeysDir).put(launcherJourney());
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function launcherJourney(): Journey {
  return {
    metadata: { id: "r1-j15", name: "Ask the business in chat", promoted: true, params: [], createdAtIso: "2026-10-01T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { role: "heading", name: "Bayview Plumbing" } } } },
            { step: { kind: "click", target: { testId: "chat-launcher-link" }, expect: { kind: "visible", target: { testId: "chat-launcher-link" } } } },
            { step: { kind: "fill", target: { testId: "chat-input" }, value: { redacted: false, value: "Do you fix water heaters?" }, expect: { kind: "visible", target: { testId: "chat-input" } } } },
            { step: { kind: "click", target: { testId: "chat-send" }, expect: { kind: "visible", target: { testId: "chat-message-visitor" } } } },
            { step: { kind: "assert", check: { kind: "textIncludes", target: { testId: "chat-message-visitor" }, text: "water heaters" } } },
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

describe("#398 a script-enhanced chat launcher replays the same as a prefix as in journey run (served)", () => {
  it("journey run replays the Journey green", async () => {
    const r = await cli(["journey", "run", "r1-j15", "--json"]);
    expect(r.envelope?.ok, r.out + r.err).toBe(true);
    expect(r.envelope?.data, JSON.stringify(r.envelope?.data)).toMatchObject({ outcome: "ok" });
  }, 120_000);

  it.each([
    ["3", ["--strategy", "adversarial"]],
    ["4", ["--strategy", "adversarial"]],
    ["3", ["--strategy", "exploratory"]],
    ["3", ["--strategy", "coverage"]],
    ["3", ["--strategy", "goal", "--goal", "book a water heater repair"]],
    ["3", ["--strategy", "usability", "--goal", "book a water heater repair", "--app-class", "saas"]],
    ["3", ["--strategy", "adversarial", "--record-video", "VIDEO"]],
    ["3", ["--strategy", "adversarial", "--evidence-video"]],
    ["3", ["--strategy", "adversarial", "--screenshots", "steps"]],
    ["3", ["--strategy", "goal", "--goal", "book a water heater repair", "--record-video", "VIDEO", "--screenshots", "steps"]],
  ] as Array<[string, string[]]>)("explore --from-journey --at-step %s %j replays the prefix (never journey-stale)", async (atStep, strategy) => {
    const r = await cli([
      "explore", "--from-journey", "r1-j15", "--at-step", atStep, "--journeys-dir", journeysDir,
      ...strategy.map((a) => (a === "VIDEO" ? join(dir, "videos") : a)), "--fake-ai", "--max-actions", "1", "--out", join(dir, `at-${atStep}-${strategy[1]}`), "--json",
    ]);
    expect(r.envelope?.ok, r.out + r.err).toBe(true);
    expect((r.envelope?.data?.failure as { kind?: string } | undefined)?.kind, JSON.stringify(r.envelope?.data?.failure)).not.toBe("journey-stale");
    expect(r.envelope?.data?.branch).toMatchObject({ journeyId: "r1-j15", step: Number(atStep) });
  }, 180_000);
});
