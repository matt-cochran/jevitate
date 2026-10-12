/** `createRunContext`: the run's secrets (#219, #359) and the mission context the model is told (#500: moved verbatim out of `context.ts`). */
import { secretFieldContext, secretFieldSecrets } from "../../secret-fields.js";
import { minEffortNote } from "../../run-depth.js";
import { NO_DESTRUCTIVE_NOTE, READ_ONLY_NOTE } from "../../read-only.js";
import { typeFixtureContext } from "../../type-fixtures.js";
import type { ExploreConfig } from "../../explore.js";
import type { MutableRunContext } from "./types.js";

export function initSecrets(ctx: MutableRunContext, cfg: ExploreConfig): void {
  // A bound secret field's value (or TOTP seed) is a run secret: every redaction seam scrubs it.
  ctx.secrets = [...(cfg.secrets ?? []), ...secretFieldSecrets(cfg.secretFields)];
  ctx.secretCommandRuns = new Map();
  ctx.secretContext = secretFieldContext(cfg.secretFields);
  ctx.missionContext = [
      cfg.missionContext,
      ctx.secretContext,
      typeFixtureContext(cfg.typeFixtures),
      cfg.readOnly === true ? READ_ONLY_NOTE : cfg.noDestructiveWrites === true ? NO_DESTRUCTIVE_NOTE : null,
      cfg.minEffort === undefined ? null : minEffortNote(cfg.minEffort),
    ]
      .filter((c): c is string => c !== undefined && c !== null && c !== "")
      .join("; ") || undefined;
}
