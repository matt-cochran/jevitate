import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseTypeFixtureSpec, TypeFixtureSpecError, type TypeFixture } from "@jevitate/explore";

/**
 * `--type-fixture '<label|testId|type|id|name>=<value>=<file>'` (#281): reads each bound file before
 * any browser opens. The file must exist, be a regular file of at most `TYPE_FIXTURE_MAX_BYTES`, and
 * be UTF-8 text (no NUL byte, no invalid sequence). Errors name the flag and the path, never the
 * contents. Over MCP the path is confined like every other file argument (mcp-cli-tools.ts).
 */
export const TYPE_FIXTURE_MAX_BYTES = 256 * 1024;

export function loadTypeFixtures(specs: readonly string[], cwd: string = process.cwd()): TypeFixture[] {
  return specs.map((spec) => {
    const { descriptor, matcher, path } = parseTypeFixtureSpec(spec);
    const abs = resolve(cwd, path);
    let size: number;
    try {
      const st = statSync(abs);
      if (!st.isFile()) throw new TypeFixtureSpecError(`--type-fixture ${descriptor}: ${path} is not a file`);
      size = st.size;
    } catch (err) {
      if (err instanceof TypeFixtureSpecError) throw err;
      throw new TypeFixtureSpecError(`--type-fixture ${descriptor}: file not found: ${path}`);
    }
    if (size > TYPE_FIXTURE_MAX_BYTES) {
      throw new TypeFixtureSpecError(`--type-fixture ${descriptor}: ${path} is ${size} bytes (at most ${TYPE_FIXTURE_MAX_BYTES})`);
    }
    const bytes = readFileSync(abs);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new TypeFixtureSpecError(`--type-fixture ${descriptor}: ${path} is not UTF-8 text`);
    }
    if (text.includes("\0")) throw new TypeFixtureSpecError(`--type-fixture ${descriptor}: ${path} is not text (it contains a NUL byte)`);
    // A BOM is the file's encoding marker, never text to type.
    if (text.startsWith("﻿")) text = text.slice(1);
    if (text.trim() === "") throw new TypeFixtureSpecError(`--type-fixture ${descriptor}: ${path} is empty`);
    return { descriptor, matcher, name: basename(abs), text };
  });
}
