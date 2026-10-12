---
"@jevitate/cli": minor
"jevitate": minor
---

**A job whose writes succeeded is done, even when the page looks unchanged (#514).** In goal and usability missions, a `done` the page judgment rejects is accepted when code observed the job's own actions make at least one write and every one succeed (2xx; read RPCs, background, third-party and bookkeeping requests excluded) AND the advisory scope judgment, asked in the same judgment call, says the whole goal is what those writes did (same threshold as the sign-in and save rules). A failed, blocked, unanswered or unlisted write, no write at all, or a scope judgment below the threshold or unavailable keeps the rejection, so an early `done` halfway through a multi-step job is still refused. A declared success check still decides when present. The outcome carries `verifiedBy: "succeeded-writes"` and the note `the job's writes succeeded; the page shows no change (repeat data?)`, also written to the transcript. No extra model call.
