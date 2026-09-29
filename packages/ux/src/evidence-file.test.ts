import { describe, expect, it } from "vitest";
import { evidenceFromFile, parseUxEvidenceFile, persistableScreen, UxEvidenceFileError, type UxEvidenceFile } from "./evidence-file.js";
import type { UxEvidence } from "./types.js";

const SECRET = "canary-7f3e9b";

const screen: UxEvidence = {
  screenId: "sig-1",
  url: `https://app.test/settings?token=${SECRET}`,
  controls: [
    { index: 0, role: "textbox", name: "API key", tag: "input", inputType: "text", enabled: true, summary: `textbox "API key" (value="${SECRET}")`, descriptor: { role: "textbox", name: "API key" } },
  ],
  visibleText: `Settings\nYour key: ${SECRET}`,
  appContext: { appClass: "admin", job: "rotate the key" },
  job: "rotate the key",
  history: [],
  behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 0, errors: 0 },
  a11yFacts: { controls: [] },
  typedValues: ["Team A"],
};

describe("evidence sidecar (#134)", () => {
  it("persists a screen only through the redaction door — no secret, no descriptor", () => {
    const p = persistableScreen(screen, [SECRET]);
    expect(JSON.stringify(p)).not.toContain(SECRET);
    expect(p.visibleText).toContain("Settings");
    expect(p.controls[0]).not.toHaveProperty("descriptor");
    expect(p.controls[0]).toMatchObject({ index: 0, role: "textbox", name: "API key", enabled: true });
    expect(p.typedValues).toEqual(["Team A"]);
  });

  it("round-trips through JSON and validates its shape", () => {
    const file: UxEvidenceFile = {
      version: 1,
      appContext: { appClass: "admin", job: "rotate the key" },
      job: "rotate the key",
      screens: [persistableScreen(screen, [SECRET])],
      signals: { steps: [{ step: 1, op: "click", target: null, actOk: true, url: "https://app.test/settings", reply: "ok" }], requests: [], screens: [], endedAt: 10 },
      outcome: { status: "incomplete", reason: "blocked" },
    };
    const back = parseUxEvidenceFile(JSON.parse(JSON.stringify(file)));
    expect(back).toEqual(file);
    expect(() => parseUxEvidenceFile({ version: 2 })).toThrow(UxEvidenceFileError);
    expect(() => parseUxEvidenceFile({ ...file, screens: [{ screenId: 1 }] })).toThrow(/not a usability evidence file/);
  });

  it("offline app context wins field by field; the live job fills what it leaves unset", () => {
    const file = parseUxEvidenceFile(
      JSON.parse(JSON.stringify({ version: 1, appContext: { appClass: "admin", job: "rotate the key" }, job: "rotate the key", screens: [persistableScreen(screen, [SECRET])], signals: { steps: [], requests: [], screens: [], endedAt: 0 } })),
    );
    const { screens, appContext } = evidenceFromFile(file, { appClass: "consumer" });
    expect(appContext).toEqual({ appClass: "consumer", job: "rotate the key" });
    expect(screens[0]).toMatchObject({ appContext: { appClass: "consumer" }, job: "rotate the key", screenId: "sig-1" });
  });
});
