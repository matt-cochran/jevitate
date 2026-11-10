import { describe, expect, it } from "vitest";
import { type SentinelGateway, WriteSentinel } from "./write-sentinel.js";

const MARKER_S = "MARKER_S_secret_value";
const redact = (t: string) => t.split(MARKER_S).join("«redacted»");
const input = {
  control: { role: "button", name: `Delete account ${MARKER_S}` },
  method: "POST",
  pathShape: "/account/:id/delete",
  job: { id: "update-profile", title: "update my profile name" },
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

  it("has no field that carries page text: the payload is only the structured input", async () => {
    let payload = "";
    const gateway: SentinelGateway = {
      async systemOne(args) {
        payload = JSON.stringify(args);
        return {};
      },
    };
    await new WriteSentinel(gateway, redact).judge({ ...input, pageSummary: "PAGE_TEXT", jobStory: "PAGE_TEXT" } as never);
    expect(payload).not.toContain("PAGE_TEXT");
    expect(payload).toContain("update-profile");
    expect(payload).toContain('POST button');
  });

  it("GAPS 17: asks about the control's effect, not the job", async () => {
    let questions: Record<string, { instructions?: string }> = {};
    const gateway: SentinelGateway = {
      async systemOne(args) {
        questions = args.questions;
        return {};
      },
    };
    await new WriteSentinel(gateway, redact).judge(input);
    expect(questions["write.destructive"]?.instructions).toBe("Does clicking this control delete, erase, overwrite, revoke or cancel saved data or access?");
    expect(questions["write.outside-intent"]?.instructions).toBe("Is this pending write outside what the job intends the user to do?");
  });

  it("returns [] with jev-unavailable when the gateway rejects, and resolves", async () => {
    const gateway: SentinelGateway = { systemOne: () => Promise.reject(new Error("down")) };
    await expect(new WriteSentinel(gateway, redact).judge(input)).resolves.toEqual({
      judgments: [],
      note: "jev-unavailable",
    });
  });
});
