import { describe, expect, it } from "vitest";
import { secretCommandRunner } from "./secret-command.js";

const node = JSON.stringify(process.execPath);

describe("secretCommandRunner (#324)", () => {
  it("returns the command's stdout and reports the value it read", async () => {
    const seen: string[] = [];
    const run = secretCommandRunner({ onValue: (v) => seen.push(v) });
    expect(await run(`${node} -e "process.stdout.write('482913\\n')"`)).toBe("482913\n");
    expect(seen).toEqual(["482913"]);
  });

  it("a failing or slow command is an error naming only the exit code or the timeout, never its output", async () => {
    const run = secretCommandRunner({ timeoutMs: 1_500 });
    await expect(run(`${node} -e "process.stdout.write('leaked-123'); process.exit(4)"`)).rejects.toThrow(/^it exited with code 4$/);
    await expect(run(`${node} -e "process.stdout.write('leaked-456'); setTimeout(() => {}, 10000)"`)).rejects.toThrow(/^it did not finish within 2s$/);
  }, 20_000);
});
