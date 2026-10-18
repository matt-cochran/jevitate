import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FsJourneyStore, JourneySchema, lintJourney, type Journey } from "@jevitate/journey";

/**
 * #580: the two reusable Journey files the offline Bizops comment workflow chains together. These are
 * `unit` tests — no browser, no fixture server: they prove the files load through the same store and
 * schema a run uses, and that the discover/prepare pair passes the assertion-strength lint (no
 * error-level findings) with the prepare Journey ending at a filled composer and never submitting.
 */

const JOURNEYS = fileURLToPath(new URL("../../../test/fixtures/bizops-community/.jevitate/journeys/", import.meta.url));

const store = new FsJourneyStore(JOURNEYS);

const load = async (id: string): Promise<Journey> => {
  const journey = await store.get(id);
  if (journey === null) throw new Error(`Journey ${id} is missing from ${JOURNEYS}`);
  return journey;
};

const parseFile = async (id: string): Promise<unknown> => JSON.parse(await readFile(join(JOURNEYS, `${id}.json`), "utf8"));

/** Every top-level step of a Journey, in recording order (a `forEach`'s children stay inside it). */
const topLevelSteps = (journey: Journey): Journey["recording"]["pages"][number]["steps"][number]["step"][] =>
  journey.recording.pages.flatMap((page) => page.steps.map((recorded) => recorded.step));

describe("#580 the Bizops community Journeys", () => {
  it("parses discover-conversations with JourneySchema", async () => {
    expect(JourneySchema.safeParse(await parseFile("discover-conversations")).success).toBe(true);
  });

  it("parses prepare-reply with JourneySchema", async () => {
    expect(JourneySchema.safeParse(await parseFile("prepare-reply")).success).toBe(true);
  });

  it("loads discover-conversations through FsJourneyStore", async () => {
    expect((await load("discover-conversations")).metadata.id).toBe("discover-conversations");
  });

  it("loads prepare-reply through FsJourneyStore", async () => {
    expect((await load("prepare-reply")).metadata.id).toBe("prepare-reply");
  });

  it("lints discover-conversations with no error-level findings", async () => {
    expect(lintJourney(await load("discover-conversations")).filter((finding) => finding.level === "error")).toEqual([]);
  });

  it("lints prepare-reply with no error-level findings", async () => {
    expect(lintJourney(await load("prepare-reply")).filter((finding) => finding.level === "error")).toEqual([]);
  });

  it("keeps prepare-reply free of any click or press step", async () => {
    expect(topLevelSteps(await load("prepare-reply")).filter((step) => step.kind === "click" || step.kind === "press")).toEqual([]);
  });

  it("ends prepare-reply at the replyText fill", async () => {
    const steps = topLevelSteps(await load("prepare-reply"));
    expect(steps[steps.length - 1]).toMatchObject({ kind: "fill", target: { testId: "reply-body" }, value: { var: "replyText" } });
  });
});
