import { describe, it, expect } from "vitest";
import {
  MissionTargetSchema,
  MissionRequestSchema,
  QueuedMissionSchema,
  targetAllowlist,
} from "./schema.js";

const validTarget = {
  id: "demo-shop",
  name: "Demo shop",
  description: "The staging demo shop",
  authorizedOrigin: "https://demo.example.com",
  baseUrl: "https://demo.example.com",
  promoted: true,
  createdAtIso: "2026-09-20T00:00:00Z",
};

describe("MissionTargetSchema", () => {
  it("accepts a well-formed target", () => {
    expect(() => MissionTargetSchema.parse(validTarget)).not.toThrow();
  });

  it("rejects an id containing a path separator or '..'", () => {
    for (const badId of ["a/b", "a\\b", "../etc/passwd", "..", ""]) {
      expect(() => MissionTargetSchema.parse({ ...validTarget, id: badId })).toThrow();
    }
  });

  it("rejects an unknown extra key", () => {
    expect(() => MissionTargetSchema.parse({ ...validTarget, bogus: 1 })).toThrow();
  });

  it("accepts declared API origins, and targetAllowlist is the app origin plus them (#117)", () => {
    const t = MissionTargetSchema.parse({ ...validTarget, apiOrigins: ["https://api.example.com", "http://127.0.0.1:18582"] });
    expect(targetAllowlist(t)).toEqual(["https://demo.example.com", "https://api.example.com", "http://127.0.0.1:18582"]);
    expect(targetAllowlist(MissionTargetSchema.parse(validTarget))).toEqual(["https://demo.example.com"]);
  });

  it("validates every origin: a bare http(s) origin only — no path, credentials, wildcard or other scheme", () => {
    for (const bad of [
      "https://api.example.com/",
      "https://api.example.com/v1",
      "https://user:pw@api.example.com",
      "https://*.example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "api.example.com",
      "",
    ]) {
      expect(() => MissionTargetSchema.parse({ ...validTarget, apiOrigins: [bad] }), bad).toThrow();
      expect(() => MissionTargetSchema.parse({ ...validTarget, authorizedOrigin: bad }), bad).toThrow();
    }
  });

  it("refuses a baseUrl that is not on the target's authorized origin", () => {
    expect(() => MissionTargetSchema.parse({ ...validTarget, baseUrl: "https://elsewhere.example.com/app" })).toThrow();
    expect(() => MissionTargetSchema.parse({ ...validTarget, baseUrl: "https://demo.example.com/app/settings" })).not.toThrow();
  });
});

const validAssertion = { kind: "urlIncludes", text: "/checkout" };

const baseRequest = {
  target: "demo-shop",
  goal: "verify checkout completes",
  successAssertion: validAssertion,
  strategy: "goal-based",
};

describe("MissionRequestSchema", () => {
  it("accepts a request with exactly one of goal/feature/route", () => {
    expect(() => MissionRequestSchema.parse(baseRequest)).not.toThrow();
    expect(() =>
      MissionRequestSchema.parse({ ...withoutGoalFeatureRoute(baseRequest), feature: "checkout" }),
    ).not.toThrow();
    expect(() =>
      MissionRequestSchema.parse({ ...withoutGoalFeatureRoute(baseRequest), route: "/checkout" }),
    ).not.toThrow();
  });

  it("rejects zero of goal/feature/route", () => {
    expect(() => MissionRequestSchema.parse(withoutGoalFeatureRoute(baseRequest))).toThrow();
  });

  it("rejects two of goal/feature/route", () => {
    expect(() =>
      MissionRequestSchema.parse({ ...baseRequest, feature: "checkout" }),
    ).toThrow();
  });

  it("rejects all three of goal/feature/route", () => {
    expect(() =>
      MissionRequestSchema.parse({ ...baseRequest, feature: "checkout", route: "/checkout" }),
    ).toThrow();
  });

  it("rejects an unknown top-level key", () => {
    expect(() => MissionRequestSchema.parse({ ...baseRequest, bogus: 1 })).toThrow();
  });

  it("rejects an unsupported strategy value (a usability review needs inputs the request cannot carry)", () => {
    for (const strategy of ["usability", "induction", "exploratory"]) {
      expect(() => MissionRequestSchema.parse({ ...baseRequest, strategy })).toThrow();
    }
  });

  it("accepts coverage/adversarial with no goal and no success assertion, optionally scoped by a route glob (#117)", () => {
    for (const strategy of ["coverage", "adversarial"]) {
      expect(() => MissionRequestSchema.parse({ target: "demo-shop", strategy })).not.toThrow();
      expect(() => MissionRequestSchema.parse({ target: "demo-shop", strategy, route: "/thread/**" })).not.toThrow();
      // A goal or a success assertion has no meaning for these — refused, never silently dropped.
      expect(() => MissionRequestSchema.parse({ target: "demo-shop", strategy, goal: "g" })).toThrow();
      expect(() => MissionRequestSchema.parse({ target: "demo-shop", strategy, successAssertion: validAssertion })).toThrow();
      expect(() => MissionRequestSchema.parse({ target: "demo-shop", strategy, feature: "checkout" })).toThrow();
      expect(() => MissionRequestSchema.parse({ target: "demo-shop", strategy, route: "thread/**" })).toThrow();
    }
  });

  it("strategy feature requires its feature name (#117)", () => {
    expect(() => MissionRequestSchema.parse({ target: "demo-shop", strategy: "feature", feature: "checkout" })).not.toThrow();
    expect(() =>
      MissionRequestSchema.parse({ target: "demo-shop", strategy: "feature", feature: "checkout", route: "/checkout/**" }),
    ).not.toThrow();
    expect(() => MissionRequestSchema.parse({ target: "demo-shop", strategy: "feature" })).toThrow();
  });

  it("goal-based still requires its success assertion", () => {
    const { successAssertion, ...rest } = baseRequest;
    expect(() => MissionRequestSchema.parse(rest)).toThrow();
  });

  it("accepts an omitted budget", () => {
    expect(() => MissionRequestSchema.parse(baseRequest)).not.toThrow();
  });

  it("accepts a provided partial budget (ceiling enforcement is enqueueMission's job, not the schema's)", () => {
    expect(() =>
      MissionRequestSchema.parse({ ...baseRequest, budget: { maxActions: 999999 } }),
    ).not.toThrow();
  });

  it("rejects an unknown key inside budget", () => {
    expect(() =>
      MissionRequestSchema.parse({ ...baseRequest, budget: { bogus: 1 } }),
    ).toThrow();
  });

  describe("viewport/device emulation (#149)", () => {
    it("accepts a coverage request with a viewport, or with a device name", () => {
      expect(() =>
        MissionRequestSchema.parse({ target: "demo-shop", strategy: "coverage", viewport: { width: 375, height: 812 } }),
      ).not.toThrow();
      expect(() =>
        MissionRequestSchema.parse({ target: "demo-shop", strategy: "coverage", device: "iPhone 13" }),
      ).not.toThrow();
    });

    it("rejects viewport and device together (mutually exclusive)", () => {
      expect(() =>
        MissionRequestSchema.parse({
          target: "demo-shop",
          strategy: "coverage",
          viewport: { width: 375, height: 812 },
          device: "iPhone 13",
        }),
      ).toThrow();
    });

    it("rejects a non-positive or non-integer viewport dimension", () => {
      expect(() =>
        MissionRequestSchema.parse({ target: "demo-shop", strategy: "coverage", viewport: { width: 0, height: 812 } }),
      ).toThrow();
      expect(() =>
        MissionRequestSchema.parse({ target: "demo-shop", strategy: "coverage", viewport: { width: 375.5, height: 812 } }),
      ).toThrow();
    });

    it("rejects an empty device name", () => {
      expect(() => MissionRequestSchema.parse({ target: "demo-shop", strategy: "coverage", device: "" })).toThrow();
    });
  });
});

function withoutGoalFeatureRoute<T extends Record<string, unknown>>(req: T): Omit<T, "goal" | "feature" | "route"> {
  const { goal, feature, route, ...rest } = req as any;
  return rest;
}

describe("QueuedMissionSchema", () => {
  const queued = {
    ...baseRequest,
    budget: { maxActions: 60, maxDecisions: 120, maxCandidates: 250 },
    id: "m-1",
    status: "queued",
    enqueuedAtIso: "2026-09-20T00:00:00Z",
  };

  it("accepts a fully-resolved QueuedMission", () => {
    expect(() => QueuedMissionSchema.parse(queued)).not.toThrow();
  });

  it("rejects a missing status", () => {
    const { status, ...rest } = queued;
    expect(() => QueuedMissionSchema.parse(rest)).toThrow();
  });

  it("carries the drain lifecycle: running, done with a result id, failed with an error (#117)", () => {
    expect(() => QueuedMissionSchema.parse({ ...queued, status: "running", startedAtIso: "2026-09-20T00:00:01Z" })).not.toThrow();
    expect(() =>
      QueuedMissionSchema.parse({ ...queued, status: "done", resultId: "explore-2026-09-20T00-00-02-000Z", missionOutcome: "succeeded", exitCode: 0 }),
    ).not.toThrow();
    expect(() => QueuedMissionSchema.parse({ ...queued, status: "failed", error: "unknown or unpromoted mission target" })).not.toThrow();
    expect(() => QueuedMissionSchema.parse({ ...queued, status: "bogus" })).toThrow();
    expect(() => QueuedMissionSchema.parse({ ...queued, status: "done", resultId: "../../etc/passwd" })).toThrow();
  });
});
