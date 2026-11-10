import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { planJourneyVerification, verifyJourneyMutations, type VerifyJourneyOptions } from "./journey-verify.js";
import { journeyProofContext, journeyProofHashForContext, journeyExecutionIdentity } from "./journey-proof-context.js";
import { readVerifyRecord } from "./journey-review-store.js";
import type { runJourneyProgrammatically } from "./journey-api.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
function fixture(): Journey {
  return { metadata: { id: "identity", name: "Identity", promoted: false, params: [], createdAtIso: "2026-11-06T00:00:00Z" }, recording: { version: "1", site: "http://fixture.test", pages: [{ url: "/", steps: [
    { step: { kind: "click", target: { testId: "save" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } } },
  ] }] } };
}
async function stored(): Promise<{ dir: string; journey: Journey; store: FsJourneyStore }> {
  const dir = await mkdtemp(join(tmpdir(), "jev-execution-identity-")); dirs.push(dir);
  const store = new FsJourneyStore(dir);
  await store.put(fixture());
  return { dir, journey: (await store.get("identity"))!, store };
}
// Actual verifier, injected replay only: this proves output/receipt identity, not a browser result.
const controlledReplay: typeof runJourneyProgrammatically = async (_opts, mutation = {}) => mutation.skipStep === undefined
  ? { outcome: "ok", output: null }
  : { outcome: "quarantined", at: 0, reason: "controlled missing UI effect", failurePhase: "postcondition" };
const contexts: Pick<VerifyJourneyOptions, "browser" | "emulation" | "readRequests">[] = [
  {},
  { browser: { headed: true, channel: "chrome", args: ["--native-context-canary"] }, emulation: { viewport: { width: 390, height: 844 } }, readRequests: ["/query"] },
  { browser: { executablePath: "/not-opened/chromium" }, emulation: { device: "iPhone 13", geolocation: { latitude: 40, longitude: -70 } }, readRequests: ["/b", "/a", "/b"] },
];
it.each(contexts)("actual plan, completed controlled verifier and stored receipt agree for %j", async (context) => {
  const { dir, journey } = await stored();
  const opts = { dir, id: journey.metadata.id, ...context };
  const expected = { kind: "journey-execution-identity", version: 1, journeyId: journey.metadata.id, proofHash: journeyProofHashForContext(journey, journeyProofContext(context.browser, context.emulation, context.readRequests)) };
  const plan = await planJourneyVerification(opts);
  const report = await verifyJourneyMutations(opts, controlledReplay);
  expect(plan).toHaveProperty("executionIdentity", expected);
  expect(report).toHaveProperty("executionIdentity", expected);
  expect((await readVerifyRecord(dir, journey.metadata.id))?.proofHash).toBe(expected.proofHash);
  expect(JSON.stringify(expected)).not.toContain("native-context-canary");
});
it("completed identity remains bound to the held source if the stored Journey changes during replay", async () => {
  const { dir, journey, store } = await stored();
  const before = await planJourneyVerification({ dir, id: journey.metadata.id });
  let changed = false;
  const report = await verifyJourneyMutations({ dir, id: journey.metadata.id }, async (...args) => {
    if (!changed) { changed = true; await store.put({ ...journey, recording: { ...journey.recording, site: "http://changed.test" } }); }
    return controlledReplay(...args);
  });
  const after = await planJourneyVerification({ dir, id: journey.metadata.id });
  expect(report).toHaveProperty("executionIdentity", { kind: "journey-execution-identity", version: 1, journeyId: journey.metadata.id, proofHash: (await readVerifyRecord(dir, journey.metadata.id))?.proofHash });
  expect(report).toHaveProperty("executionIdentity", Reflect.get(before, "executionIdentity"));
  expect(Reflect.get(after, "executionIdentity")).not.toEqual(Reflect.get(before, "executionIdentity"));
});
it("duplicate and reordered read rules preserve identity while a changed rule does not", async () => {
  const { dir } = await stored();
  const plan = (readRequests: string[]) => planJourneyVerification({ dir, id: "identity", readRequests });
  const a = await plan(["/a", "/b", "/a"]); const b = await plan(["/b", "/a"]); const c = await plan(["/a"]);
  expect(a).toHaveProperty("executionIdentity");
  expect(Reflect.get(a, "executionIdentity")).toEqual(Reflect.get(b, "executionIdentity"));
  expect(Reflect.get(a, "executionIdentity")).not.toEqual(Reflect.get(c, "executionIdentity"));
});
it.each(["wording", "promotion", "assertion", "target", "params", "unknown"])("uses the existing native canonicalizer for %s", async (change) => {
  const { dir, journey, store } = await stored();
  const before = await planJourneyVerification({ dir, id: "identity" });
  const candidate = structuredClone(journey);
  if (change === "wording") { candidate.metadata.goal = "New human wording"; candidate.recording.pages[0]!.steps[0]!.objective = "Save this item"; }
  if (change === "promotion") candidate.metadata.promoted = true;
  if (change === "assertion") candidate.recording.pages[0]!.steps[0]!.step.expect = { kind: "textIncludes", target: { testId: "status" }, text: "Different" };
  if (change === "target") candidate.recording.pages[0]!.steps[0]!.step = { kind: "click", target: { testId: "different" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } };
  if (change === "params") candidate.metadata.params = ["newInput"];
  if (change === "unknown") Reflect.set(candidate.recording.pages[0]!.steps[0]!, "futureExecutionField", { mode: "changed" });
  // Unknown execution fields are evaluated directly by the canonicalizer; the store schema may strip them.
  const expected = journeyProofHashForContext(candidate, undefined);
  expect(journeyExecutionIdentity(candidate, undefined).proofHash).toBe(expected);
  if (change !== "unknown") {
    await store.put(candidate);
    expect(await planJourneyVerification({ dir, id: "identity" })).toHaveProperty("executionIdentity.proofHash", expected);
  }
  expect(before).toHaveProperty("executionIdentity");
  if (change === "wording" || change === "promotion") expect(expected).toBe(journeyProofHashForContext(journey, undefined));
  else expect(expected).not.toBe(journeyProofHashForContext(journey, undefined));
});
it.each([{ browser: { headed: true } }, { browser: { channel: "chrome" } }, { emulation: { viewport: { width: 800, height: 600 } } }])("material context changes identity: %j", async (context) => {
  const { dir } = await stored();
  const before = await planJourneyVerification({ dir, id: "identity" });
  const after = await planJourneyVerification({ dir, id: "identity", ...context });
  expect(before).toHaveProperty("executionIdentity");
  expect(Reflect.get(after, "executionIdentity")).not.toEqual(Reflect.get(before, "executionIdentity"));
});

it("native protocol identity survives coincidental secret-text redaction without exposing parameter values", async () => {
  const { dir, journey, store } = await stored();
  await store.put({ ...journey, metadata: { ...journey.metadata, params: ["token"], parameters: [{ name: "token", secret: true }] } });
  const plan = await planJourneyVerification({ dir, id: "identity", params: { token: "journey-execution-identity" } });
  const report = await verifyJourneyMutations({ dir, id: "identity", params: { token: "journey-execution-identity" } }, controlledReplay);
  expect(report.executionIdentity).toEqual(plan.executionIdentity);
  expect(report.executionIdentity.kind).toBe("journey-execution-identity");
  const digestReport = await verifyJourneyMutations({ dir, id: "identity", params: { token: plan.executionIdentity.proofHash } }, controlledReplay);
  expect(digestReport.executionIdentity).toEqual(plan.executionIdentity);
  expect(Object.keys(digestReport.executionIdentity).sort()).toEqual(["journeyId", "kind", "proofHash", "version"]);
  expect((await readVerifyRecord(dir, "identity"))?.proofHash).toBe(plan.executionIdentity.proofHash);
});
