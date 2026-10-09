import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  ChangesArgsError,
  ChangesInputError,
  parseChangeRange,
  readChangeScope,
  validateChangeNotes,
  type GitExec,
} from "./change-context.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const DIFF = [
  "diff --git a/src/Button.tsx b/src/Button.tsx",
  "@@ -1 +1 @@",
  '-<button data-testid="create">Create New</button>',
  '+<button data-testid="create">Create</button>',
].join("\n");

interface Call {
  readonly args: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/** A fake git that records argv and answers rev-parse/merge-base/diff deterministically. */
function recordingExec(diff: string): { exec: GitExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: GitExec = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd, env: opts.env });
    if (args[0] === "rev-parse") {
      return { stdout: `${args[args.length - 1] === "HEAD^{commit}" ? SHA_B : SHA_A}\n` };
    }
    if (args[0] === "merge-base") return { stdout: `${SHA_A}\n` };
    return { stdout: diff };
  };
  return { exec, calls };
}

test("parseChangeRange accepts a linear commit range", () => {
  expect(parseChangeRange("HEAD~1..HEAD")).toEqual({ from: "HEAD~1", to: "HEAD", symmetric: false });
});

test("parseChangeRange accepts a symmetric range", () => {
  expect(parseChangeRange("main...feature")).toEqual({ from: "main", to: "feature", symmetric: true });
});

test("parseChangeRange treats a single revision as a range to HEAD", () => {
  expect(parseChangeRange("abc123")).toEqual({ from: "abc123", to: "HEAD", symmetric: false });
});

test.each(["-x", "--output=/tmp/x", "a..b..c", "HEAD@{-1}", "$(id)", "a;id", "a b", "", "a\u0000b", "..HEAD"])(
  "parseChangeRange refuses %j",
  (value) => {
    expect(() => parseChangeRange(value)).toThrow(ChangesArgsError);
  },
);

test("validateChangeNotes refuses more than twenty notes", () => {
  expect(() => validateChangeNotes(Array.from({ length: 21 }, (_, i) => `note ${i}`))).toThrow(ChangesArgsError);
});

test("validateChangeNotes refuses a note longer than two thousand characters", () => {
  expect(() => validateChangeNotes(["n".repeat(2001)])).toThrow(ChangesArgsError);
});

test("readChangeScope passes --end-of-options to rev-parse", async () => {
  const { exec, calls } = recordingExec(DIFF);

  await readChangeScope({ cwd: "/repo", range: "HEAD~1..HEAD", notes: [], exec });

  expect(calls.find((call) => call.args[0] === "rev-parse")?.args).toEqual([
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    "HEAD~1^{commit}",
  ]);
});

test("readChangeScope passes only resolved 40-hex SHAs to diff", async () => {
  const { exec, calls } = recordingExec(DIFF);

  await readChangeScope({ cwd: "/repo", range: "HEAD~1..HEAD", notes: [], exec });

  expect(calls.find((call) => call.args[0] === "-c")?.args).toEqual([
    "-c",
    "core.fsmonitor=",
    "-c",
    "diff.external=",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "-M",
    "--unified=0",
    `${SHA_A}..${SHA_B}`,
    "--",
  ]);
});

test("readChangeScope refuses an unresolvable revision", async () => {
  const exec: GitExec = async () => {
    throw new Error("fatal: bad revision");
  };

  await expect(readChangeScope({ cwd: "/repo", range: "nope..HEAD", notes: [], exec })).rejects.toThrow(
    ChangesInputError,
  );
});

test("readChangeScope refuses a diff over the byte limit", async () => {
  const { exec } = recordingExec(DIFF);

  await expect(
    readChangeScope({ cwd: "/repo", range: "a..b", notes: [], exec, limits: { maxBytes: 8 } }),
  ).rejects.toThrow(ChangesInputError);
});

test("readChangeScope refuses a diff over the file limit", async () => {
  const twoFiles = `${DIFF}\ndiff --git a/src/Other.tsx b/src/Other.tsx\n@@ -1 +1 @@\n-a\n+b`;
  const { exec } = recordingExec(twoFiles);

  await expect(
    readChangeScope({ cwd: "/repo", range: "a..b", notes: [], exec, limits: { maxFiles: 1 } }),
  ).rejects.toThrow(ChangesInputError);
});

test("a notes-only scope carries note evidence and scans nothing", async () => {
  const scope = await readChangeScope({ cwd: "/repo", notes: ["renamed Save to Submit"] });

  expect(scope).toEqual({
    evidence: [{ id: "e1", kind: "note", note: "renamed Save to Submit", before: "Save", after: "Submit" }],
    scanned: { files: 0, hunks: 0, skipped: [] },
  });
});

test("readChangeScope reads a real repo and reports changed button copy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-change-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const identity = ["-c", "user.name=Jev Test", "-c", "user.email=jev@example.test", "-c", "commit.gpgsign=false"];
  try {
    git(["init", "-q"]);
    const file = join(cwd, "Button.tsx");
    await writeFile(file, '<button data-testid="create">Create New</button>\n');
    git(["add", "Button.tsx"]);
    git([...identity, "commit", "-q", "-m", "add create button"]);
    await writeFile(file, '<button data-testid="create">Create</button>\n');
    git(["add", "Button.tsx"]);
    git([...identity, "commit", "-q", "-m", "shorten copy"]);

    const scope = await readChangeScope({ cwd, range: "HEAD~1..HEAD", notes: [] });

    expect(scope.evidence).toContainEqual(
      expect.objectContaining({ kind: "copy", before: "Create New", after: "Create" }),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
