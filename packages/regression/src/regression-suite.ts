import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RecordingSchema, type Recording } from "@jevitate/recording";
import type { Actor } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";

export interface RegressionCase {
  id: string;
  recording: Recording;
}

/** Loads every committed `<id>.recording.json` from `dir`. Returns `[]` for
 * a missing directory rather than throwing — an empty/absent regressions
 * directory is a valid ("no regressions yet") state, not an error. */
export async function loadRegressions(dir: string): Promise<RegressionCase[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const ids = files.filter((f) => f.endsWith(".recording.json")).map((f) => f.replace(/\.recording\.json$/, ""));
  const cases: RegressionCase[] = [];
  for (const id of ids) {
    const raw = await readFile(join(dir, `${id}.recording.json`), "utf8");
    cases.push({ id, recording: RecordingSchema.parse(JSON.parse(raw)) });
  }
  return cases;
}

export async function replayRegression(actor: Actor, recording: Recording): Promise<"completed" | "failed"> {
  const result = await new RecordingInterpreter().run(actor, recording);
  return result.outcome === "completed" ? "completed" : "failed";
}
