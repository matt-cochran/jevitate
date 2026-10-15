import { Command } from "commander";
import { nonNegativeIntArg } from "./cli-args.js";

const collect = (v: string, prev: string[]): string[] => [...prev, v];

/**
 * #142: the backend-log flags `explore` and `explore-author-journey` share, registered from one
 * place so both accept the same flags, defaults and help (byte-identical to `explore`'s). The
 * options are parsed by `serverLogOptionsFromFlags` (`explore-cli/shared.ts`).
 */
export function withServerLogFlags<T extends Command>(cmd: T): T {
  return cmd
    .option(
      "--log-source <spec>",
      "backend log source (repeatable; every strategy, incl. usability): file:<path> (tailed from its current end) | docker:<container> (docker logs -f --since 0s) | cmd:<command> (needs --allow-log-cmd). Read-only, operator-declared, never the model's choice. Error/warning lines are correlated to the step they landed during and attached to its transcript evidence, redacted",
      collect,
      [] as string[],
    )
    .option(
      "--allow-log-cmd",
      "opt-in: a --log-source cmd:<command> may run as a subprocess (operator-declared only; refused otherwise)",
      false,
    )
    .option(
      "--log-defect <level|/regex/>",
      "backend log lines matching this (repeatable) become a server-log defect: a level (error|warn|info|debug, matched as level>=this) or a /regex/flags/ over the raw line. Its fingerprint is the normalized message (ids/numbers/uuids/timestamps stripped) plus the correlated route; verify-fix re-checks it by re-tailing the same --log-source(s)",
      collect,
      [] as string[],
    )
    .option(
      "--log-quiet-ok <spec>",
      "compatibility only since 0.8.0 (#420): a --log-source that opens and reads zero lines is now always a healthy oracle (the silence is recorded as serverLogs.quietSources), so this flag no longer changes any outcome. Kept so existing invocations keep working",
      collect,
      [] as string[],
    )
    .option(
      "--log-ignore <regex|substring>",
      "excludes known-noise backend log lines (repeatable, /regex/flags/ over the raw line or a plain substring) from BOTH correlation and the --log-defect oracle (#169 item 3) — e.g. a periodic background job's own expected error. Counted separately as serverLogs.ignoredLines; never makes --log-quiet-ok unnecessary, since an ignored line still proves the source is being tailed",
      collect,
      [] as string[],
    )
    .option(
      "--log-scope <regex|substring>",
      "attributes only backend log lines matching this (repeatable, /regex/flags/ or a plain substring, e.g. a tenant id) to the run (#282); the rest count as serverLogs.ignoredLines. For concurrent runs tailing one log. A line carrying one of the run's own correlation ids is in scope",
      collect,
      [] as string[],
    )
    .option(
      "--log-correlation-header <name>",
      "another request/response header that carries a correlation id (repeatable; built in: traceparent, x-request-id, x-correlation-id, request-id, x-amzn-trace-id, x-b3-traceid, x-cloud-trace-context). A log line carrying a request's id is attached to that exact request and the step that sent it, not by time (#204)",
      collect,
      [] as string[],
    )
    .option(
      "--log-id-pattern </regex/>",
      "how a correlation id is written in your log lines, when not as trace_id=/request_id=/correlation_id= or a traceparent (repeatable; the first capture group is the id). Once ids correlate, a line with another request's id is never attributed to the run (#204)",
      collect,
      [] as string[],
    )
    .option(
      "--log-triage",
      "#313: record the run's whole signal timeline (backend lines at every level, the browser's console, page errors, failed requests) to <run>.signals.jsonl, " +
        "and attach to each defect only the lines that relate to it (defects[].relatedLogs): code keeps the lines correlated to its request and prefilters its step's window, " +
        "then, with --real, Jev scores each remaining line's relevance (log text goes to the judgment model, redacted — operator opt-in, never an MCP argument). Needs --log-source",
    )
    .option(
      "--server-log-drain-ms <ms>",
      "how long to keep tailing --log-source after the run's last action, to catch async backend work that settles after the browser gave up (default 3000)",
      nonNegativeIntArg,
    );
}
