import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./missions/goal-based.js";
import type { CapturedRequest, DeclaredField, DeclaredFields } from "./page-monitor.js";
import { bodyShapeMismatches, type BodyFieldShape } from "./request-body-values.js";
import { describeCheck, evaluateNetworkCheck, type SuccessCheck } from "./success-checks.js";
import { ScriptedJudge, useSkippingTime, withSession, type ScriptedStep } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

const req = (method: string, path: string, status: number | null = 200): CapturedRequest => ({
  method,
  path,
  url: `https://app.test${path}`,
  status,
  failed: false,
});

const declared = (method: string, path: string, fields: DeclaredField[]): DeclaredFields => ({
  method,
  path,
  url: `https://app.test${path}`,
  fields,
});

const field = (name: string, type: DeclaredField["type"]): DeclaredField => ({ name, type });

describe("counted network checks (#743)", () => {
  it("an exact count holds when the matching request count equals it", () => {
    const check = { kind: "requestMade" as const, method: "POST", pathGlob: "/api/preview", count: { exact: 2 } };
    expect(evaluateNetworkCheck(check, [req("POST", "/api/preview"), req("POST", "/api/preview")]).passed).toBe(true);
  });

  it("an exact count fails when fewer requests matched", () => {
    const check = { kind: "requestMade" as const, method: "POST", pathGlob: "/api/preview", count: { exact: 2 } };
    expect(evaluateNetworkCheck(check, [req("POST", "/api/preview")]).passed).toBe(false);
  });

  it("a minimum count holds at its boundary", () => {
    const check = { kind: "requestMade" as const, method: "POST", pathGlob: "/api/preview", count: { min: 2 } };
    expect(evaluateNetworkCheck(check, [req("POST", "/api/preview"), req("POST", "/api/preview")]).passed).toBe(true);
  });

  it("a minimum count fails below its boundary", () => {
    const check = { kind: "requestMade" as const, method: "POST", pathGlob: "/api/preview", count: { min: 2 } };
    expect(evaluateNetworkCheck(check, [req("POST", "/api/preview")]).passed).toBe(false);
  });

  it("a maximum count holds at its boundary", () => {
    const check = { kind: "requestMade" as const, method: "POST", pathGlob: "/api/preview", count: { max: 1 } };
    expect(evaluateNetworkCheck(check, [req("POST", "/api/preview")]).passed).toBe(true);
  });

  it("a maximum count fails above its boundary", () => {
    const check = { kind: "requestMade" as const, method: "POST", pathGlob: "/api/preview", count: { max: 1 } };
    expect(evaluateNetworkCheck(check, [req("POST", "/api/preview"), req("POST", "/api/preview")]).passed).toBe(false);
  });

  it("a failed count names the expected and the observed request counts", () => {
    const check = { kind: "requestMade" as const, method: "POST", pathGlob: "/api/preview", count: { exact: 2 } };
    expect(evaluateNetworkCheck(check, [req("POST", "/api/preview")]).detail).toContain("expected exactly 2 matching request(s), saw 1");
  });
});

describe("request-body-aware network checks (#743)", () => {
  const check = (fields: BodyFieldShape[]) => ({
    kind: "requestMade" as const,
    method: "POST",
    pathGlob: "/api/preview",
    bodyShape: { fields },
  });

  it("a body shape holds when a matching request carried every declared field", () => {
    const actual = [declared("POST", "/api/preview", [field("voiceId", "string"), field("items", "array")])];
    expect(evaluateNetworkCheck(check([{ name: "voiceId", predicate: "string" }, { name: "items", predicate: "array" }]), [req("POST", "/api/preview")], false, actual).passed).toBe(true);
  });

  it("a body shape failure lists every declared field that was never sent", () => {
    const actual = [declared("POST", "/api/preview", [field("voiceId", "string")])];
    expect(
      evaluateNetworkCheck(check([{ name: "voiceId", predicate: "string" }, { name: "provider", predicate: "string" }, { name: "tone", predicate: "string" }]), [req("POST", "/api/preview")], false, actual).detail,
    ).toContain("provider (missing); tone (missing)");
  });

  it("a body shape fails when a declared field's value had a different type", () => {
    const actual = [declared("POST", "/api/preview", [field("items", "string")])];
    expect(evaluateNetworkCheck(check([{ name: "items", predicate: "array" }]), [req("POST", "/api/preview")], false, actual).detail).toContain("items (expected array, got string)");
  });

  it("an absent predicate holds when the field was not sent", () => {
    const actual = [declared("POST", "/api/preview", [field("voiceId", "string")])];
    expect(evaluateNetworkCheck(check([{ name: "provider", predicate: "absent" }]), [req("POST", "/api/preview")], false, actual).passed).toBe(true);
  });

  it("a credential-named declared field is ignored by the bodyValues key filter", () => {
    expect(bodyShapeMismatches([{ name: "apiToken", predicate: "exists" }], [])).toEqual([]);
  });

  it("a body-shape failure names the field but never a request value", () => {
    const actual = [declared("POST", "/api/preview", [field("note", "string")])];
    expect(evaluateNetworkCheck(check([{ name: "voiceId", predicate: "string" }]), [req("POST", "/api/preview")], false, actual).detail).not.toContain("hunter2");
  });
});

describe("describing counted and body-aware network checks (#743)", () => {
  it("a counted requestMade describes its bound in the --success spec", () => {
    expect(describeCheck({ kind: "requestMade", method: "POST", pathGlob: "/api/preview", count: { exact: 1 } })).toBe("requestMade:POST /api/preview|count=exact:1");
  });

  it("a body-aware requestMade describes its declared fields in the --success spec", () => {
    expect(describeCheck({ kind: "requestMade", method: "POST", pathGlob: "/api/preview", bodyShape: { fields: [{ name: "voiceId", predicate: "string" }] } })).toBe(
      "requestMade:POST /api/preview|body=voiceId:string",
    );
  });
});

/** A served app whose one control fires a POST /api/preview with a declared JSON body. */
const pageFor = (body: string): string => `<!doctype html><html><body><h1>Voices</h1>
<button type="button" id="preview">Preview voice</button>
<script>
document.getElementById("preview").addEventListener("click", () => {
  fetch("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(${body}) });
});
</script></body></html>`;

const PAGES: Record<string, string> = {
  "/full": pageFor(`{ voiceId: "tomas", provider: "elevenlabs" }`),
  "/partial": pageFor(`{ voiceId: "tomas" }`),
};

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/preview") {
      res.writeHead(200, { "content-type": "application/json" }).end("{\"ok\":true}");
      return;
    }
    const body = PAGES[path];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Click Preview once, then propose done; the checks decide the run. */
const PREVIEW_THEN_DONE: ScriptedStep[] = [{ op: "click", target: "0" }, { op: "done" }];

async function run(path: string, checks: SuccessCheck[]): Promise<GoalBasedResult> {
  return withSession(
    "network-count-",
    async (session) => {
      const actor = CastActor.named("network-count").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge: new ScriptedJudge(PREVIEW_THEN_DONE),
        gen: new FakeGenerationGateway(),
        goal: "preview a voice",
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        successChecks: checks,
        oracleTimeoutMs: 300,
        bounds: { maxDecisions: 6 },
      });
    },
    origin,
  );
}

describe("counted network checks against a served app (#743)", () => {
  it("an exact request count of one succeeds", async () => {
    const result = await run("/full", [{ kind: "requestMade", method: "POST", pathGlob: "/api/preview", count: { exact: 1 } }]);
    expect(result.outcome).toBe("succeeded");
  }, 120_000);

  it("a minimum request count of two fails when only one was sent", async () => {
    const result = await run("/full", [{ kind: "requestMade", method: "POST", pathGlob: "/api/preview", count: { min: 2 } }]);
    expect(result.checks[0]?.detail).toContain("expected at least 2 matching request(s), saw 1");
  }, 120_000);

  it("a maximum request count of zero fails when one was sent", async () => {
    const result = await run("/full", [{ kind: "requestMade", method: "POST", pathGlob: "/api/preview", count: { max: 0 } }]);
    expect(result.checks[0]?.detail).toContain("expected at most 0 matching request(s), saw 1");
  }, 120_000);
});

describe("request-body-aware network checks against a served app (#743)", () => {
  it("a declared body shape succeeds when the write carried every declared field", async () => {
    const result = await run("/full", [
      { kind: "requestMade", method: "POST", pathGlob: "/api/preview", bodyShape: { fields: [{ name: "voiceId", predicate: "string" }, { name: "provider", predicate: "string" }] } },
    ]);
    expect(result.outcome).toBe("succeeded");
  }, 120_000);

  it("a failed run names each declared body field the write never sent", async () => {
    const result = await run("/partial", [
      { kind: "requestMade", method: "POST", pathGlob: "/api/preview", bodyShape: { fields: [{ name: "provider", predicate: "string" }] } },
    ]);
    expect(result.checks[0]?.detail).toContain("provider (missing)");
  }, 120_000);
});
