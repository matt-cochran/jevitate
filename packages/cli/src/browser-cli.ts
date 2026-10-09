import { Command } from "commander";
import { installBrowser, pinnedBrowserReport, type PinnedBrowserReport, type SpawnFn } from "@jevitate/playwright";
import { fail, ok } from "./envelope.js";
import { emitJsonOrRefusal } from "./cli-refusal.js";

/** #450: the shared pinned browser — `jevitate install-browser` and `jevitate browser-path`. */

export interface BrowserCliDeps {
  spawn?: SpawnFn;
  report?: () => PinnedBrowserReport;
}

/** Human lines for the pinned-browser state (browser-path and doctor). */
export function formatPinnedBrowser(r: PinnedBrowserReport): string {
  const lines = [`browsers dir: ${r.browsersDir}`, `executable: ${r.executablePath}`];
  for (const b of r.browsers) {
    const other = b.state === "other-revisions-only" ? ` (found revision ${b.otherRevisions.join(", ")})` : "";
    lines.push(`pinned ${b.browser} r${b.revision}: ${b.state}${other}`);
  }
  if (r.fix !== null) lines.push(`fix: ${r.fix}`);
  return `${lines.join("\n")}\n`;
}

export function registerBrowserCommands(program: Command, deps: BrowserCliDeps = {}): void {
  program
    .command("install-browser")
    .description("install the Chromium revision jevitate pins into the shared browsers dir (never removes other revisions)")
    .option("--with-deps", "also install OS packages the browser needs (may need privileges)")
    .action(async function (this: Command) {
      const o = this.opts<{ withDeps?: boolean }>();
      try {
        const code = await installBrowser({ ...(o.withDeps === true ? { withDeps: true } : {}), ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }) });
        if (code !== 0) process.exitCode = code;
      } catch (err) {
        emitJsonOrRefusal(program, fail("E_INSTALL_BROWSER", err instanceof Error ? err.message : String(err)));
      }
    });

  program
    .command("browser-path")
    .description("print the pinned browser revision(s), the browsers dir in use and the executable path")
    .option("--json", "emit a JSON envelope")
    .option("--export", "print only the PLAYWRIGHT_BROWSERS_PATH export line for a project script")
    .action(function (this: Command) {
      const o = this.opts<{ json?: boolean; export?: boolean }>();
      try {
        const r = (deps.report ?? pinnedBrowserReport)();
        if (o.json === true) emitJsonOrRefusal(program, ok(r));
        else program.configureOutput().writeOut?.(o.export === true ? `${r.exportLine}\n` : `${formatPinnedBrowser(r)}${r.exportLine}\n`);
      } catch (err) {
        emitJsonOrRefusal(program, fail("E_BROWSER_PATH", err instanceof Error ? err.message : String(err)));
      }
    });
}
