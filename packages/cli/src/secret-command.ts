/**
 * #324 — the runner behind `--secret-field '<key>=<value>=cmd:<command>'` (operator opt-in,
 * `--allow-secret-cmd`; never an MCP argument): the command runs in a shell when its field is about
 * to be typed, and its stdout is the value. Bounded (a timeout kills its whole process group);
 * stdout is capped. An error names only the exit code or the timeout — never the output, which may
 * be the secret itself.
 */
import { spawn } from "node:child_process";
import type { SecretCommandRunner } from "@jevitate/explore";
import { clock } from "@jevitate/domain";

/** How long one read may take (a mail or SMS outbox poll). */
export const SECRET_COMMAND_TIMEOUT_MS = 60_000;
const MAX_STDOUT = 64 * 1024;

export function secretCommandRunner(opts: { readonly timeoutMs?: number; readonly onValue?: (value: string) => void } = {}): SecretCommandRunner {
  const timeoutMs = opts.timeoutMs ?? SECRET_COMMAND_TIMEOUT_MS;
  return (command) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(command, { shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      let timedOut = false;
      const timer = clock.setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < MAX_STDOUT) stdout += d.toString("utf8");
      });
      child.on("error", (e) => {
        clock.clearTimeout(timer);
        reject(new Error(`could not start it (${e.message.split("\n")[0]})`));
      });
      child.on("close", (code) => {
        clock.clearTimeout(timer);
        if (timedOut) return reject(new Error(`it did not finish within ${Math.round(timeoutMs / 1000)}s`));
        if (code !== 0) return reject(new Error(`it exited with code ${code}`));
        const value = stdout.trim();
        if (value !== "") opts.onValue?.(value);
        resolve(stdout);
      });
    });
}
