// #800 witness lab: the jobs (with their done checks), the Journeys, and the cell plan with known truth.
//
// Journeys are hand-authored in the shape `journey record` produces, against the lab's public
// data-testid hooks. A Journey is written the way a person would record it on the CLEAN app; a
// seeded variant is then a regression of that app (the exception is j3-effort, whose Journey is the
// one recorded on that variant: its extra screens are the app as shipped, not a regression).
//
// Truth per cell (`truth`):
//   defect      the variant breaks the job (j1-5xx, j2-stall, j3-deadend, j2-phantom, j3-phantom)
//   clean       the job works and the Journey's checks are sound (clean, and j3-effort)
//   weak-clean  the job works but the Journey's own checks are weak (a weak Journey on the clean app)
// Rates use `defect` (caught/total) and `clean` (false alarms/total); `weak-clean` is reported apart:
// flagging it is a correct finding about the Journey, not about the app.

const story = (trigger, motivation, outcome) => ({ trigger, motivation, outcome });

export const JOBS = [
  {
    id: "update-profile",
    ...story("When my details change", "I want to update my profile name and email", "people reach me at the right address"),
    done: { version: 1, at: "/profile", check: "attr:testId=profile-current|data-name=${name}", distinguishedBy: ["name"] },
  },
  {
    id: "send-message",
    ...story("When I need to reach a contact", "I want to send them a message", "I can see it in Sent messages later"),
    done: { version: 1, at: "/contacts", check: "textIncludes:testId=sent-list|${body}", distinguishedBy: ["body"] },
  },
  {
    id: "import-contacts",
    ...story("When I have a CSV of contacts", "I want to import them", "they appear in my contact list"),
    done: { version: 1, at: "/contacts", check: "textIncludes:testId=contact-list|katherine@example.com" },
  },
];

const t = (testId) => ({ testId });
const visible = (testId) => ({ kind: "visible", target: t(testId) });
const valueEq = (testId, value) => ({ kind: "valueEquals", target: t(testId), value });
const text = (testId, s) => ({ kind: "textIncludes", target: t(testId), text: s });
const rs = (stepId, step, extra = {}) => ({ stepId, step, ...extra });
/** The action delta `journey record` stores on a step that sent a write (what lint and the proof read). */
const wrote = (line, why) => ({ delta: { verdict: "relevant-change", why, changes: ["status"], requests: [line], overheadMs: 1 } });

const profileSteps = () => [
  rs("open-profile", { kind: "navigate", url: "/profile", expect: visible("profile-form") }),
  rs("fill-name", { kind: "fill", target: t("profile-name"), value: { var: "name" }, expect: valueEq("profile-name", { var: "name" }) }),
  rs("fill-email", { kind: "fill", target: t("profile-email"), value: { var: "email" }, expect: valueEq("profile-email", { var: "email" }) }),
  rs("save", { kind: "click", target: t("profile-save"), expect: text("profile-status", "Saved") }, wrote("PUT /api/profile → 200", "saved the profile")),
];

const messageSteps = (sendExpect) => [
  rs("open-contacts", { kind: "navigate", url: "/contacts", expect: visible("message-form") }),
  rs("pick-contact", { kind: "select", target: t("contact-select"), value: { redacted: false, value: "grace@example.com" }, expect: valueEq("contact-select", "grace@example.com") }),
  rs("fill-body", { kind: "fill", target: t("message-body"), value: { var: "body" }, expect: valueEq("message-body", { var: "body" }) }),
  rs("send", { kind: "click", target: t("send-message"), expect: sendExpect }, wrote("POST /api/messages → 200", "sent the message")),
];

const importSteps = (extra) => [
  rs("open-import", { kind: "navigate", url: "/import", expect: visible("csv-text") }),
  rs("continue-source", { kind: "click", target: t("import-continue"), expect: visible("map-name") }),
  rs("continue-map", {
    kind: "click",
    target: t("import-map-continue"),
    expect: extra > 0 ? visible("import-continue-1") : visible("import-confirm"),
  }),
  ...Array.from({ length: extra }, (_, i) =>
    rs(`confirm-extra-${i + 1}`, {
      kind: "click",
      target: t(`import-continue-${i + 1}`),
      expect: i + 1 < extra ? visible(`import-continue-${i + 2}`) : visible("import-confirm"),
    }),
  ),
  rs("import", { kind: "click", target: t("import-confirm"), expect: { kind: "count", target: t("imported-row"), min: 2 } }, wrote("POST /api/import → 200", "imported the rows")),
  rs("open-contacts", { kind: "navigate", url: "/contacts", expect: text("contact-list", "katherine@example.com") }),
];

const reloadThen = (assertion) => ({ kind: "reloadThen", assertion });
const page = (assertion) => ({ kind: "page", assertion });

/** id → { job, params, steps, endState, weakness }. `weakness` names the deliberate flaw (null when sound). */
export const JOURNEY_DEFS = {
  "j1-strong": {
    job: "update-profile",
    params: { name: "Ada Byron", email: "ada.byron@example.com" },
    pages: [{ url: "/profile", steps: profileSteps() }],
    endState: [reloadThen({ kind: "attr", target: t("profile-current"), name: "data-name", value: { var: "name" } })],
    weakness: null,
  },
  "j1-weak-saved": {
    job: "update-profile",
    params: { name: "Ada Byron", email: "ada.byron@example.com" },
    pages: [{ url: "/profile", steps: profileSteps() }],
    endState: [page(text("profile-status", "Saved"))],
    weakness: "a 'Saved' page over a masked 500: the only check is the status text the page shows whatever the store answers",
  },
  "j1-weak-existing": {
    job: "update-profile",
    params: { name: "Ada Lovelace", email: "ada@example.com" },
    pages: [{ url: "/profile", steps: profileSteps() }],
    endState: [reloadThen({ kind: "attr", target: t("profile-current"), name: "data-name", value: { var: "name" } })],
    weakness: "reads an existing record: it saves the values already stored, so its reload check holds without the write",
  },
  "j2-strong": {
    job: "send-message",
    params: { body: "Hello from Acme" },
    pages: [{ url: "/contacts", steps: messageSteps(text("message-status", "Message sent")) }],
    endState: [reloadThen(text("sent-list", { var: "body" }))],
    weakness: null,
  },
  "j2-weak-nowrite": {
    job: "send-message",
    params: { body: "Hello from Acme" },
    pages: [{ url: "/contacts", steps: messageSteps(visible("send-message")) }],
    endState: [page({ kind: "count", target: t("sent-list"), min: 1 })],
    weakness: "a check that passes without the write: the Sent list element exists whether or not anything was sent",
  },
  "j3-strong": {
    job: "import-contacts",
    params: {},
    pages: [{ url: "/import", steps: importSteps(0) }],
    endState: [reloadThen(text("contact-list", "katherine@example.com"))],
    weakness: null,
  },
  "j3-effort": {
    job: "import-contacts",
    params: {},
    pages: [{ url: "/import", steps: importSteps(3) }],
    endState: [reloadThen(text("contact-list", "katherine@example.com"))],
    weakness: null,
  },
};

/** One Journey file for `origin` (the recorded site). */
export function buildJourney(id, origin) {
  const def = JOURNEY_DEFS[id];
  if (!def) throw new Error(`unknown journey ${id}`);
  return {
    metadata: {
      id,
      name: id,
      promoted: true,
      params: Object.keys(def.params),
      job: def.job,
      createdAtIso: "2026-11-09T00:00:00.000Z",
      endState: def.endState,
    },
    recording: { version: "1", site: origin, pages: def.pages },
  };
}

/** The cell plan: (journey, variant) with truth. */
export const CELLS = [
  { journey: "j1-strong", variant: "clean", truth: "clean" },
  { journey: "j1-strong", variant: "j1-5xx", truth: "defect" },
  { journey: "j1-weak-saved", variant: "clean", truth: "weak-clean" },
  { journey: "j1-weak-saved", variant: "j1-5xx", truth: "defect" },
  { journey: "j1-weak-existing", variant: "clean", truth: "weak-clean" },
  { journey: "j1-weak-existing", variant: "j1-5xx", truth: "defect" },
  { journey: "j2-strong", variant: "clean", truth: "clean" },
  { journey: "j2-strong", variant: "j2-stall", truth: "defect" },
  { journey: "j2-strong", variant: "j2-phantom", truth: "defect" },
  { journey: "j2-weak-nowrite", variant: "clean", truth: "weak-clean" },
  { journey: "j2-weak-nowrite", variant: "j2-stall", truth: "defect" },
  { journey: "j2-weak-nowrite", variant: "j2-phantom", truth: "defect" },
  { journey: "j3-strong", variant: "clean", truth: "clean" },
  { journey: "j3-strong", variant: "j3-deadend", truth: "defect" },
  { journey: "j3-strong", variant: "j3-phantom", truth: "defect" },
  { journey: "j3-effort", variant: "j3-effort", truth: "clean" },
];

export const ARMS = ["lint", "replay", "witness", "mutation"];
