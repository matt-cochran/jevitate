---
"@jevitate/cli": minor
"jevitate": minor
---

The Journey review sheet (`journey review`, and the sheet `journey promote` shows first) is now built for a person signing off (#496).
- **Layout:** it opens with NEEDS YOUR ATTENTION (weak steps, missing intent, lint, risky controls, findings, change since approval, no mutation proof, brittle locators). Then come:
  - WHAT IT DOES (the recording's intent, sign-in, origins, uploaded files);
  - STEPS, each with its checks inline in plain English, its writes and its anchors;
  - PROVES AT THE END;
  - one WRITES line per endpoint;
  - a one-line CLEAR summary;
  - APPROVE with the promote command.
- **Formatting:**
  - empty sections are left out;
  - lines wrap to the terminal width;
  - colour on a terminal only (`NO_COLOR` turns it off);
  - one `Content hash:` line, so `--review-sheet` binding is unchanged;
  - `--full` (review and promote) brings back every detail section.
- **JSON** is additive: `attention`, per-step `checks`/`file`/`anchors`, `summary.intent`, `proof.endStateText`.
- **Typed confirmation:** `journey promote` repeats the attention items right above it.
- **Self-heal proposals** show each step's exact locator.
