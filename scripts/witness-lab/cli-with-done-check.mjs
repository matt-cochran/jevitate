#!/usr/bin/env node
// #800 witness lab: the built CLI with the job done-check hooks REGISTERED.
//
// Finding (2026-11-09, wave-030-e at e71fb65e): `registerDoneCheckHooks()` is called by no
// production entry (bin.ts, program.ts, mcp-api.ts), only by journey-done-check-served.test.ts, so
// `jevitate journey run` on the built bin never reads a job's done check and its result carries no
// `job` field. This entry registers the hooks once and then runs the real bin unchanged, so the
// witness arm measures the done check as designed (§3.1). Everything else is the shipped code path.
import { registerDoneCheckHooks } from "../../packages/cli/dist/journey-done-check-hook.js";

registerDoneCheckHooks();
await import("../../packages/cli/dist/bin.js");
