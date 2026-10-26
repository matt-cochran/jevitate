import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditCoreAcceptanceAssets } from "./acceptance-audit.js";

describe("#686 core acceptance-asset audit", () => {
  it("classifies each explicitly named asset without inferring missing mappings", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevitate-acceptance-"));
    const requirements = join(root, "requirements.md");
    const emptyPersona = join(root, "persona.md");
    await writeFile(requirements, "# Requirement\n", "utf8");
    await writeFile(emptyPersona, "", "utf8");
    const result = await auditCoreAcceptanceAssets({ requirements, persona: emptyPersona, sourceJourney: join(root, "journey.json") });
    expect(result).toEqual([
      { asset: "requirements", state: "complete", path: requirements },
      { asset: "persona", state: "inconclusive", path: emptyPersona, reason: "local file is empty" },
      { asset: "source-journey", state: "missing", path: join(root, "journey.json"), reason: "local file does not exist" },
      { asset: "approved-hash", state: "missing", reason: "no explicit local path supplied" },
      { asset: "verify-fix", state: "missing", reason: "no explicit local path supplied" },
      { asset: "strict-review", state: "missing", reason: "no explicit local path supplied" },
    ]);
  });
});
