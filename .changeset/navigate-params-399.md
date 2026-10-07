---
"@jevitate/cli": minor
"jevitate": minor
---

A Journey's `navigate` URL can take declared parameters (#399), for single-use links such as invitation accept, magic-link sign-in or password reset: `"url": "/accept?token=${inviteToken}"` with `parameters: [{ "name": "inviteToken", "secret": true }]`, run with `journey run --param inviteToken=…` or MCP `run_journey` `params`. A placeholder must name a declared parameter (otherwise the Journey is refused when read) and must come after a literal origin. Its value is percent-encoded as one URL component, and the resolved URL must keep the template's origin. A secret value is redacted from the run's output and errors (including Playwright's navigation error), screenshots, action deltas, annotate/demo evidence, self-heal prompts and `source run`. Steps show it as `<param inviteToken>`.
