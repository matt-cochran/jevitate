# jevitate

[Website](https://jevitate.com) · [Quick start and documentation](https://www.npmjs.com/package/@jevitate/cli) · [Open-source repository](https://github.com/matt-cochran/jevitate)

A bare-name alias for [`@jevitate/cli`](https://www.npmjs.com/package/@jevitate/cli), which does
autonomous browser testing that turns discovered bugs into deterministic regression tests.
Installing either package gives you the same `jevitate` command:

```bash
npm install -g jevitate
jevitate install-browser

# From your app's repository (Node.js 22+):
jevitate init
jevitate explore --strategy adversarial --url http://localhost:3000/settings --fake-ai
```

Replace the URL with a running app you are authorized to test. The `--fake-ai` example needs no
AI keys and runs a real browser. See the [full package guide](https://www.npmjs.com/package/@jevitate/cli)
for outcomes, journeys, regression tests, demos and agent integrations.

Jevitate is MIT-licensed and works independently. [Journeeze](https://journeeze.dev), a separate
hosted service in early access, builds on Jevitate journeys to deliver in-app help, collect
opt-in human feedback and turn related reports into GitHub issues. Learn more at
[jevitate.com](https://jevitate.com) and [journeeze.dev](https://journeeze.dev).
