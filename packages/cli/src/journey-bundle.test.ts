import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Journey, JourneyReview } from "@jevitate/journey";
import { buildJourneyBundle, checkJourneyBundle, BundleStaleError, type JourneyBundleDeps } from "./journey-bundle.js";
import { journeyContentHash } from "./journey-annotate-api.js";
import type { ReadinessReceipt } from "./journey-readiness.js";

/**
 * #584 — `journey bundle`: a local review bundle over a Journey (or a linked pair). The readiness
 * receipt and the review sheet are faked, so the suite proves the bundle's shape, the approval
 * states, the command ordering and the staleness check without loading a real Journey or catalog.
 */

const CONTENT_HASH = "a".repeat(64);

function journey(id: string, metadata: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: { id, name: `Journey ${id}`, promoted: false, params: [], createdAtIso: "2026-01-01T00:00:00Z", ...metadata },
    recording: { version: "1.0.0", site: "https://example.test", pages: [{ url: "/", steps: [] }] },
  };
}

function reviewOf(j: Journey, overrides: Partial<JourneyReview> = {}): JourneyReview {
  return {
    id: j.metadata.id,
    name: j.metadata.name,
    promoted: j.metadata.promoted,
    summary: { requiresAuth: false, preconditions: [], successCriteria: [], missingIntent: ["step 2 has no objective"] },
    steps: [{ number: 1, kind: "click", action: "click Send", params: [] }],
    sideEffects: { writeRequests: [{ method: "POST", endpoint: "/api/reply", source: "recorded", step: 1 }], riskyControls: [], origins: [] },
    inputs: { params: [{ name: "apiKey", description: "PLANTED_DESCRIPTION", secret: true }], secrets: [] },
    proof: { endState: [], stepAssertions: [], lint: { errors: 0, warnings: 0, findings: [] }, verify: { status: "not-verified", hint: "run journey verify --mutate" } },
    changeSinceApproval: { kind: "first-approval" },
    catalog: { linked: true, job: { id: "answer", status: "draft" }, persona: { id: "editor", status: "approved" }, unvetted: ["job:answer (draft)"], needsReReview: [] },
    contentHash: CONTENT_HASH,
    attention: [],
    ...overrides,
  } as JourneyReview;
}

function receipt(id: string, verdict: ReadinessReceipt["verdict"], blockers: ReadinessReceipt["blockers"] = []): ReadinessReceipt {
  return {
    engine: { version: "0.18.0", commit: "c0ffee", tree: "tree" },
    mode: "report",
    target: null,
    journeys: [{ id, contentHash: "a".repeat(64), reviewHash: CONTENT_HASH, promoted: false }],
    checks: [
      { check: "lint", journey: id, state: "pass", detail: "no findings" },
      { check: "proof", journey: id, state: blockers.length === 0 ? "pass" : "fail", detail: "proven 9/9", evidence: `.jevitate/journeys/.verify/${id}.json` },
    ],
    verdict,
    blockers,
    awaitingHuman: [],
    next: [],
  };
}

interface Fixture {
  readonly journeys: Map<string, Journey>;
  readonly deps: JourneyBundleDeps;
  readonly ready: ReadinessReceipt;
}

function fixture(overrides: Partial<Journey["metadata"]> = {}, receiptOf?: (id: string) => ReadinessReceipt, reviewOverrides: Partial<JourneyReview> = {}): Fixture {
  const journeys = new Map<string, Journey>([["prepare", journey("prepare", { persona: "editor", job: "answer", goal: "Prepare a reply", ...overrides })]]);
  const deps: JourneyBundleDeps = {
    review: (async (_dir: string, id: string) => {
      const j = journeys.get(id);
      if (j === undefined) throw new Error(`unknown journey '${id}'`);
      return { journey: j, review: reviewOf(j, reviewOverrides) };
    }) as unknown as JourneyBundleDeps["review"],
    readiness: (async () => receiptOf?.("prepare") ?? receipt("prepare", "technically-ready")) as unknown as JourneyBundleDeps["readiness"],
    loadCatalog: (async () => ({ dir: null, personasFile: null, jobsFile: null, personas: [], jobs: [], journeys: [] })) as unknown as JourneyBundleDeps["loadCatalog"],
    annotationDraft: () => false,
  };
  return { journeys, deps, ready: receiptOf?.("prepare") ?? receipt("prepare", "technically-ready") };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-584-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function built(f: Fixture): Promise<{ md: string; manifest: string }> {
  await buildJourneyBundle({ id: "prepare", out: root, journeysDir: join(root, "journeys") }, f.deps);
  return { md: await readFile(join(root, "bundle.md"), "utf8"), manifest: await readFile(join(root, "manifest.json"), "utf8") };
}

describe("buildJourneyBundle (#584)", () => {
  it("writes bundle.md and manifest.json", async () => {
    const f = fixture();
    await buildJourneyBundle({ id: "prepare", out: root, journeysDir: join(root, "journeys") }, f.deps);
    expect(existsSync(join(root, "bundle.md")) && existsSync(join(root, "manifest.json"))).toBe(true);
  });

  it("puts a blocker before the per-Journey sections", async () => {
    const f = fixture({}, () => receipt("prepare", "blocked", [{ check: "replay", journey: "prepare", why: "the chain diverged", next: "jevitate journey readiness prepare --mode prove" }]));
    const { md } = await built(f);
    expect(md.indexOf("the chain diverged")).toBeLessThan(md.indexOf("## Journey"));
  });

  it("binds the promote command to the review hash when technically-ready", async () => {
    const { md } = await built(fixture());
    expect(md).toContain(`jevitate journey promote prepare --reviewed-hash ${CONTENT_HASH}`);
  });

  it("lists the promote command without a hash after the blockers", async () => {
    const f = fixture({}, () => receipt("prepare", "blocked", [{ check: "lint", journey: "prepare", why: "1 lint error", next: "jevitate journey lint prepare" }]));
    const { md } = await built(f);
    expect(md).toContain("## After the blockers are fixed\n\n- jevitate journey promote prepare\n");
  });

  it("lists no approve command for a persona that is already approved", async () => {
    const { md } = await built(fixture());
    expect(md).not.toContain("jevitate persona approve editor");
  });

  it("lists nothing for a person when every link is approved and the Journey is promoted and current", async () => {
    const approved = { contentHash: CONTENT_HASH, at: "2026-01-01T00:00:00Z" } as NonNullable<Journey["metadata"]["approval"]>;
    const f = fixture({ promoted: true, approval: approved }, undefined, {
      catalog: { linked: true, job: { id: "answer", status: "approved" }, persona: { id: "editor", status: "approved" }, unvetted: [], needsReReview: [] },
      changeSinceApproval: { kind: "diff", changed: false } as JourneyReview["changeSinceApproval"],
    });
    const { md } = await built(f);
    expect(md).toContain("Nothing is waiting for a person");
  });

  it("labels draft and current catalog approvals distinctly", async () => {
    const { md } = await built(fixture());
    expect(md).toContain("job: answer (draft)");
  });

  it("records the journey hashes in the manifest", async () => {
    const f = fixture();
    const { manifest } = await built(f);
    expect(JSON.parse(manifest)).toMatchObject({ bundleVersion: 1, journeys: [{ id: "prepare", contentHash: journeyContentHash(f.journeys.get("prepare")!), reviewHash: CONTENT_HASH }] });
  });

  it("never leaks a planted param value or description text", async () => {
    const f = fixture();
    const planted = journey("prepare", { persona: "editor", goal: "Prepare a reply" });
    planted.recording.pages[0]!.steps = [{ step: { kind: "fill", target: { testId: "reply" }, value: "PLANTED_VALUE" } } as never];
    f.journeys.set("prepare", planted);
    const { md, manifest } = await built(f);
    expect(md.includes("PLANTED_VALUE") || md.includes("PLANTED_DESCRIPTION") || manifest.includes("PLANTED_VALUE") || manifest.includes("PLANTED_DESCRIPTION")).toBe(false);
  });
});

describe("checkJourneyBundle (#584)", () => {
  it("passes on an unchanged Journey", async () => {
    const f = fixture();
    const { manifest } = await built(f);
    expect(manifest.includes(CONTENT_HASH)).toBe(true);
    expect(await checkJourneyBundle(root, { journeysDir: join(root, "journeys") }, f.deps)).toEqual({ stale: false });
  });

  it("reports E_BUNDLE_STALE after a Journey edit", async () => {
    const f = fixture();
    await built(f);
    f.journeys.set("prepare", journey("prepare", { persona: "editor", goal: "changed" }));
    await expect(checkJourneyBundle(root, { journeysDir: join(root, "journeys") }, f.deps)).rejects.toBeInstanceOf(BundleStaleError);
  });
});
