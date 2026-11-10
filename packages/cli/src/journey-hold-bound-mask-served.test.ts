import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { runAsMcpInvocation } from "./approval-provenance.js";
import { runJourneyProgrammatically } from "./journey-api.js";
import { heldOutcomeOf, registerHoldHooks } from "./journey-hold.js";
import { journeyReviewHash } from "./journey-review.js";
import { createCheckpointKey } from "./journey-verify-checkpoint.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

/**
 * Independent check H3, served (an MCP invocation's run, real Chromium): with run records off
 * (`JEVITATE_RUN_RECORD=off`, so no evidence writer), a secret the operator's targets.json binds goes
 * into the page address (`/magic?token=${token}`), and the run then holds at a recorded handback. The
 * hold's checkpoint keeps the page address masked: the bound token is in no file under holds/.
 */

useSkippingTime({ per: "all", pageClock: false });

const homeOverride = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  const homedir = (): string => homeOverride.dir ?? real.homedir();
  return { ...real, homedir, default: { ...real, homedir } };
});

const TOKEN = "MARKER_T-tok9Zq*x";
const VAR = "JEV_HOLD_BOUND_MASK_SERVED";

let server: Server;
let origin: string;
let root: string;
let journeysDir: string;
let holdsDir: string;
let inboxDir: string;
const seen: string[] = [];

function serve(): Promise<Server> {
  const s = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/magic") seen.push(url.searchParams.get("token") === TOKEN ? "token-ok" : "token-wrong");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      `<!doctype html><html><body><h1>Welcome</h1><label>Code <input id=code></label><button type=button id=go>Continue</button><p data-testid=status></p>
<script>document.getElementById("go").addEventListener("click", () => { document.querySelector("[data-testid=status]").textContent = "Done"; });</script></body></html>`,
    );
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

function journey(): Journey {
  return {
    metadata: { id: "magic", name: "magic", promoted: false, params: ["token"], parameters: [{ name: "token", secret: true }], createdAtIso: "2026-11-09T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/magic",
          steps: [
            { step: { kind: "navigate", url: "/magic?token=${token}", expect: { kind: "visible", target: { role: "heading", name: "Welcome" } } } },
            { step: { kind: "handback", prompt: "Enter the code", resume: { kind: "visible", target: { label: "Code" } } } },
            { step: { kind: "click", target: { role: "button", name: "Continue" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Done" } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

beforeAll(async () => {
  server = await serve();
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-hold-bound-mask-"));
  homeOverride.dir = join(root, "home");
  journeysDir = join(root, "journeys");
  holdsDir = join(root, "holds");
  inboxDir = join(root, "inbox");
  const keyFile = join(root, "home", ".jevitate", "verify-checkpoint.key");
  mkdirSync(journeysDir, { recursive: true });
  createCheckpointKey(keyFile);
  writeFileSync(join(root, "environments.json"), JSON.stringify({}));
  registerHoldHooks({ holdsDir, keyFile, inboxDir });
  // Approved at a terminal, as a person would: an MCP run reads targets.json only for a promoted Journey.
  const store = new FsJourneyStore(journeysDir);
  await store.put(journey());
  const stored = (await store.get("magic"))!;
  await store.put({ ...stored, metadata: { ...stored.metadata, promoted: true, approval: { contentHash: journeyReviewHash(stored), at: "2026-11-09T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } } } } as Journey);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  homeOverride.dir = undefined;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

describe("H3: a hold's checkpoint masks a bound secret with run records off (real Chromium)", { timeout: 180_000 }, () => {
  it("a targets.json-bound token in the page address leaves 0 markers in holds/*.checkpoint.json", async () => {
    vi.stubEnv("JEVITATE_RUN_RECORD", "off");
    const targetsFile = join(root, "targets.json");
    writeFileSync(targetsFile, JSON.stringify({ [origin]: { secretFields: [`param=token=env:${VAR}`] } }));
    // The run's own binding (journey-secret-mode.ts), not a command's: the token is in no parameter the run was given.
    const err = await runAsMcpInvocation(() =>
      runJourneyProgrammatically({ dir: journeysDir, id: "magic", params: {}, runGuardTargetsFile: targetsFile, secretEnv: { [VAR]: TOKEN }, browserPortFactory: () => new PlaywrightBrowserPort() }),
    ).then(
      (r) => r,
      (e: unknown) => e,
    );
    expect(heldOutcomeOf(err), String(err)).toMatchObject({ outcome: "held", kind: "handback", step: 2 });
    // The bound token really went into the page address.
    expect(seen).toEqual(["token-ok"]);
    const checkpoints = readdirSync(holdsDir).filter((f) => f.endsWith(".checkpoint.json"));
    expect(checkpoints).toHaveLength(1);
    for (const f of readdirSync(holdsDir)) expect(readFileSync(join(holdsDir, f), "utf8").match(/MARKER_/g) ?? [], f).toHaveLength(0);
  });
});
