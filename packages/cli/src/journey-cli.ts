import type { Command } from "commander";
import type { CliDeps } from "./cli-shared.js";
import { registerJourneyList } from "./journey-cli/list.js";
import { registerJourneyFind } from "./journey-cli/find.js";
import { registerJourneyRun } from "./journey-cli/run.js";
import { registerJourneyPromote } from "./journey-cli/promote.js";
import { registerJourneyReview } from "./journey-cli/review.js";
import { registerJourneyMigrate } from "./journey-cli/migrate.js";
import { registerJourneyLint } from "./journey-cli/lint.js";
import { registerJourneyVerify } from "./journey-cli/verify.js";
import { registerJourneyAnchors } from "./journey-cli/anchors.js";
import { registerJourneyPublish } from "./journey-cli/publish.js";
import { registerJourneyAnchorCommands } from "./journey-anchor-cli.js";
import { registerJourneyAnnotateCommand } from "./journey-annotate-cli.js";
import { registerJourneyDemoCommand } from "./journey-demo-cli.js";

/** Registers `jevitate journey`: `list|find|run|promote|lint|verify|anchors|annotate|demo|publish`. */
export function registerJourneyCommands(program: Command, deps: CliDeps): void {
  const journey = program.command("journey").description("manage and run promoted Journeys (regression-test replays)");

  registerJourneyList(journey, program, deps);
  registerJourneyFind(journey, program, deps);
  registerJourneyRun(journey, program, deps);
  registerJourneyPromote(journey, program, deps);
  registerJourneyReview(journey, program, deps);
  registerJourneyMigrate(journey, program, deps);
  registerJourneyLint(journey, program, deps);
  registerJourneyVerify(journey, program, deps);
  registerJourneyAnchors(journey, program, deps);

  // #487 — add/remove a draft Journey's anchors with the step id written at once.
  registerJourneyAnchorCommands(journey, program, deps);

  // #246 — draft a Journey's intent on playback; `--approve` is the human gate that writes it.
  registerJourneyAnnotateCommand(journey, program, deps);

  // #248 — replay a Journey as a narrated demo: video + subtitles and/or a step-by-step guide.
  registerJourneyDemoCommand(journey, program, deps);

  registerJourneyPublish(journey, program, deps);
}
