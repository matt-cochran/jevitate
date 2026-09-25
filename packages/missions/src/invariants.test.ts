import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvariantSpecError } from "@jevitate/recording";
import { enqueueMission } from "./enqueue.js";
import { FsMissionTargetStore } from "./target-store.js";
import { MissionTargetRegistry } from "./target-registry.js";
import { FsMissionQueueStore } from "./queue-store.js";
import { MissionRequestSchema } from "./schema.js";

/**
 * #86 — `MissionRequest.invariants`: an optional, INLINE, closed invariant spec. A malformed spec
 * (unknown key, non-GET probe, undeclared observable) is a schema refusal; a probe off the
 * resolved target's origin is refused before the queue is written.
 */

const baseRequest = {
  target: "demo-shop",
  goal: "import a file",
  successAssertion: { kind: "urlIncludes", text: "/imports" },
  strategy: "goal-based",
};

const invariants = {
  observe: {
    balance: { dom: { selector: "[data-testid=credit-balance]", number: true } },
    imports: { probe: { get: "/v1/imports?limit=1", json: "$.total" } },
  },
  invariants: [{ id: "charge-implies-delivery", require: "delta(balance) < 0 -> delta(imports) >= 1" }],
};

async function buildDeps() {
  const targets = new MissionTargetRegistry(new FsMissionTargetStore(mkdtempSync(join(tmpdir(), "inv-targets-"))));
  const queue = new FsMissionQueueStore(mkdtempSync(join(tmpdir(), "inv-queue-")));
  await targets.put({
    id: "demo-shop",
    name: "demo-shop",
    authorizedOrigin: "https://demo.example.com",
    baseUrl: "https://demo.example.com",
    promoted: true,
    createdAtIso: "2026-09-24T00:00:00Z",
  });
  return { targets, queue };
}

describe("MissionRequest.invariants (#86)", () => {
  it("is optional, and a valid inline spec parses", () => {
    expect(() => MissionRequestSchema.parse(baseRequest)).not.toThrow();
    expect(MissionRequestSchema.parse({ ...baseRequest, invariants }).invariants?.invariants[0]?.id).toBe("charge-implies-delivery");
  });

  it("refuses unknown keys, a non-GET probe and an undeclared observable (schema refusal)", () => {
    expect(() => MissionRequestSchema.parse({ ...baseRequest, invariants: { ...invariants, extra: true } })).toThrow();
    expect(() =>
      MissionRequestSchema.parse({
        ...baseRequest,
        invariants: { ...invariants, observe: { ...invariants.observe, imports: { probe: { post: "/v1/imports" } } } },
      }),
    ).toThrow();
    expect(() =>
      MissionRequestSchema.parse({ ...baseRequest, invariants: { ...invariants, invariants: [{ id: "x", require: "delta(nope) == 0" }] } }),
    ).toThrow(/unknown observable/);
    // Never a path: a string is not a spec.
    expect(() => MissionRequestSchema.parse({ ...baseRequest, invariants: "/etc/inv.json" })).toThrow();
  });

  it("enqueue stores a valid spec with the mission", async () => {
    const { targets, queue } = await buildDeps();
    const mission = await enqueueMission(targets, queue, { ...baseRequest, invariants });
    expect((await queue.list()).map((m) => m.invariants)).toEqual([mission.invariants]);
  });

  it("enqueue refuses a probe off the target's authorized origin — nothing is written", async () => {
    const { targets, queue } = await buildDeps();
    const offOrigin = { ...invariants, observe: { ...invariants.observe, imports: { probe: { get: "https://evil.example.com/v1/imports" } } } };
    await expect(enqueueMission(targets, queue, { ...baseRequest, invariants: offOrigin })).rejects.toBeInstanceOf(InvariantSpecError);
    expect(await queue.list()).toEqual([]);
  });

  it("a probe on one of the target's declared API origins is authorized (#117)", async () => {
    const { targets, queue } = await buildDeps();
    await targets.put({
      id: "spa",
      name: "spa",
      authorizedOrigin: "https://demo.example.com",
      apiOrigins: ["https://api.example.com"],
      baseUrl: "https://demo.example.com",
      promoted: true,
      createdAtIso: "2026-09-24T00:00:00Z",
    });
    const onApi = { ...invariants, observe: { ...invariants.observe, imports: { probe: { get: "https://api.example.com/v1/imports" } } } };
    await expect(enqueueMission(targets, queue, { ...baseRequest, target: "spa", invariants: onApi })).resolves.toMatchObject({ status: "queued" });
    // …but still not on an origin the target never declared.
    const offOrigin = { ...invariants, observe: { ...invariants.observe, imports: { probe: { get: "https://evil.example.com/v1/imports" } } } };
    await expect(enqueueMission(targets, queue, { ...baseRequest, target: "spa", invariants: offOrigin })).rejects.toBeInstanceOf(InvariantSpecError);
  });
});

describe("a queued spec never picks the operator's environment variables (surface-wiring audit)", () => {
  it("refuses authFrom.secret before the queue is written; authFrom.localStorage is accepted", async () => {
    const { targets, queue } = await buildDeps();
    const withSecret = {
      ...invariants,
      observe: { ...invariants.observe, imports: { probe: { get: "/v1/imports", json: "$.total", authFrom: { secret: "env:OPENROUTER_API_KEY" } } } },
    };
    await expect(enqueueMission(targets, queue, { ...baseRequest, invariants: withSecret })).rejects.toThrow(
      /authFrom\.secret \(env:OPENROUTER_API_KEY\) is not accepted in a queued mission/,
    );
    expect(await queue.list()).toEqual([]);
    const withSession = {
      ...invariants,
      observe: { ...invariants.observe, imports: { probe: { get: "/v1/imports", json: "$.total", authFrom: { localStorage: "access_token" } } } },
    };
    await expect(enqueueMission(targets, queue, { ...baseRequest, invariants: withSession })).resolves.toMatchObject({ status: "queued" });
  });
});

