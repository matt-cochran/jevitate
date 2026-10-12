---
"@jevitate/cli": minor
"jevitate": minor
---

**A job whose writes succeeded is done, even when the page looks unchanged (#514).** In goal and usability missions, a `done` the page judgment rejects is accepted when the job's own actions made at least one write and every one succeeded (2xx; read RPCs, background, third-party and bookkeeping requests excluded). A failed, blocked, unanswered or unlisted write, or no write at all, keeps the rejection, and a declared success check still decides when present. The outcome carries `verifiedBy: "succeeded-writes"` and the note `the job's writes succeeded; the page shows no change (repeat data?)`, also written to the transcript. No extra model call.
