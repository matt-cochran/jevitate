import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { JourneySchema, type Journey } from "@doit/journey";
import { SourceValidationError } from "./errors.js";

export interface SiteDeclaration {
  origin: string;
  automationPolicy: "allowed";
  touBasis: string;
}

export interface JevitateManifest {
  version: 1;
  source: string;
  sites: SiteDeclaration[];
}

export interface SharedJourneyFile extends Journey {
  declaredOrigins: string[];
}

const SiteDeclarationSchema = z
  .object({
    origin: z.string().url(),
    automationPolicy: z.literal("allowed"),
    touBasis: z.string().min(1),
  })
  .strict();

export const JevitateManifestSchema: z.ZodType<JevitateManifest> = z
  .object({
    version: z.literal(1),
    source: z.string().min(1),
    sites: z.array(SiteDeclarationSchema),
  })
  .strict();

export const SharedJourneyFileSchema = z.intersection(
  JourneySchema,
  z.object({ declaredOrigins: z.array(z.string().url()).min(1) }).strict(),
) as unknown as z.ZodType<SharedJourneyFile>;

function isNodeError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

/**
 * Loads and validates `<cloneDir>/jevitate.json`. Missing/malformed/unknown
 * top-level keys/unsupported `version` ⇒ `SourceValidationError` (fail-closed
 * — a source is a trust boundary; there is no permissive default manifest).
 */
export async function loadManifest(cloneDir: string): Promise<JevitateManifest> {
  const path = join(cloneDir, "jevitate.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new SourceValidationError(`missing or unreadable jevitate.json at '${path}': ${String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SourceValidationError(`jevitate.json at '${path}' is not valid JSON: ${String(err)}`);
  }
  const result = JevitateManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new SourceValidationError(`jevitate.json at '${path}' failed validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Scans `<cloneDir>/journeys/*.journey.json` and validates each against
 * `SharedJourneyFileSchema`. Unlike the tolerant local `FsJourneyStore.list`
 * (which skips a corrupt file), a source is a trust boundary: ONE bad file
 * fails the WHOLE load, never a silent partial list.
 */
export async function loadJourneyFiles(cloneDir: string): Promise<SharedJourneyFile[]> {
  const journeysDir = join(cloneDir, "journeys");
  let entries: string[];
  try {
    entries = await readdir(journeysDir);
  } catch (err) {
    if (isNodeError(err, "ENOENT")) {
      throw new SourceValidationError(`no journeys/ directory at '${journeysDir}'`);
    }
    throw err;
  }

  const files: SharedJourneyFile[] = [];
  for (const entry of entries.filter((e) => e.endsWith(".journey.json")).sort()) {
    const path = join(journeysDir, entry);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      throw new SourceValidationError(`unreadable journey file '${path}': ${String(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SourceValidationError(`journey file '${path}' is not valid JSON: ${String(err)}`);
    }
    const result = SharedJourneyFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new SourceValidationError(`journey file '${path}' failed validation: ${result.error.message}`);
    }
    files.push(result.data);
  }
  return files;
}
