import { describe, it, expect } from "vitest";
import {
  MissionTargetSchema,
  MissionRequestSchema,
  QueuedMissionSchema,
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

  it("rejects an unsupported strategy value", () => {
    expect(() =>
      MissionRequestSchema.parse({ ...baseRequest, strategy: "adversarial" }),
    ).toThrow();
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
});
