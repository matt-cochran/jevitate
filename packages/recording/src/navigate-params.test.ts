import { describe, expect, it } from "vitest";
import {
  NavigateUrlParamError,
  describeNavigateUrl,
  encodeUrlParamValue,
  navigateTemplateProblem,
  navigateUrlParams,
  resolveNavigateUrl,
} from "./navigate-params.js";
import { RecordingSchema } from "./schema.js";

/**
 * #399 — `navigate.url` may hold `${param}` placeholders, resolved from the run's vars. A value is
 * one URL component (strictly percent-encoded), never able to change the origin.
 */

const vars = (o: Record<string, string>): Map<string, string> => new Map(Object.entries(o));

describe("navigateUrlParams", () => {
  it("lists each placeholder name once, in order", () => {
    expect(navigateUrlParams("/accept?token=${inviteToken}&t=${team}&again=${inviteToken}")).toEqual(["inviteToken", "team"]);
  });
  it("a URL without placeholders takes none", () => {
    expect(navigateUrlParams("/settings?x=$1")).toEqual([]);
  });
});

describe("navigateTemplateProblem (schema-time)", () => {
  it.each([
    "/accept?token=${inviteToken}",
    "/teams/${team}/members",
    "/${page}",
    "https://app.example.com/accept?token=${t}",
    "https://app.example.com:8443/a#${frag}",
    "/settings",
  ])("accepts %s", (url) => {
    expect(navigateTemplateProblem(url)).toBeUndefined();
  });

  it.each([
    ["${base}/accept", "origin"],
    ["https://${host}/accept", "origin"],
    ["https://app.example.com${rest}", "origin"],
    ["https://app.example.com:${port}/x", "origin"],
    ["https://user${u}@app.example.com/x", "origin"],
    ["//${host}/x", "origin"],
    ["/\\${host}/x", "origin"],
    ["/accept?token=${}", "placeholder"],
    ["/accept?token=${in vite}", "placeholder"],
    ["/accept?token=${unclosed", "placeholder"],
  ])("refuses %s (%s)", (url, what) => {
    expect(navigateTemplateProblem(url)).toMatch(new RegExp(what));
  });

  it("RecordingSchema refuses a navigate placeholder that could reach the origin", () => {
    const rec = {
      version: "1",
      site: "http://127.0.0.1:1",
      pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "https://${host}/x", expect: { kind: "urlIncludes", text: "/x" } } }] }],
    };
    expect(RecordingSchema.safeParse(rec).success).toBe(false);
    rec.pages[0]!.steps[0]!.step.url = "/accept?token=${inviteToken}";
    expect(RecordingSchema.safeParse(rec).success).toBe(true);
  });
});

describe("resolveNavigateUrl", () => {
  it("substitutes each placeholder from the vars", () => {
    expect(resolveNavigateUrl("/accept?token=${inviteToken}", vars({ inviteToken: "abc-123_Z.~" }))).toBe("/accept?token=abc-123_Z.~");
  });

  it("percent-encodes a value as ONE component (strict: also !'()*)", () => {
    expect(encodeUrlParamValue("a b/c?d#e&f=g'h(i)*!\\@:%")).toBe("a%20b%2Fc%3Fd%23e%26f%3Dg%27h%28i%29%2A%21%5C%40%3A%25");
    expect(resolveNavigateUrl("/teams/${t}/x", vars({ t: "../../admin" }))).toBe("/teams/..%2F..%2Fadmin/x");
  });

  it.each([
    ["/${p}", "/evil.example"],
    ["/${p}", "\\evil.example"],
    ["/${p}", "%2Fevil.example"],
    ["https://app.example.com/${p}", "@evil.example"],
    ["https://app.example.com/${p}", "/evil.example"],
    ["/accept?token=${p}", "x#@evil.example/"],
  ])("a value can never change the origin: %s with %s", (template, value) => {
    const resolved = resolveNavigateUrl(template, vars({ p: value }));
    const base = "https://app.example.com";
    expect(new URL(resolved, base).origin).toBe(base);
    expect(resolved.startsWith("//")).toBe(false);
    expect(resolved).not.toContain("\\");
  });

  it("an unknown placeholder fails closed (never navigates with an empty value)", () => {
    expect(() => resolveNavigateUrl("/accept?token=${inviteToken}", vars({}))).toThrow(/unknown variable: inviteToken/);
  });

  it("a URL without placeholders is returned unchanged", () => {
    expect(resolveNavigateUrl("/settings?a=$1", vars({}))).toBe("/settings?a=$1");
  });

  it("refuses at run time a template that could reach the origin (defense in depth past the schema)", () => {
    expect(() => resolveNavigateUrl("https://${h}/x", vars({ h: "evil.example" }))).toThrow(NavigateUrlParamError);
    try {
      resolveNavigateUrl("https://${h}/x", vars({ h: "evil.example" }));
    } catch (err) {
      expect((err as Error).message).not.toContain("evil.example");
    }
  });
});

describe("describeNavigateUrl", () => {
  it("shows each placeholder as <param name>, never a value", () => {
    expect(describeNavigateUrl("/accept?token=${inviteToken}")).toBe("/accept?token=<param inviteToken>");
  });
});
