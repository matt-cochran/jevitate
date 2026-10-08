import { describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";

/** #428: `jevitate site policy rules` lists the control safety rules so teams can see and tune them. */
async function rules(json: boolean): Promise<string> {
  const lines: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager("/unused") });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(["site", "policy", "rules", ...(json ? ["--json"] : [])], { from: "user" });
  return lines.join("");
}

describe("#428: site policy rules", () => {
  it("--json lists the built-in money heuristic with its regex, waivable by --allow-control", async () => {
    const env = JSON.parse(await rules(true)) as { data: { rules: Array<{ id: string; allowControl: boolean; regex?: string }> } };
    expect(env.data.rules.find((r) => r.id === "builtin:may-cost-money")).toMatchObject({ allowControl: true, regex: expect.stringContaining("generate") });
  });

  it("--json marks every hard rule as not waivable", async () => {
    const env = JSON.parse(await rules(true)) as { data: { rules: Array<{ id: string; allowControl: boolean }> } };
    expect(env.data.rules.filter((r) => r.id !== "builtin:may-cost-money").every((r) => !r.allowControl)).toBe(true);
  });

  it("the human listing names each rule id and whether --allow-control can waive it", async () => {
    expect(await rules(false)).toContain("builtin:destructive  [builtin] not waivable by --allow-control");
  });
});
