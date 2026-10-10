import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { approveDemo, demoDraftPath, type ApproveDemoResult } from "./demo-aspect-api.js";
import { annotationDraftPath, journeyContentHash } from "./journey-annotate-api.js";
import { approvedDemoDir, type ApprovedDemoRecord } from "./approved-demo.js";
import type { ResolvedJourneyEnvironment } from "./environments.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #471 served: `demo approve` on an environment that declares `synthetic: true` renders the final
 * demo under jz-mask-v1 and records its proven media for the Journeeze export; on any other
 * environment nothing is recorded (no media leaves). Each test asserts one behaviour.
 */

const APP = `<!doctype html><html><head><title>Profile</title><style>body{margin:16px;font:16px sans-serif;background:#fff}</style></head><body>
<h1>Profile</h1>
<label>Display name <input id="name" value="Grace Hopper"></label>
<button type="button" data-testid="save">Save</button>
<p data-testid="status" role="status"></p>
<script>document.querySelector("[data-testid=save]").onclick = () => { document.querySelector("[data-testid=status]").textContent = "Saved"; };</script>
</body></html>`;

const ID = "jz-approve";
let server: Server;
let origin: string;
let root: string;

function journey(site: string): Journey {
  return {
    metadata: { id: ID, name: "Save your display name", goal: "Save your display name", promoted: false, params: [], createdAtIso: "2026-10-09T12:00:00.000Z" },
    recording: {
      version: "1",
      site,
      intent: "Save the profile",
      pages: [
        {
          url: "/",
          steps: [
            { stepId: "s-open", step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } },
            {
              stepId: "s-save",
              step: { kind: "click", target: { testId: "save", role: "button", name: "Save" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } },
            },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

/** A Journey with its demo and annotation drafts, as `jevitate demo "<aspect>"` leaves them. */
function drafted(journeysDir: string, env: string): void {
  const j = journey(origin);
  mkdirSync(join(journeysDir, ".drafts"), { recursive: true });
  writeFileSync(join(journeysDir, `${ID}.json`), JSON.stringify(j, null, 2));
  const hash = journeyContentHash(j);
  writeFileSync(
    annotationDraftPath(journeysDir, ID),
    JSON.stringify({
      kind: "jevitate.journey-annotations.draft",
      version: 1,
      journeyId: ID,
      journeyHash: hash,
      createdAtIso: "2026-10-09T12:00:00.000Z",
      provenance: { adapter: "human", model: "none", promptVersion: "1" },
      replay: { outcome: "completed", reachedSteps: 2, totalSteps: 2 },
      steps: [],
    }),
  );
  writeFileSync(
    demoDraftPath(journeysDir, ID),
    JSON.stringify({ kind: "jevitate.demo.draft", version: 1, id: ID, aspect: "Save your display name", env, journeyHash: hash, createdAtIso: "2026-10-09T12:00:00.000Z", draft: {} }),
  );
}

async function approve(name: string, synthetic: boolean): Promise<{ result: ApproveDemoResult; journeysDir: string }> {
  const journeysDir = join(root, name, "journeys");
  drafted(journeysDir, name);
  const environment: ResolvedJourneyEnvironment = { name, baseUrl: origin, allowedOrigins: [origin], source: "test", ...(synthetic ? { synthetic: true as const } : {}) };
  const result = await approveDemo({
    journeysDir,
    id: ID,
    outDir: join(root, name, "final"),
    catalogDir: null,
    environment,
    paceMs: 0,
    browserPortFactory: () => new PlaywrightBrowserPort(),
  });
  return { result, journeysDir };
}

beforeAll(async () => {
  server = createServer((_req, res) => void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), "jev-approve-jz-"));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe("demo approve on a synthetic environment (served, #471)", () => {
  let approved: { result: ApproveDemoResult; journeysDir: string };
  let record: ApprovedDemoRecord;
  beforeAll(async () => {
    approved = await approve("seeded", true);
    record = JSON.parse(readFileSync(join(approvedDemoDir(approved.journeysDir, ID), "demo.json"), "utf8")) as ApprovedDemoRecord;
  }, 300_000);

  it("approves and promotes", () => {
    expect(approved.result.outcome).toBe("approved");
  });

  it("records the jz-mask-v1 + synthetic attestation", () => {
    expect([record.privacy.mask, record.privacy.data, record.privacy.method]).toEqual(["jz-mask-v1", "synthetic", "dom-before-capture"]);
  });

  it("counts the masked field among the proven regions", () => {
    expect(record.privacy.regions).toBeGreaterThan(0);
  });

  it("keeps a proven screenshot for every step", () => {
    expect(record.steps.map((s) => s.screenshot)).toEqual(["step-01.png", "step-02.png"]);
  });

  it("keeps the video only because every frame was proven", () => {
    expect(record.video).toBe("demo.webm");
  });

  it("is bound to the promoted Journey's approved hash", () => {
    const j = JSON.parse(readFileSync(join(approved.journeysDir, `${ID}.json`), "utf8")) as { metadata: { approval: { contentHash: string } } };
    expect(record.renderedFrom).toBe(j.metadata.approval.contentHash);
  });

  it("reports that its media goes to Journeeze", () => {
    expect(approved.result.journeeze?.media).toBe(true);
  });
});

describe("demo approve on an environment that does not declare synthetic data (served, #471)", () => {
  let approved: { result: ApproveDemoResult; journeysDir: string };
  beforeAll(async () => {
    approved = await approve("staging", false);
  }, 300_000);

  it("records no media for export", () => {
    expect(existsSync(approvedDemoDir(approved.journeysDir, ID))).toBe(false);
  });

  it("says why no media goes to Journeeze", () => {
    expect(approved.result.journeeze?.reason).toMatch(/does not declare synthetic: true/);
  });
});
