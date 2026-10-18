# @jevitate/cli

**Autonomous browser testing that turns discovered bugs into deterministic regression tests.**

[Website](https://jevitate.com) · [Documentation](https://github.com/matt-cochran/jevitate/blob/main/docs/README.md) · [Demo](https://github.com/matt-cochran/jevitate/blob/main/docs/demo.md) · [Source](https://github.com/matt-cochran/jevitate)

Jevitate is an **MIT-licensed, open-source** CLI and MCP server for testing web apps, keeping
replayable user journeys, and producing demos and step-by-step guides from those journeys.

Jevitate explores your web app in a real browser, tries to break it, and reports only what the
browser can prove: HTTP 5xx responses, uncaught exceptions, hangs, failed success checks, broken
rules you declare. Every finding comes with a Recording that reproduces it. Jevitate replays it to
confirm a fix and commits it as a regression you can run in CI. A model may suggest what to try.
It never decides whether your software passed.

## Quick start

You need Node.js 22+ and a web app you are authorized to test. Start your app locally, then:

```bash
npm install -g @jevitate/cli
jevitate install-browser

# From your app's repository: creates .jevitate/ and sets up coding-agent integrations.
jevitate init

# No API keys needed: the adversarial mission plans its misuse in code.
jevitate explore --strategy adversarial --url http://localhost:3000/settings --fake-ai
```

Replace the URL with your running app's page. `init` offers AI key setup; keys are optional for
the `--fake-ai` example. That mode uses deterministic stand-ins for advisory model calls and
still drives a real browser. See the [no-key demo](https://github.com/matt-cochran/jevitate/blob/main/docs/demo.md)
for a fixture with a known bug.

Read the printed outcome, defect fingerprints and result path. Results and replayable Recordings
are saved under `.jevitate/logs/`. A finding is evidence to investigate; an inconclusive run does
not prove the page passed. The
[operations guide](https://github.com/matt-cochran/jevitate/blob/main/docs/operations.md)
explains outcomes and exit codes.

## What you can do next

| Goal | Start here |
| --- | --- |
| Verify a fix and keep a regression | [Verification](https://github.com/matt-cochran/jevitate/blob/main/docs/verification.md) and [CI](https://github.com/matt-cochran/jevitate/blob/main/docs/ci.md) |
| Author or record a flow, then replay it across environments | [Journeys](https://github.com/matt-cochran/jevitate/blob/main/docs/journeys.md) |
| Make a captioned demo and a guide with screenshots | [Journey demos](https://github.com/matt-cochran/jevitate/blob/main/docs/journeys.md#demo-a-journey-video-subtitles-and-a-step-by-step-guide) |
| Let Claude Code, Codex, Cursor or an MCP client drive | [Agent integrations](https://github.com/matt-cochran/jevitate/blob/main/docs/agents.md) |
| Test a signed-in app | [Authentication](https://github.com/matt-cochran/jevitate/blob/main/docs/authentication.md) |

## Jevitate and Journeeze

[Journeeze](https://journeeze.dev) builds on Jevitate's journeys to bring **in-app help and human
feedback** into your live product. Jevitate verifies that a flow works in a real browser;
Journeeze helps people follow it and tells your team where they are confused or stuck.

Journeeze imports the personas, jobs and journeys in your `.jevitate/` catalog. Your team reviews
and publishes guides, then uses the [Journeeze SDK](https://www.npmjs.com/package/@journeeze/sdk)
to show help and collect opt-in, element-anchored comments and reactions. Related feedback can
be grouped and filed as GitHub issues.

Jevitate works independently and remains MIT licensed. Journeeze is a separate hosted service
in early access, with its own account, site key and service terms. Visit
[journeeze.dev](https://journeeze.dev) for access and SDK setup.

## Links and license

- [Product website](https://jevitate.com)
- [Changelog](https://github.com/matt-cochran/jevitate/blob/main/CHANGELOG.md)
- [Report an issue](https://github.com/matt-cochran/jevitate/issues)
- [Contribute](https://github.com/matt-cochran/jevitate/blob/main/CONTRIBUTING.md)
- [MIT license](https://github.com/matt-cochran/jevitate/blob/main/LICENSE)
