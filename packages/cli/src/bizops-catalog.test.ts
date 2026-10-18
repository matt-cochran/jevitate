import { describe, expect, it, beforeAll } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findJob, findPersona, journeyLinks, type Catalog } from "./catalog.js";
import { loadCatalog } from "./catalog-api.js";

/**
 * #580: the Bizops fixture project's DRAFT catalog entries. These are `unit` tests — no browser:
 * they prove the two #580 Journeys' `metadata.persona` / `metadata.job` links resolve through the
 * same loader every approval path uses, and that the persona and job are drafts (approval is
 * human-only, so neither may carry an approval block).
 */

const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/bizops-community/", import.meta.url));
const CATALOG_DIR = join(FIXTURE, ".jevitate");
const JOURNEYS_DIR = join(CATALOG_DIR, "journeys");

let catalog: Catalog;

beforeAll(async () => {
  catalog = await loadCatalog(CATALOG_DIR, JOURNEYS_DIR);
});

/** The links of a Journey that name no catalog item (`status` "unknown"). */
const danglingLinks = (catalog: Catalog, journeyId: string): string[] => {
  const journey = catalog.journeys.find((j) => j.id === journeyId);
  if (journey === undefined) return [`journey:${journeyId}`];
  const links = journeyLinks(catalog, journey);
  return [...(links.job?.status === "unknown" ? [`job:${links.job.id}`] : []), ...(links.persona?.status === "unknown" ? [`persona:${links.persona.id}`] : [])];
};

describe("#580 the Bizops community catalog", () => {
  it("declares the bizops-operator persona", () => {
    expect(findPersona(catalog, "bizops-operator")).toBeDefined();
  });

  it("declares the answer-community-comments job", () => {
    expect(findJob(catalog, "answer-community-comments")).toBeDefined();
  });

  it("resolves every link of discover-conversations", () => {
    expect(danglingLinks(catalog, "discover-conversations")).toEqual([]);
  });

  it("resolves every link of prepare-reply", () => {
    expect(danglingLinks(catalog, "prepare-reply")).toEqual([]);
  });

  it("leaves the persona unapproved", () => {
    expect(findPersona(catalog, "bizops-operator")?.status).toBe("draft");
  });

  it("leaves the job unapproved", () => {
    expect(findJob(catalog, "answer-community-comments")?.status).toBe("draft");
  });
});
