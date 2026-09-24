import { describe, expect, it } from "vitest";
import type { Control, Snapshot } from "../snapshot.js";
import { controlKey, detectForms, isExercisable, planMisuseEpisode, type EpisodeContext } from "./form-misuse.js";

let n = 0;
function control(p: Partial<Control> & { name: string; role: string; tag: string }): Control {
  const index = n++;
  return {
    index,
    descriptor: { role: p.role, name: p.name },
    stability: "high",
    inputType: null,
    enabled: true,
    summary: `${p.role} "${p.name}"`,
    ...p,
  };
}

const field = (name: string, form: string | null = "form#profile"): Control =>
  control({ name, role: "textbox", tag: "input", inputType: "text", form });
const button = (name: string, extra: Partial<Control> = {}): Control =>
  control({ name, role: "button", tag: "button", form: "form#profile", submits: false, ...extra });

function snap(controls: Control[]): Snapshot {
  return { url: "http://app.test/profile", controls, truncated: false, signature: "s" };
}

function ctx(controls: Control[], over: Partial<EpisodeContext> = {}): EpisodeContext {
  return {
    snapshot: snap(controls),
    strategy: "double-submit",
    round: 0,
    last: null,
    visitedLinks: new Set(),
    exercised: new Set(),
    rng: () => 0,
    ...over,
  };
}

const PROFILE = (): Control[] => [
  field("First name"),
  field("Last name"),
  control({ name: "Role", role: "combobox", tag: "select", form: "form#profile" }),
  button("Cancel"),
  button("Save", { submits: true }),
  control({ name: "Change workspace", role: "link", tag: "a", href: "http://app.test/", form: null }),
];

describe("detectForms", () => {
  it("finds a <form> with its fields, its submit button and its Cancel", () => {
    const [form] = detectForms(PROFILE());
    expect(form?.key).toBe("form#profile");
    expect(form?.fields.map((f) => f.name)).toEqual(["First name", "Last name", "Role"]);
    expect(form?.submit.name).toBe("Save");
    expect(form?.cancel?.name).toBe("Cancel");
  });

  it("finds a form built without a <form> element by its Save-like control", () => {
    const forms = detectForms([field("Title", null), button("Save changes", { form: null })]);
    expect(forms.map((f) => [f.key, f.submit.name])).toEqual([["page", "Save changes"]]);
  });

  it("uses a Save outside the <form> element (a toolbar) when the form has no submit of its own", () => {
    const forms = detectForms([field("Title"), button("Update", { form: null })]);
    expect(forms[0]?.submit.name).toBe("Update");
  });

  it("is not a form without a submit control, or without an editable field", () => {
    expect(detectForms([field("Search", null)])).toEqual([]);
    expect(detectForms([button("Save", { submits: true })])).toEqual([]);
  });

  it("never treats a password field as a misuse target", () => {
    const pw = control({ name: "Password", role: "textbox", tag: "input", inputType: "password", form: "form#profile" });
    const forms = detectForms([pw, button("Save", { submits: true })]);
    expect(forms).toEqual([]);
  });
});

describe("planMisuseEpisode — form-aware strategies", () => {
  it("double-submit edits a field, then submits twice without waiting in between", () => {
    const ep = planMisuseEpisode(ctx(PROFILE()));
    expect(ep?.steps.map((s) => [s.op, s.control?.name ?? null, s.settle])).toEqual([
      ["type", "First name", false],
      ["click", "Save", false],
      ["click", "Save", true],
    ]);
    expect(ep?.steps[1]?.submitsForm).toBe("form#profile");
  });

  it("boundary-submit cycles boundary values per round and submits", () => {
    const values = [0, 1, 2, 3, 4].map(
      (round) => planMisuseEpisode(ctx(PROFILE(), { strategy: "boundary-submit", round }))?.steps[0]?.fillText,
    );
    expect(values[0]).toBe("");
    expect(values[1]).toBe("x");
    expect(values[2]).toHaveLength(2000);
    expect(new Set(values).size).toBe(5);
    const ep = planMisuseEpisode(ctx(PROFILE(), { strategy: "boundary-submit" }));
    expect(ep?.steps.at(-1)?.control?.name).toBe("Save");
  });

  it("edit-cancel-save edits, cancels, then saves (and finds nothing without a Cancel)", () => {
    const ep = planMisuseEpisode(ctx(PROFILE(), { strategy: "edit-cancel-save" }));
    expect(ep?.steps.map((s) => [s.op, s.control?.name ?? null])).toEqual([
      ["type", "First name"],
      ["click", "Cancel"],
      ["click", "Save"],
    ]);
    const noCancel = PROFILE().filter((c) => c.name !== "Cancel");
    expect(planMisuseEpisode(ctx(noCancel, { strategy: "edit-cancel-save" }))).toBeNull();
  });

  it("navigate-away-unsaved edits, then reloads", () => {
    const ep = planMisuseEpisode(ctx(PROFILE(), { strategy: "navigate-away-unsaved" }));
    expect(ep?.steps.map((s) => s.op)).toEqual(["type", "reload"]);
  });

  it("act-while-pending submits and immediately acts again", () => {
    const ep = planMisuseEpisode(ctx(PROFILE(), { strategy: "act-while-pending" }));
    expect(ep?.steps.map((s) => [s.op, s.control?.name ?? null, s.settle])).toEqual([
      ["type", "First name", false],
      ["click", "Save", false],
      ["click", "Cancel", true],
    ]);
  });

  it("prefers fields not exercised yet, so repeated episodes cover the form", () => {
    const controls = PROFILE();
    const first = controls[0];
    if (first === undefined) throw new Error("fixture");
    const ep = planMisuseEpisode(ctx(controls, { exercised: new Set([controlKey(first)]) }));
    expect(ep?.steps[0]?.control?.name).toBe("Last name");
  });

  it("selects without a fixed value (the runner picks another option)", () => {
    const controls = PROFILE();
    const exercised = new Set(controls.filter((c) => c.role === "textbox").map(controlKey));
    const ep = planMisuseEpisode(ctx(controls, { exercised }));
    expect(ep?.steps[0]?.op).toBe("select");
    expect(ep?.steps[0]?.fillText).toBeUndefined();
  });

  it("finds nothing on a page without a form", () => {
    const page = [control({ name: "Home", role: "link", tag: "a", href: "http://app.test/home" })];
    expect(planMisuseEpisode(ctx(page))).toBeNull();
  });
});

describe("planMisuseEpisode — exercise-controls and scope", () => {
  const inScope = (url: string): boolean => new URL(url).pathname.startsWith("/profile");

  it("acts on the next control not exercised yet, skipping links that leave the scope", () => {
    const controls = PROFILE();
    const seen = new Set<string>();
    const names: string[] = [];
    for (;;) {
      const ep = planMisuseEpisode(ctx(controls, { strategy: "exercise-controls", exercised: seen, inScope }));
      const c = ep?.steps[0]?.control;
      if (c === undefined || c === null) break;
      names.push(c.name);
      seen.add(controlKey(c));
    }
    expect(names).toEqual(["First name", "Last name", "Role", "Cancel", "Save"]);
  });

  it("isExercisable excludes disabled, secret, session-ending and out-of-scope controls", () => {
    expect(isExercisable(button("Save", { enabled: false }), inScope)).toBe(false);
    expect(isExercisable(button("Sign out"), inScope)).toBe(false);
    expect(isExercisable(control({ name: "API token", role: "textbox", tag: "input" }), inScope)).toBe(false);
    expect(isExercisable(control({ name: "Home", role: "link", tag: "a", href: "http://app.test/" }), inScope)).toBe(false);
    expect(isExercisable(control({ name: "Tab", role: "link", tag: "a", href: "http://app.test/profile/2" }), inScope)).toBe(true);
    expect(isExercisable(control({ name: "Menu", role: "link", tag: "a", href: "javascript:void(0)" }), inScope)).toBe(true);
  });

  it("visit-route never follows a link out of scope", () => {
    const controls = [
      control({ name: "Out", role: "link", tag: "a", href: "http://app.test/elsewhere" }),
      control({ name: "In", role: "link", tag: "a", href: "http://app.test/profile/security" }),
    ];
    const ep = planMisuseEpisode(ctx(controls, { strategy: "visit-route", inScope }));
    expect(ep?.steps[0]?.control?.name).toBe("In");
  });

  it("repeat-rapid re-resolves the previous control on the CURRENT page by descriptor", () => {
    const controls = PROFILE();
    const save = controls.find((c) => c.name === "Save");
    if (save === undefined) throw new Error("fixture");
    const stale = { ...save, index: 999 };
    const ep = planMisuseEpisode(ctx(controls, { strategy: "repeat-rapid", last: { op: "click", control: stale } }));
    expect(ep?.steps[0]?.control?.index).toBe(save.index);
    const gone = planMisuseEpisode(
      ctx(controls.filter((c) => c.name !== "Save"), { strategy: "repeat-rapid", last: { op: "click", control: stale } }),
    );
    expect(gone).toBeNull();
  });
});
