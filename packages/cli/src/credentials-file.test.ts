import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envCredentialStore } from "@jevitate/ai-core";
import { CredentialsFileError, credentialsFilePath, loadLocalCredentials } from "./credentials-file.js";

/**
 * Regression: `jevitate init` / `ai setup` persisted keys to ~/.jevitate/credentials.json but every
 * read site built its store from env + an EMPTY local config, so `ai status` / `explore --real`
 * reported the just-saved keys as missing. The loader is the single read path for that file.
 */
function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "jev-creds-"));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("loadLocalCredentials", () => {
  test("a missing file means no local keys", () => {
    withHome((home) => {
      expect(loadLocalCredentials({ homedir: () => home })).toEqual({});
    });
  });

  test("returns only the known keys with string values", () => {
    withHome((home) => {
      mkdirSync(join(home, ".jevitate"));
      writeFileSync(
        credentialsFilePath({ homedir: () => home }),
        JSON.stringify({ OPENROUTER_API_KEY: "or-key", TYPESAFE_API_KEY: "ts-key", OTHER: "x", NUM: 1 }),
      );
      expect(loadLocalCredentials({ homedir: () => home })).toEqual({
        OPENROUTER_API_KEY: "or-key",
        TYPESAFE_API_KEY: "ts-key",
      });
    });
  });

  test("a corrupt file fails closed with an actionable error (never a silent empty store)", () => {
    withHome((home) => {
      mkdirSync(join(home, ".jevitate"));
      writeFileSync(credentialsFilePath({ homedir: () => home }), "{not json");
      expect(() => loadLocalCredentials({ homedir: () => home })).toThrow(CredentialsFileError);
      expect(() => loadLocalCredentials({ homedir: () => home })).toThrow(/jevitate init/);
    });
  });

  test("a non-object JSON file fails closed", () => {
    withHome((home) => {
      mkdirSync(join(home, ".jevitate"));
      writeFileSync(credentialsFilePath({ homedir: () => home }), "[1,2]");
      expect(() => loadLocalCredentials({ homedir: () => home })).toThrow(CredentialsFileError);
    });
  });

  test("setup-persisted keys are visible to the store; env still wins", () => {
    withHome((home) => {
      mkdirSync(join(home, ".jevitate"));
      writeFileSync(
        credentialsFilePath({ homedir: () => home }),
        JSON.stringify({ OPENROUTER_API_KEY: "from-file", TYPESAFE_API_KEY: "from-file-ts" }),
      );
      const local = loadLocalCredentials({ homedir: () => home });
      const fileOnly = envCredentialStore({}, local);
      expect(fileOnly.detect("OPENROUTER_API_KEY")).toBe(true);
      expect(fileOnly.detect("TYPESAFE_API_KEY")).toBe(true);
      const envWins = envCredentialStore({ OPENROUTER_API_KEY: "from-env" }, local);
      expect(envWins.read("OPENROUTER_API_KEY")).toBe("from-env");
    });
  });
});
