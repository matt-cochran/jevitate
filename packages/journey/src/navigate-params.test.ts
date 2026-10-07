import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsJourneyStore, JourneySchema, deriveParamSchema, describeStep, type Journey } from "./index.js";

/** #399: a Journey's navigate URL may take declared `${param}` placeholders. */

function inviteJourney(meta: Partial<Journey["metadata"]> = {}, url = "/accept?token=${inviteToken}"): Journey {
  return {
    metadata: {
      id: "accept-invite",
      name: "Accept an invitation",
      promoted: false,
      params: [],
      parameters: [{ name: "inviteToken", secret: true }],
      createdAtIso: "2026-10-07T00:00:00.000Z",
      ...meta,
    },
    recording: {
      version: "1",
      site: "http://127.0.0.1:1",
      pages: [{ url: "/accept", steps: [{ step: { kind: "navigate", url, expect: { kind: "urlIncludes", text: "/accept" } } }] }],
    },
  };
}

describe("navigate placeholders (#399)", () => {
  it("a placeholder naming a declared parameter (parameters[] or params[]) loads", () => {
    expect(JourneySchema.safeParse(inviteJourney()).success).toBe(true);
    expect(JourneySchema.safeParse(inviteJourney({ params: ["inviteToken"], parameters: undefined })).success).toBe(true);
  });

  it("a placeholder naming an undeclared parameter is refused, naming it", () => {
    const r = JourneySchema.safeParse(inviteJourney({ parameters: [{ name: "other" }] }));
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message).join("\n")).toMatch(/inviteToken.*not a declared parameter/);
  });

  it("is refused at load time from disk (the store never hands it to a runner)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jv-399-"));
    try {
      const j = inviteJourney({ parameters: [] });
      await writeFile(join(dir, `${j.metadata.id}.json`), JSON.stringify(j));
      await expect(new FsJourneyStore(dir).get(j.metadata.id)).rejects.toThrow(/inviteToken/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a placeholder before the origin is refused at load time", () => {
    expect(JourneySchema.safeParse(inviteJourney({ params: ["host"] }, "https://${host}/accept")).success).toBe(false);
  });

  it("the placeholder is a required run parameter", () => {
    expect(deriveParamSchema(inviteJourney().recording).required).toEqual(["inviteToken"]);
  });

  it("describeStep shows the placeholder as <param name>", () => {
    expect(describeStep(inviteJourney().recording.pages[0]!.steps[0]!.step)).toBe("navigate to /accept?token=<param inviteToken>");
  });
});
