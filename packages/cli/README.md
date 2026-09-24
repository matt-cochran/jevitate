# @jevitate/cli

**Autonomous browser testing that turns discovered bugs into deterministic regression tests.**

Jevitate explores your web app in a real browser, tries to break it, and reports only what the
browser can prove: HTTP 5xx responses, uncaught exceptions, hangs, failed success checks, broken
rules you declare. Every finding comes with a Recording that reproduces it. Jevitate replays it to
confirm a fix and commits it as a regression you can run in CI. A model may suggest what to try.
It never decides whether your software passed.

```bash
npm install -g @jevitate/cli
npx playwright install chromium

# No API keys needed: the adversarial mission plans its misuse in code.
jevitate explore --strategy adversarial --url http://localhost:3000/settings --fake-ai
```

- Documentation, demo and source: https://github.com/matt-cochran/jevitate
- Website: https://jevitate.com
- Changelog: https://github.com/matt-cochran/jevitate/blob/main/CHANGELOG.md

MIT licensed.
