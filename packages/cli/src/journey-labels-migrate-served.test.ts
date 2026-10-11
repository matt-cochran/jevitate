import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import type { RecordedStep, TargetDescriptor } from "@jevitate/recording";
import { useSkippingTime } from "../../explore/src/testkit.js";
import { migrateLabels, parseAriaHead, type MigrateLabelsResult } from "./journey-labels-migrate-api.js";
import { journeyReviewHash } from "./journey-review.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #497 served: `migrateLabels` replays a Journey recorded with test ids only and stores each step
 * target's visible label (`display`), read off the element the replay resolves.
 */

const SECRET = "hunter22-Secret";

const APP = `<!doctype html><html><head><title>Contacts</title></head><body><main>
  <h1>Contacts</h1>
  <label for="email">Email</label><input id="email" type="email" data-testid="contact-email">
  <label for="pw">Password</label><input id="pw" type="password" data-testid="contact-pw">
  <button type="button" data-testid="action-import" onclick="document.querySelector('[data-testid=status]').textContent='Imported'">Import</button>
  <p data-testid="status"></p>
</main></body></html>`;

let server: Server;
let origin: string;
let root: string;

beforeAll(async () => {
  server = createServer((_req, res) => void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), "jevitate-labels-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const t = (testId: string): TargetDescriptor => ({ testId });

const STEPS: RecordedStep[] = [
  { step: { kind: "navigate", url: "/contacts", expect: { kind: "visible", target: { role: "heading", name: "Contacts" } } } },
  { step: { kind: "fill", target: t("contact-email"), value: { var: "email" }, expect: { kind: "visible", target: t("contact-email") } }, variableName: "email" },
  { step: { kind: "fill", target: t("contact-pw"), value: { var: "password" }, expect: { kind: "visible", target: t("contact-pw") } }, variableName: "password" },
  { step: { kind: "click", target: t("action-import"), expect: { kind: "textIncludes", target: t("status"), text: "Imported" } } },
];

function journey(id: string, opts: { promoted?: boolean; steps?: RecordedStep[] } = {}): Journey {
  return {
    metadata: {
      id,
      name: id,
      promoted: opts.promoted ?? false,
      params: ["email", "password"],
      parameters: [
        { name: "email", description: "an email" },
        { name: "password", description: "a password", secret: true },
      ],
      createdAtIso: "2026-10-11T00:00:00.000Z",
    },
    recording: { version: "1", site: origin, pages: [{ url: "/contacts", steps: opts.steps ?? STEPS }] },
  };
}

let n = 0;
/** A fresh journeys dir holding `j`. */
async function seeded(j: Journey): Promise<string> {
  const dir = join(root, `j${n++}`);
  await new FsJourneyStore(dir).put(j);
  return dir;
}

const migrate = (dir: string, dryRun = false): Promise<MigrateLabelsResult> =>
  migrateLabels({
    journeysDir: dir,
    dryRun,
    params: { email: "ada@example.com", password: SECRET },
    targetTimeoutMs: 2_000,
    run: { browserPortFactory: () => new PlaywrightBrowserPort() },
  });

const stepTarget = (j: Journey | null, i: number): TargetDescriptor | undefined => {
  const s = j?.recording.pages[0]?.steps[i]?.step;
  return s !== undefined && "target" in s ? s.target : undefined;
};

describe("migrateLabels backfills step labels by replay (#497, real Chromium)", () => {
  it("labels a test-id'd button with its role and accessible name", async () => {
    const dir = await seeded(journey("a"));
    await migrate(dir);
    expect(stepTarget(await new FsJourneyStore(dir).get("a"), 3)?.display).toEqual({ role: "button", name: "Import" });
  });

  it("labels a field with its <label> text", async () => {
    const dir = await seeded(journey("a"));
    await migrate(dir);
    expect(stepTarget(await new FsJourneyStore(dir).get("a"), 1)?.display).toEqual({ role: "textbox", name: "Email" });
  });

  it("leaves a password field unlabelled, reported as a credential field", async () => {
    const dir = await seeded(journey("a"));
    const r = await migrate(dir);
    expect(r.journeys[0]?.unlabelled.map((u) => [u.step, u.reason])).toEqual([[3, "credential-field"]]);
  });

  it("a second run finds nothing left to label and writes nothing", async () => {
    const dir = await seeded(journey("a"));
    await migrate(dir);
    const once = await readFile(join(dir, "a.json"), "utf8");
    await migrate(dir);
    expect(await readFile(join(dir, "a.json"), "utf8")).toBe(once);
  });

  it("a dry run writes nothing", async () => {
    const dir = await seeded(journey("a"));
    const before = await readFile(join(dir, "a.json"), "utf8");
    await migrate(dir, true);
    expect(await readFile(join(dir, "a.json"), "utf8")).toBe(before);
  });

  it("reports a promoted Journey that gained labels as needing re-approval", async () => {
    const dir = await seeded(journey("p", { promoted: true }));
    expect((await migrate(dir)).journeys[0]?.needsReapproval).toBe(true);
  });

  it("changes the reviewed content hash, so an approval goes stale", async () => {
    const before = journey("p", { promoted: true });
    const dir = await seeded(before);
    await migrate(dir);
    expect(journeyReviewHash((await new FsJourneyStore(dir).get("p"))!)).not.toBe(journeyReviewHash(before));
  });

  it("reports the steps after a stopped replay as not reached", async () => {
    const broken: RecordedStep = { step: { kind: "click", target: t("no-such-thing"), expect: { kind: "visible", target: t("status") } } };
    const dir = await seeded(journey("s", { steps: [STEPS[0]!, STEPS[1]!, STEPS[2]!, broken, STEPS[3]!] }));
    const r = await migrate(dir);
    expect(r.journeys[0]?.unlabelled.map((u) => u.reason)).toEqual(["credential-field", "target-not-found", "not-reached"]);
  });

  it("never puts a secret parameter's value in the report", async () => {
    const dir = await seeded(journey("a"));
    expect(JSON.stringify(await migrate(dir))).not.toContain(SECRET);
  });
});

describe("parseAriaHead (#497)", () => {
  it("reads the role and quoted name of an element's aria snapshot", () => {
    expect(parseAriaHead('- button "Import" [disabled]')).toEqual({ role: "button", name: "Import" });
  });

  it("unescapes a quote in the name", () => {
    expect(parseAriaHead('- link "Say \\"hi\\""')?.name).toBe('Say "hi"');
  });

  it("reads no name from an unnamed element", () => {
    expect(parseAriaHead("- text: Hello")).toBeNull();
  });
});
