import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { BrowserPort } from "@jevitate/playwright";
import { runJourneyProgrammatically } from "./journey-api.js";
import { HttpCheckOffAllowlistError } from "./http-probe.js";

// #543 — `journey run`/`verify` refuse an http end-state check whose origin the replay does not
// allow BEFORE any browser opens; `--allow` admits it.

const journey: Journey = {
  metadata: {
    id: "reset",
    name: "Reset",
    promoted: false,
    params: [],
    createdAtIso: "2026-10-15T00:00:00.000Z",
    endState: [{ kind: "http", method: "GET", url: "http://127.0.0.1:1/outbox", status: { class: 2 } }],
  },
  recording: { version: "1", site: "http://localhost:3001", pages: [{ url: "/", steps: [] }] },
};

let dir: string;
let opened: number;
/** A port that counts launches and then refuses (nothing past the launch matters here). */
const countingPort = (): BrowserPort =>
  ({
    open: async () => {
      opened += 1;
      throw new Error("launch reached");
    },
  }) as unknown as BrowserPort;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-http-refusal-"));
  opened = 0;
  await new FsJourneyStore(dir).put(journey);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("#543 journey run: an http end-state check off the allowlist", () => {
  it("is refused with HttpCheckOffAllowlistError", async () => {
    await expect(runJourneyProgrammatically({ dir, id: "reset", params: {}, browserPortFactory: countingPort })).rejects.toBeInstanceOf(HttpCheckOffAllowlistError);
  });

  it("is refused before any browser opens", async () => {
    await runJourneyProgrammatically({ dir, id: "reset", params: {}, browserPortFactory: countingPort }).catch(() => undefined);
    expect(opened).toBe(0);
  });

  it("is admitted by --allow (the run reaches the browser launch)", async () => {
    await runJourneyProgrammatically({ dir, id: "reset", params: {}, allow: ["http://127.0.0.1:1"], browserPortFactory: countingPort }).catch(() => undefined);
    expect(opened).toBe(1);
  });
});
