// The accuracy lab's three jobs as recorded-style Journeys (hand-authored: the lab ships apps, not
// Journeys) and each job's done check (#800 shape: a path-independent statement about app state).
// Every Journey is the path a person would click on the `clean` variant; `__BASE__` (page urls) and the site are replaced by
// the app's URL per replay.
const tid = (testId) => ({ testId });
const step = (s) => ({ step: s });
const visible = (testId) => ({ kind: "visible", target: tid(testId) });
const text = (testId, t) => ({ kind: "textIncludes", target: tid(testId), text: t });
const navigate = (path, expect) => step({ kind: "navigate", url: path, expect });
const click = (testId, expect, display) => step({ kind: "click", target: { ...tid(testId), ...(display ? { display } : {}) }, expect });
const fill = (testId, value, expect) => step({ kind: "fill", target: tid(testId), value: { redacted: false, value }, expect: expect ?? { kind: "valueEquals", target: tid(testId), value } });

const rec = (intent, steps) => ({ version: "1.0", site: "http://127.0.0.1:1", intent, pages: [{ url: "__BASE__/", steps }] });

export const JOURNEYS = {
  J1: {
    job: "update my profile",
    recording: rec("J1 update my profile", [
      navigate("/", visible("job-update-profile")),
      click("job-update-profile", { kind: "urlIncludes", text: "/profile" }),
      fill("profile-name", "Grace Hopper"),
      fill("profile-email", "grace@example.com"),
      click("profile-save", text("profile-status", "Saved"), { role: "button", name: "Save" }),
    ]),
    done: { version: 1, at: "/profile", check: "textIncludes:testId=profile-current|Grace Hopper" },
  },
  J2: {
    job: "send a message to a contact",
    recording: rec("J2 send a message", [
      navigate("/", visible("job-send-message")),
      click("nav-profile", { kind: "urlIncludes", text: "/profile" }), // a detour a person takes
      click("nav-contacts", { kind: "urlIncludes", text: "/contacts" }),
      step({ kind: "select", target: tid("contact-select"), value: { redacted: false, value: "grace@example.com" }, expect: { kind: "valueEquals", target: tid("contact-select"), value: "grace@example.com" } }),
      fill("message-body", "Hello Grace"),
      click("send-message", text("message-status", "Message sent"), { role: "button", name: "Send" }),
    ]),
    done: { version: 1, at: "/contacts", check: "count:testId=sent-row|min=1" },
  },
  J3: {
    job: "import contacts from a CSV",
    recording: rec("J3 import contacts", [
      navigate("/", visible("job-import-contacts")),
      click("job-import-contacts", { kind: "urlIncludes", text: "/import" }),
      fill("csv-text", "name,email\nAda Lovelace,ada@example.com\nKatherine Johnson,katherine@example.com"),
      click("import-continue", visible("import-step-map"), { role: "button", name: "Continue" }),
      click("import-map-continue", visible("import-step-confirm"), { role: "button", name: "Continue" }),
      click("import-confirm", visible("import-step-result"), { role: "button", name: "Import" }),
      navigate("/contacts", visible("contact-list")), // checks the result, after the confirmation
    ]),
    done: { version: 1, at: "/contacts", check: "textIncludes:testId=contact-list|katherine@example.com" },
  },
};
