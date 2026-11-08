import { describe, expect, it } from "vitest";
import { type SentinelGateway, WriteSentinel } from "./write-sentinel.js";

const MARKER_S = "MARKER_S_secret_value";
const redact = (t: string) => t.split(MARKER_S).join("«redacted»");
const input = {
  control: "Delete account",
  method: "POST",
  pathShape: "/account/:id/delete",
  pageSummary: `Settings page for user, token ${MARKER_S}`,
  jobStory: "update my profile name",
};

describe("WriteSentinel", () => {
  it("never sends a declared secret to the gateway", async () => {
    let payload = "";
    const gateway: SentinelGateway = {
      async systemOne(args) {
        payload = JSON.stringify(args);
        return {
          "write.destructive": { kind: "noul", probability: 0.9 },
          "write.outside-intent": { kind: "noul", probability: 0.7 },
        };
      },
    };
    const out = await new WriteSentinel(gateway, redact).judge(input);
    expect(payload).not.toContain(MARKER_S);
    expect(payload).toContain("«redacted»");
    expect(out.judgments.map((j) => [j.task, j.probability, j.advisory])).toEqual([
      ["write.destructive", 0.9, true],
      ["write.outside-intent", 0.7, true],
    ]);
  });

  it("returns [] with jev-unavailable when the gateway rejects, and resolves", async () => {
    const gateway: SentinelGateway = { systemOne: () => Promise.reject(new Error("down")) };
    await expect(new WriteSentinel(gateway, redact).judge(input)).resolves.toEqual({
      judgments: [],
      note: "jev-unavailable",
    });
  });
});
