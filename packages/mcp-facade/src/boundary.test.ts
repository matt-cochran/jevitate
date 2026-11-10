import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { FsJourneyCallQueueStore } from "@jevitate/missions";
import { listToolNames, ALLOWED_TOOLS, FORBIDDEN_TOOLS } from "./tools.js";
import { queueJourney, QueueJourneyRefusedError } from "./mission-tools.js";

test("facade exposes exactly the allowed domain tools", () => {
  expect([...listToolNames()].sort()).toEqual([...ALLOWED_TOOLS].sort());
});

test("facade exposes none of the forbidden browser surfaces", () => {
  const names = new Set(listToolNames());
  for (const forbidden of FORBIDDEN_TOOLS) {
    expect(names.has(forbidden)).toBe(false);
  }
});

test("facade exposes the two-level journey tools alongside the existing allowlist", () => {
  const names = new Set(listToolNames());
  expect(names.has("find_capabilities")).toBe(true);
  expect(names.has("run_journey")).toBe(true);
  for (const forbidden of FORBIDDEN_TOOLS) {
    expect(names.has(forbidden)).toBe(false);
  }
});

test("facade exposes queue_exploration alongside the existing allowlist", () => {
  const names = new Set(listToolNames());
  expect(names.has("queue_exploration")).toBe(true);
  for (const forbidden of FORBIDDEN_TOOLS) {
    expect(names.has(forbidden)).toBe(false);
  }
});

test("#432: facade exposes the read-only review_journey tool", () => {
  expect(new Set(listToolNames()).has("review_journey")).toBe(true);
});

test("#433: facade exposes the read-only catalog tools and no catalog approve tool", () => {
  const names = new Set(listToolNames());
  for (const t of ["review_persona", "review_job", "catalog_status"]) expect(names.has(t)).toBe(true);
  for (const t of ["approve_persona", "approve_job"]) {
    expect(names.has(t)).toBe(false);
    expect((FORBIDDEN_TOOLS as readonly string[]).includes(t)).toBe(true);
  }
  expect([...names].filter((n) => /approve/.test(n)).sort()).toEqual(["approve_action", "approve_demo"]);
});

test("#435: facade exposes the read-only analyze_catalog tool", () => {
  expect(new Set(listToolNames()).has("analyze_catalog")).toBe(true);
});

test("0.10: facade serves the new allowlisted tools; connecting Journeeze stays off MCP; approvals stay forbidden", () => {
  const names = new Set(listToolNames());
  for (const t of ["draft_job_outcomes", "locator_health", "export_catalog_bundle", "publish_to_journeeze"]) expect(names.has(t), t).toBe(true);
  // #464: the upload key is entered only on the CLI (`jevitate connect journeeze`).
  expect(names.has("connect_journeeze")).toBe(false);
  expect((FORBIDDEN_TOOLS as readonly string[]).includes("connect_journeeze")).toBe(true);
  expect([...names].filter((n) => /connect|secret|credential|key/.test(n))).toEqual([]);
  // #465/#464/#469: drafting, exporting and publishing never approve; catalog approvals stay forbidden.
  for (const t of ["approve_persona", "approve_job"]) expect(names.has(t), t).toBe(false);
  expect([...names].filter((n) => /approve/.test(n)).sort()).toEqual(["approve_action", "approve_demo"]);
});

test("#523: facade serves catalog_draft", () => {
  expect(new Set(listToolNames()).has("catalog_draft")).toBe(true);
});

test("#523: catalog_draft is no approval — the only approve tools stay approve_action and approve_demo", () => {
  expect(listToolNames().filter((n) => /approve/.test(n)).sort()).toEqual(["approve_action", "approve_demo"]);
});

test("#523: facade serves journey_link", () => {
  expect(new Set(listToolNames()).has("journey_link")).toBe(true);
});

test("#523: journey_link is no approval — the approve/promote tools stay approve_action, approve_demo and promote_journey", () => {
  expect(listToolNames().filter((n) => /approve|promot/.test(n)).sort()).toEqual(["approve_action", "approve_demo", "promote_journey"]);
});

test("ALLOWED_TOOLS and FORBIDDEN_TOOLS are disjoint and duplicate-free", () => {
  const allowed = [...ALLOWED_TOOLS] as string[];
  expect(new Set(allowed).size).toBe(allowed.length);
  for (const f of FORBIDDEN_TOOLS) expect(allowed.includes(f), f).toBe(false);
});

test("0.30.0 #801: facade serves shorten_journey (owner decision); it is no approval, no promotion and no browser primitive", () => {
  const names = new Set(listToolNames());
  expect(names.has("shorten_journey")).toBe(true);
  expect((FORBIDDEN_TOOLS as readonly string[]).includes("shorten_journey")).toBe(false);
  expect(listToolNames().filter((n) => /approve|promot/.test(n)).sort()).toEqual(["approve_action", "approve_demo", "promote_journey"]);
});

test("0.30.0 #797: facade serves queue_journey; it is no approval and no browser primitive", () => {
  const names = new Set(listToolNames());
  expect(names.has("queue_journey")).toBe(true);
  expect((FORBIDDEN_TOOLS as readonly string[]).includes("queue_journey")).toBe(false);
  expect(listToolNames().filter((n) => /approve|promot/.test(n)).sort()).toEqual(["approve_action", "approve_demo", "promote_journey"]);
});

test("0.30.0 #797: queue_journey with {password: 'x'} is refused E_SECRET_PARAM_OVER_MCP by name, before the gate, and nothing is written under the queue directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "facade-797-"));
  const queueDir = join(root, "queue");
  try {
    const resolveHash = vi.fn(async () => "h");
    const refused = queueJourney(new FsJourneyCallQueueStore(queueDir), { id: "login", params: { password: "x" } }, { resolveHash, nowIso: () => "2026-11-09T00:00:00.000Z" });
    await expect(refused).rejects.toBeInstanceOf(QueueJourneyRefusedError);
    await expect(refused).rejects.toMatchObject({ code: "E_SECRET_PARAM_OVER_MCP", params: ["password"] });
    // The refusal names the param, never its value.
    await refused.catch((err: Error) => expect(err.message).not.toMatch(/\bx\b/));
    expect(resolveHash).not.toHaveBeenCalled();
    expect(existsSync(queueDir)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0.30.0 #797: a queue_journey call that passes the gate is written with the hash the gate returned, and only id, hash, non-secret params and env", async () => {
  const root = mkdtempSync(join(tmpdir(), "facade-797-"));
  const queueDir = join(root, "queue");
  try {
    const store = new FsJourneyCallQueueStore(queueDir);
    const r = await queueJourney(store, { id: "notes", params: { note: "hello" }, env: "staging", steps: [{ kind: "click" }] }, { resolveHash: async () => "hash-1", nowIso: () => "2026-11-09T00:00:00.000Z", newId: () => "journey-1" });
    expect(r).toEqual({ ok: true, callId: "journey-1", status: "queued", journey: { id: "notes", hash: "hash-1" } });
    expect(await store.get("journey-1")).toEqual({
      id: "journey-1",
      status: "queued",
      enqueuedAtIso: "2026-11-09T00:00:00.000Z",
      call: { kind: "journey", journey: { id: "notes", hash: "hash-1" }, params: { note: "hello" }, env: "staging", requestedAt: "2026-11-09T00:00:00.000Z" },
    });
    expect(readdirSync(join(queueDir, "journeys"))).toEqual(["journey-1.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0.30.0 #800: queue_journey stores noDoneCheck / requireDoneCheck on the call, and refuses both together before the gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "facade-800-"));
  const queueDir = join(root, "queue");
  try {
    const store = new FsJourneyCallQueueStore(queueDir);
    const opts = { resolveHash: async () => "hash-1", nowIso: () => "2026-11-09T00:00:00.000Z", newId: () => "journey-1" };
    await queueJourney(store, { id: "notes", requireDoneCheck: true }, opts);
    expect((await store.get("journey-1"))?.call).toMatchObject({ journey: { id: "notes", hash: "hash-1" }, requireDoneCheck: true });
    const resolveHash = vi.fn(async () => "h");
    await expect(queueJourney(store, { id: "notes", noDoneCheck: true, requireDoneCheck: true }, { ...opts, resolveHash, newId: () => "journey-2" })).rejects.toMatchObject({ code: "E_QUEUE_JOURNEY_ARGS" });
    await expect(queueJourney(store, { id: "notes", noDoneCheck: "yes" }, { ...opts, resolveHash, newId: () => "journey-3" })).rejects.toMatchObject({ code: "E_QUEUE_JOURNEY_ARGS" });
    expect(resolveHash).not.toHaveBeenCalled();
    expect(readdirSync(join(queueDir, "journeys"))).toEqual(["journey-1.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
