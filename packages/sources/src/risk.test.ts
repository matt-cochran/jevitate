import { describe, it, expect } from "vitest";
import { classifyRisk } from "./risk.js";

const base = (steps: any[]) => ({
  metadata: { id: "j", name: "j", promoted: false, params: [], createdAtIso: "t" },
  recording: { version: "1", site: "s", pages: [{ url: "/", steps: steps.map((s) => ({ step: s })) }] },
  declaredOrigins: ["https://mail.example.com"],
});

describe("classifyRisk", () => {
  it("pure reads within declared origins are read-only", () => {
    expect(
      classifyRisk(
        base([
          { kind: "navigate", url: "https://mail.example.com/inbox", expect: { kind: "urlIncludes", text: "/inbox" } },
          { kind: "assert", check: { kind: "urlIncludes", text: "/inbox" } },
        ]) as any,
      ),
    ).toBe("read-only");
  });

  it("relative navigate urls are same-origin and fine", () => {
    expect(
      classifyRisk(
        base([
          { kind: "navigate", url: "/inbox", expect: { kind: "urlIncludes", text: "/inbox" } },
          { kind: "extract", target: { testId: "x" }, as: "v", expect: { kind: "visible", target: { testId: "x" } } },
          { kind: "waitFor", target: { testId: "x" }, state: "visible" },
        ]) as any,
      ),
    ).toBe("read-only");
  });

  it("#125: a click on a link (ARIA role=link) is read-only, not risky", () => {
    expect(
      classifyRisk(
        base([
          { kind: "navigate", url: "/terms", expect: { kind: "urlIncludes", text: "/terms" } },
          { kind: "click", target: { role: "link", name: "Privacy" }, expect: { kind: "urlIncludes", text: "/privacy" } },
          { kind: "assert", check: { kind: "urlIncludes", text: "/privacy" } },
        ]) as any,
      ),
    ).toBe("read-only");
  });

  it("a click WITHOUT role=link (e.g. a button, or role unknown) stays risky", () => {
    expect(
      classifyRisk(
        base([{ kind: "click", target: { role: "button", name: "Delete" }, expect: { kind: "urlIncludes", text: "/x" } }]) as any,
      ),
    ).toBe("risky");
  });

  it("ANY write step is risky — an author cannot downgrade it (FMECA #6)", () => {
    expect(
      classifyRisk(
        base([{ kind: "click", target: { testId: "del" }, expect: { kind: "urlIncludes", text: "/x" } }]) as any,
      ),
    ).toBe("risky");
  });

  it("fill/select/press/handback are risky", () => {
    expect(
      classifyRisk(
        base([{ kind: "fill", target: { testId: "f" }, value: { var: "x" }, expect: { kind: "urlIncludes", text: "x" } }]) as any,
      ),
    ).toBe("risky");
    expect(
      classifyRisk(
        base([{ kind: "select", target: { testId: "f" }, value: { var: "x" }, expect: { kind: "urlIncludes", text: "x" } }]) as any,
      ),
    ).toBe("risky");
    expect(
      classifyRisk(base([{ kind: "press", key: "Enter", expect: { kind: "urlIncludes", text: "x" } }]) as any),
    ).toBe("risky");
    expect(
      classifyRisk(
        base([{ kind: "handback", prompt: "p", resume: { kind: "urlIncludes", text: "x" } }]) as any,
      ),
    ).toBe("risky");
  });

  it("a navigate leaving declaredOrigins is risky (FMECA #1)", () => {
    expect(
      classifyRisk(
        base([{ kind: "navigate", url: "https://evil.example.com/x", expect: { kind: "urlIncludes", text: "x" } }]) as any,
      ),
    ).toBe("risky");
  });

  it("recurses into forEach — a write nested inside is still risky", () => {
    expect(
      classifyRisk(
        base([
          {
            kind: "forEach",
            items: { testId: "row" },
            as: "r",
            steps: [{ kind: "fill", target: { testId: "f" }, value: { var: "r" }, expect: { kind: "urlIncludes", text: "x" } }],
          },
        ]) as any,
      ),
    ).toBe("risky");
  });

  it("recurses into forEach — reads nested inside stay read-only", () => {
    expect(
      classifyRisk(
        base([
          {
            kind: "forEach",
            items: { testId: "row" },
            as: "r",
            steps: [{ kind: "assert", check: { kind: "urlIncludes", text: "/inbox" } }],
          },
        ]) as any,
      ),
    ).toBe("read-only");
  });
});
