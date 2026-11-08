import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsJourneyStore, type HandoffInputsDecl, type HandoffOutputsDecl, type Journey } from "@jevitate/journey";
import type { JourneyRunResult } from "@jevitate/runtime";
import { runAsMcpInvocation } from "./approval-provenance.js";
import { runJourneyProgrammatically, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import { guardChainRunner } from "./journey-chain-api.js";
import { runJourneyChain } from "./journey-chain.js";
import { E_JOURNEY_PARAM_TYPE, ParamTypeError, paramTypeRefusalBody, registerParamTypeHooks } from "./journey-param-types.js";
import { resetRunHooksForTests } from "./journey-run-hooks.js";

/** #796: a typed parameter is checked before any browser opens, on every run surface and on a chain handoff. */

const MARKER = "MARKER_secret_value_9f3a";

let dir: string;

function journey(id: string, parameters: Journey["metadata"]["parameters"], extra: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: { id, name: id, promoted: true, params: [], parameters, createdAtIso: "2026-11-08T00:00:00.000Z", ...extra },
    recording: { version: "1.0.0", site: "http://127.0.0.1:9", pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: `/?${(parameters ?? []).map((p) => `${p.name}=\${${p.name}}`).join("&")}`, expect: { kind: "urlIncludes", text: "/" } } }] }] },
  } as unknown as Journey;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-796-"));
  resetRunHooksForTests();
  registerParamTypeHooks();
});

afterEach(async () => {
  resetRunHooksForTests();
  await rm(dir, { recursive: true, force: true });
});

/** A browser port factory that counts launches and never opens one. */
function countingFactory() {
  const launches = { count: 0 };
  const factory = () => {
    launches.count += 1;
    throw new Error("no browser in this test");
  };
  return { launches, factory };
}

async function refusal(run: () => Promise<unknown>): Promise<ParamTypeError> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ParamTypeError);
  return err as ParamTypeError;
}

describe("typed parameters on run", () => {
  it("refuses a number given 'abc' with E_JOURNEY_PARAM_TYPE on the CLI and MCP paths, with identical issues and no launch", async () => {
    await new FsJourneyStore(dir).put(journey("typed", [{ name: "count", type: "number" }]));
    const cli = countingFactory();
    const mcp = countingFactory();
    const opts = (f: () => never): RunJourneyProgrammaticallyOptions => ({ dir, id: "typed", params: { count: "abc" }, browserPortFactory: f as never });

    const cliErr = await refusal(() => runJourneyProgrammatically(opts(cli.factory)));
    const mcpErr = await refusal(() => runAsMcpInvocation(() => runJourneyProgrammatically(opts(mcp.factory))));

    expect(cliErr.code).toBe(E_JOURNEY_PARAM_TYPE);
    expect(mcpErr.code).toBe(E_JOURNEY_PARAM_TYPE);
    expect(cliErr.issues).toEqual([{ name: "count", expected: "number" }]);
    expect(mcpErr.issues).toEqual(cliErr.issues);
    expect(paramTypeRefusalBody(mcpErr)).toEqual(paramTypeRefusalBody(cliErr));
    expect(paramTypeRefusalBody(cliErr)).toMatchObject({ code: E_JOURNEY_PARAM_TYPE, issues: [{ name: "count", expected: "number" }] });
    expect(cli.launches.count).toBe(0);
    expect(mcp.launches.count).toBe(0);
  });

  it("carries no parameter value in the error, its message or its body", async () => {
    await new FsJourneyStore(dir).put(journey("typed", [{ name: "count", type: "number" }, { name: "when", type: "date" }]));
    const { factory } = countingFactory();
    const err = await refusal(() => runJourneyProgrammatically({ dir, id: "typed", params: { count: MARKER, when: `${MARKER}-d` }, browserPortFactory: factory as never }));
    expect(err.issues.map((i) => i.name)).toEqual(["count", "when"]);
    const everything = [err.message, String(err.cause), JSON.stringify(err.issues), JSON.stringify(paramTypeRefusalBody(err)), err.stack ?? ""].join("\n");
    expect(everything).not.toContain("MARKER_");
  });

  it("passes a well-typed value through to the browser step", async () => {
    await new FsJourneyStore(dir).put(journey("typed", [{ name: "count", type: "number" }]));
    const { launches, factory } = countingFactory();
    const err = await runJourneyProgrammatically({ dir, id: "typed", params: { count: "42" }, browserPortFactory: factory as never }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ParamTypeError);
    expect(launches.count).toBeGreaterThan(0);
  });
});

describe("typed parameters on a chain handoff", () => {
  const CONTRACT = "typed-handoff@1";
  const OUTPUTS: HandoffOutputsDecl = {
    contract: CONTRACT,
    collection: "records",
    key: ["id"],
    fields: { id: { type: "id" }, qty: { type: "id" } },
  };
  const INPUTS: HandoffInputsDecl = {
    accepts: CONTRACT,
    request: { fields: { id: { type: "id" } }, key: ["id"] },
    bindings: { id: { record: "id" }, qty: { record: "qty" } },
  };

  function producer(): Journey {
    const extract = (as: string) => ({ kind: "extract" as const, target: { testId: "row" }, as, attr: "data-field", expect: { kind: "attr" as const, target: { testId: "row" }, name: "data-field" } });
    return {
      metadata: { id: "make", name: "make", promoted: true, params: [], createdAtIso: "2026-11-08T00:00:00.000Z", outputs: OUTPUTS },
      recording: {
        version: "1.0.0",
        site: "https://example.test",
        pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } }, { step: { kind: "forEach", items: { testId: "row" }, as: "records", steps: [extract("id"), extract("qty")] } }] }],
      },
    } as unknown as Journey;
  }

  it("fails closed before the consumer's browser opens when a producer emits 'abc' for a number parameter", async () => {
    const store = new FsJourneyStore(dir);
    await store.put(producer());
    await store.put(journey("use", [{ name: "qty", type: "number" }], { params: ["id"], inputs: INPUTS }));

    const consumerLaunches = { count: 0 };
    const inner = async (o: RunJourneyProgrammaticallyOptions): Promise<JourneyRunResult> => {
      if (o.id === "make") return { outcome: "ok", output: { "records.count": "1", "records.0.id": "r-1", "records.0.qty": MARKER } };
      consumerLaunches.count += 1;
      return { outcome: "ok", output: {} };
    };
    const request = `${JSON.stringify({ id: "r-1" })}\n`;

    const result = await runJourneyChain({ from: "make", to: "use", requests: request, dir }, { runJourney: guardChainRunner(inner) });

    expect(consumerLaunches.count).toBe(0);
    expect(result.runs.every((r) => r.outcome !== "ok")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("MARKER_");
    expect(JSON.stringify(result)).toContain(E_JOURNEY_PARAM_TYPE);
  });

  it("guardChainRunner throws the typed refusal itself", async () => {
    await new FsJourneyStore(dir).put(journey("use", [{ name: "qty", type: "number" }]));
    let ran = 0;
    const guarded = guardChainRunner(async () => {
      ran += 1;
      return { outcome: "ok", output: {} };
    });
    const err = await refusal(() => guarded({ dir, id: "use", params: { qty: MARKER } }));
    expect(err.issues).toEqual([{ name: "qty", expected: "number" }]);
    expect(ran).toBe(0);
  });
});
