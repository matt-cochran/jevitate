import { afterEach, expect, test, vi } from "vitest";
import type { Step } from "@jevitate/recording";
import { FakeGenerationGateway, type GenerationPort } from "@jevitate/ai-core";
import { FakeClock, clock, installClock, resetClock } from "@jevitate/domain";
import { explainsBreak, type ChangeEvidenceRef, type ChangeScope, type HealerRequest } from "@jevitate/runtime";
import { makeEvidenceSelfHealer, type InventoryControl } from "./self-heal-adapter.js";

afterEach(() => resetClock());

const brokenStep: Step = { kind: "click", target: { role: "button", name: "Create New" }, expect: { kind: "visible", target: { text: "Created" } } };
const evidence: ChangeEvidenceRef[] = [{ id: "e1", kind: "copy", before: "Create New", after: "Create", file: "src/Toolbar.html", line: 3 }];
const scope: ChangeScope = { evidence: [{ ...evidence[0]! }], scanned: { files: 1, hunks: 1, skipped: [] } };

const control = (role: string, name: string, extra: Partial<InventoryControl> = {}): InventoryControl => ({ role, name, enabled: true, summary: `${role} "${name}"`, ...extra });

const request = (extra: Partial<HealerRequest> = {}): HealerRequest => ({
  actor: {} as never,
  brokenStep,
  explanation: explainsBreak(brokenStep, scope),
  evidence,
  tried: [],
  deadlineAtMs: clock.now() + 60_000,
  maxModelCalls: 6,
  ...extra,
});

test("never acts on the page (actsOnPage: false), so a guarded click/fill may consult it", () => {
  expect(makeEvidenceSelfHealer().actsOnPage).toBe(false);
});

test("a deterministic retarget onto the observed control whose name is the evidence's `after` — its proof as recorded", async () => {
  // The role changed (a link now): the runner's own evidence retarget keeps role=button; the inventory knows better.
  const healer = makeEvidenceSelfHealer(undefined, { inventory: async () => [control("link", "Create"), control("button", "Cancel"), control("textbox", "Create")] });
  const p = await healer.proposeCandidates(request());
  expect(p.candidates.map((c) => c.step)).toEqual([{ ...brokenStep, target: { role: "link", name: "Create" } }]);
  expect(p.candidates[0]!.hypothesis).toMatch(/"Create New" → "Create"/);
  expect(p.usage).toEqual({ modelCalls: 0 });
});

test("proposes nothing when no observed control matches the evidence (and never invents one)", async () => {
  const healer = makeEvidenceSelfHealer(new FakeGenerationGateway(), { inventory: async () => [control("button", "Cancel")] });
  const p = await healer.proposeCandidates(request());
  expect(p.candidates).toEqual([]);
});

test("the model only ranks: it sees {kind,before,after} facts and control summaries, never a hunk or a secret, and spends one call", async () => {
  const generate = vi.fn(async () => ({ output: { order: [1, 0], control: null }, provenance: {} as never }));
  const gen = { generate } as unknown as GenerationPort;
  const healer = makeEvidenceSelfHealer(gen, { inventory: async () => [control("link", "Create"), control("button", "Create", { testId: "tok-123" }), control("menuitem", "Create")] });
  const p = await healer.proposeCandidates(request({ secrets: ["tok-123"], evidence: [{ ...evidence[0]!, hunk: "@@ -3 +3 @@ secret body" } as ChangeEvidenceRef] }));
  expect(p.usage).toEqual({ modelCalls: 1 });
  expect(p.candidates.map((c) => c.step.kind === "click" && c.step.target.role)).toEqual(["button", "link", "menuitem"]);
  const [kind, input] = generate.mock.calls[0]! as unknown as [string, Record<string, unknown>];
  expect(kind).toBe("heal.rank");
  const sent = JSON.stringify(input);
  expect(sent).not.toContain("tok-123");
  expect(sent).not.toContain("secret body");
  expect(sent).not.toContain("Toolbar.html");
  expect(input.evidence).toEqual([{ kind: "copy", before: "Create New", after: "Create" }]);
});

test("a model pick from the inventory is one extra candidate, after the evidence ones", async () => {
  const gen = { generate: vi.fn(async () => ({ output: { order: [], control: 1 }, provenance: {} as never })) } as unknown as GenerationPort;
  const healer = makeEvidenceSelfHealer(gen, { inventory: async () => [control("link", "Create"), control("button", "Make one")] });
  const p = await healer.proposeCandidates(request());
  expect(p.candidates.map((c) => (c.step.kind === "click" ? c.step.target : null))).toEqual([
    { role: "link", name: "Create" },
    { role: "button", name: "Make one" },
  ]);
});

test("no model call when the budget allows none, or the deadline has passed", async () => {
  installClock(new FakeClock({ startMs: 1_000 }));
  const generate = vi.fn();
  const healer = makeEvidenceSelfHealer({ generate } as unknown as GenerationPort, { inventory: async () => [control("link", "Create")] });
  expect((await healer.proposeCandidates(request({ maxModelCalls: 0 }))).usage.modelCalls).toBe(0);
  expect((await healer.proposeCandidates(request({ deadlineAtMs: 500 }))).usage.modelCalls).toBe(0);
  expect(generate).not.toHaveBeenCalled();
});

test("a model answer that misses the deadline is dropped; the evidence candidates stand", async () => {
  const fake = new FakeClock({ startMs: 0 });
  installClock(fake);
  const gen = { generate: () => new Promise(() => undefined) } as unknown as GenerationPort;
  const healer = makeEvidenceSelfHealer(gen, { inventory: async () => [control("link", "Create")] });
  const pending = healer.proposeCandidates(request({ deadlineAtMs: 50 }));
  await fake.advanceBy(60);
  const p = await pending;
  expect(p.candidates).toHaveLength(1);
  expect(p.reason).toMatch(/deadline/);
});

test("already-tried candidates are not proposed again", async () => {
  const healer = makeEvidenceSelfHealer(undefined, { inventory: async () => [control("link", "Create")] });
  const tried = [{ ...brokenStep, target: { role: "link", name: "Create" } }] as Step[];
  expect((await healer.proposeCandidates(request({ tried }))).candidates).toEqual([]);
});
