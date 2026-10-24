import { describe, expect, it } from "vitest";
import { groundAnswer, ObservedPages } from "./answer.js";

// #647: a 2xx write says the request was accepted, not that the app kept it. What the run itself
// sent grounds an answer only once a page from a later document load shows it (a reload, or the
// page where the app lists it) — never the client's own rendering right after the send.

const URL = "http://app.test/contacts";
const sentRow = "Sent messages\ngrace@example.com — Hello from Acme";
const emptyList = "Sent messages\nNo messages yet";
const answer = { answer: "The message was sent and appears in the Sent messages list", claims: [{ claim: "Hello from Acme was sent to grace@example.com", quote: "grace@example.com — Hello from Acme" }] };

/** The run typed the message and its Send wrote 200 from document 1; then the pages it saw. */
function run(after: ReadonlyArray<{ readonly text: string; readonly document: number }>): ObservedPages {
  const observed = new ObservedPages();
  observed.add(URL, "Sent messages\nNo messages yet", [], { document: 1 });
  observed.noteOwnInput("Hello from Acme");
  observed.confirmOwnInputs(1);
  for (const p of after) observed.add(URL, p.text, [], { document: p.document });
  return observed;
}

const ground = (observed: ObservedPages) => groundAnswer(answer, observed.pages(), { unreadWrites: observed.unreadWrites() });

describe("#647 read-back of what the run sent", () => {
  it("does not ground on the sent text shown only by the page it was sent from", () => {
    expect(ground(run([{ text: sentRow, document: 1 }])).accept).toBe(false);
  });

  it("says the app may not have kept what was sent", () => {
    const v = ground(run([{ text: sentRow, document: 1 }]));
    expect(v.accept ? "" : v.reason).toContain("the app may not have kept it");
  });

  it("grounds once a later document load shows the sent text", () => {
    expect(ground(run([{ text: sentRow, document: 1 }, { text: sentRow, document: 2 }])).accept).toBe(true);
  });

  it("keeps refusing when a later document load does not show it (the app lost it)", () => {
    expect(ground(run([{ text: sentRow, document: 1 }, { text: emptyList, document: 2 }])).accept).toBe(false);
  });

  it("leaves an answer that does not quote what was sent unaffected", () => {
    const observed = run([{ text: `${sentRow}\nMessage sent`, document: 1 }]);
    const v = groundAnswer({ answer: "The page says the message was sent", claims: [{ claim: "Message sent", quote: "Message sent" }] }, observed.pages(), { unreadWrites: observed.unreadWrites() });
    expect(v.accept).toBe(true);
  });

  it("a later document showing the sent text reads it back", () => {
    const observed = run([]);
    expect(observed.readBack(2, sentRow)).toEqual(["hello from acme"]);
  });

  it("the document the write was sent from reads nothing back", () => {
    const observed = run([]);
    expect(observed.readBack(1, sentRow)).toEqual([]);
  });

  it("reports which unread sent values a page shows", () => {
    expect(run([]).unreadShownIn(sentRow)).toEqual(["hello from acme"]);
  });

  it("reports none for a page that does not show what was sent (a write-only form)", () => {
    expect(run([]).unreadShownIn("Thanks — we received your message")).toEqual([]);
  });
});

// #649: what a write's body sent, whoever typed it. The import page holds its source CSV in a field;
// the write sends its rows; the page then lists them as text. A reload of the import page shows the
// source field again, which proves nothing.
describe("#649 read-back of a write's body values the run did not type", () => {
  const IMPORT = "http://app.test/import";
  const CONTACTS = "http://app.test/contacts";
  const csv = [{ label: "CSV", value: "Ada Lovelace,ada@example.com" }];

  function imported(): ObservedPages {
    const observed = new ObservedPages();
    observed.add(IMPORT, "Import contacts", csv, { document: 1 });
    observed.noteSentValues(["Ada Lovelace"], IMPORT);
    observed.confirmOwnInputs(1);
    observed.add(IMPORT, "Import contacts\nImported: Ada Lovelace — ada@example.com", csv, { document: 1 });
    return observed;
  }

  it("awaits read-back once the page after the write lists it as new text", () => {
    expect([...imported().unreadWrites()]).toEqual(["ada lovelace"]);
  });

  it("is not read back by a reload of the page that held it as its source", () => {
    const observed = imported();
    observed.add(IMPORT, "Import contacts", csv, { document: 2 });
    expect([...observed.unreadWrites()]).toEqual(["ada lovelace"]);
  });

  it("is read back by a later page on another route that lists it", () => {
    const observed = imported();
    observed.add(CONTACTS, "Contacts\nAda Lovelace — ada@example.com", [], { document: 2 });
    expect([...observed.unreadWrites()]).toEqual([]);
  });

  it("does not await read-back for a form's untouched prefilled field", () => {
    const observed = new ObservedPages();
    const fields = [{ label: "Name", value: "Ada Lovelace" }];
    observed.add(CONTACTS, "Profile", fields, { document: 1 });
    observed.noteSentValues(["Ada Lovelace"], CONTACTS);
    observed.confirmOwnInputs(1);
    observed.add(CONTACTS, "Profile\nSaved", fields, { document: 1 });
    expect([...observed.unreadWrites()]).toEqual([]);
  });

  it("does not await read-back for a value the page already showed as text before the write", () => {
    const observed = new ObservedPages();
    observed.add(CONTACTS, "Profile\nName: Ada Lovelace", [], { document: 1 });
    observed.noteSentValues(["Ada Lovelace"], CONTACTS);
    observed.confirmOwnInputs(1);
    observed.add(CONTACTS, "Profile\nName: Ada Lovelace\nSaved", [], { document: 1 });
    expect([...observed.unreadWrites()]).toEqual([]);
  });
});

describe("#645 readBackConfirmed", () => {
  it("is true once every sent value was read back", () => {
    const observed = new ObservedPages();
    observed.add(URL, "Sent messages\nNo messages yet", [], { document: 1 });
    observed.noteOwnInput("Hello from Acme");
    observed.confirmOwnInputs(1);
    observed.add(URL, sentRow, [], { document: 2 });
    expect(observed.readBackConfirmed()).toBe(true);
  });

  it("is false while a sent value is unread", () => {
    expect(run([{ text: sentRow, document: 1 }]).readBackConfirmed()).toBe(false);
  });

  it("is false when nothing was ever sent", () => {
    expect(new ObservedPages().readBackConfirmed()).toBe(false);
  });
});

// #671: after a reload the run typed the sent message into the composer again. The field then holds
// the run's own entry, not what the app kept, so it must not read the sent value back (a phantom send
// was reported as done through a grounded report).
describe("#671 a field holding what the run typed on this document load is not a read-back", () => {
  const composer = [{ label: "Message", value: "Hello from Acme" }];

  it("a reloaded page whose composer holds the run's retyped message reads nothing back", () => {
    const observed = run([{ text: sentRow, document: 1 }]);
    observed.noteTypedOn("Hello from Acme", 2);
    observed.add(URL, emptyList, composer, { document: 2 });
    expect([...observed.unreadWrites()]).toEqual(["hello from acme"]);
    expect(ground(observed).accept).toBe(false);
  });

  it("a field the app prefilled on a later load still reads the sent value back", () => {
    const observed = run([{ text: sentRow, document: 1 }]);
    observed.add(URL, emptyList, composer, { document: 2 });
    expect([...observed.unreadWrites()]).toEqual([]);
  });

  it("what the run typed on an earlier load does not hide a field the app shows after the next one", () => {
    const observed = run([{ text: sentRow, document: 1 }]);
    observed.noteTypedOn("Hello from Acme", 2);
    observed.add(URL, emptyList, composer, { document: 3 });
    expect([...observed.unreadWrites()]).toEqual([]);
  });
});
