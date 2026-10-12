/** The run state under construction (#500): every `RunContext` field writable while `createRunContext` assembles it. */
import type { RunContext } from "../context.js";

export type MutableRunContext = { -readonly [K in keyof RunContext]: RunContext[K] };
