# Browser extensions

Some flows run partly inside a browser extension, such as a side panel, a popup or an options page.
`--extension <dir>` loads an unpacked extension into the run's browser, so Jevitate can explore,
record, replay and verify those flows too.

```sh
# Explore the extension's side panel, opened as a page
jevitate explore \
  --extension ./my-extension \
  --url chrome-extension://<id>/sidepanel.html \
  --goal "give consent and start a task" \
  --success "textIncludes:css=#status|consent given" --real

# The app and the extension together: the app's origin plus the extension's
jevitate explore --extension ./my-extension --url http://localhost:3000/invite/abc \
  --goal "accept the invite and open the tracker" --success "…" --real
```

`--extension` is repeatable. It is accepted by every command that drives a browser: `explore`
(every strategy), `explore-author-journey`, `journey run|annotate|demo`, `demo`, `verify-fix`,
`check`, `ledger verify`, `regression capture|run`, `load run`, `source run`, `mission run` and
`record`. The MCP tools that mirror these commands take an `extension` array of directories. Over
MCP, each directory must be inside the project or `~/.jevitate/`, like every other MCP path argument.

## What `--extension` does

- **Checks the directory first.** The path must be a directory with a `manifest.json` that has
  `manifest_version` 2 or 3 and a non-empty `name` and `version`. Anything else is a usage error
  (exit 64), raised before a browser opens.
- **Works out the extension id before launch.** It uses Chromium's own rule. If the manifest has a
  `key`, the id comes from that key. Otherwise it comes from the directory's absolute, real path.
  An unpacked extension's id therefore changes when the directory moves (another checkout, another
  machine). To keep the id stable, add a `key` to the manifest.
- **Allows only the loaded ids.** Each loaded extension's `chrome-extension://<id>` origin is added
  to the run's allowed origins. It is added to the default (the `--url` origin) or to your `--allow`
  list. Origins of extensions you did not load stay refused. A `--url chrome-extension://<id>/…`
  for an extension that is not loaded is refused with exit 64, and the refusal lists the ids that
  are loaded. In a `check` suite, an item with its own `allow` list must name the extension origin
  itself.
- **Launches its own browser.** Playwright loads extensions only in a persistent context. Each
  session with extensions gets its own Chromium process on a throwaway profile, outside the shared
  browser pool. The profile is deleted when the session closes. `--storage-state` still works: it
  is applied to that profile.
- **Proves the extension loaded.** Before the run starts, it opens
  `chrome-extension://<id>/manifest.json`. If the browser ignored the extension, the run fails at
  that point with the reason, instead of later as a blocked navigation.
- **Records the build.** Every Recording the run writes gets an
  `extensions: [{id, name, version}]` field. This field is additive: the result stays at
  schemaVersion 1. The local path is never recorded.

## Headless and headed

By default a run is headless. Playwright's default headless binary, the *headless shell*, cannot
load extensions. So a headless run with `--extension` uses Playwright's full Chromium build in its
new headless mode (`channel: "chromium"`). That build must be installed:
`jevitate install-browser`. `--headed` works too, but it needs a display.

Branded Google Chrome (version 137 and later) no longer loads unpacked extensions from the command
line. A `--browser-channel chrome` run with `--extension` therefore fails at the load check. Use
the bundled Chromium (no `--browser-channel`, or `--browser-channel chromium`).

## Side panels, popups and options pages

Playwright cannot click the toolbar icon or open Chrome's real side-panel surface. Jevitate opens
the extension's page in a normal tab of the same browser instead. For example:

| Surface      | Start the run at                                                             |
| ------------ | ---------------------------------------------------------------------------- |
| Side panel   | `chrome-extension://<id>/<side_panel.default_path>` (e.g. `sidepanel.html`) |
| Popup        | `chrome-extension://<id>/<action.default_popup>` (e.g. `popup.html`)        |
| Options page | `chrome-extension://<id>/<options_page>`                                     |

The page runs in the extension's origin with full `chrome.*` API access: `chrome.storage`,
messaging to the service worker, and so on. Its DOM is the page model the agent snapshots and acts
on, like any other page. Some behavior depends on the real side-panel surface or on the popup's
size and auto-close, for example `chrome.sidePanel.open` or the popup closing on blur. That behavior
is not reproduced.

## Replays refuse a different build

`verify-fix` replays a finding only under the extension build the finding was recorded with: the
same ids, names and versions. A finding recorded without extensions replays only without them.
Anything else is refused with `E_VERIFY_FIX_INPUT` (exit 64) before a browser opens. `journey run`
applies the same rule to a Journey recorded with extensions (`E_EXTENSION_ARGS`, exit 64). A
Journey recorded without extensions may still be run with an extension loaded.

```sh
jevitate verify-fix <fingerprint> --result <run>.result.json --extension ./my-extension
```
