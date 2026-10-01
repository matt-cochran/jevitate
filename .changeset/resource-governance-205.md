---
"@jevitate/cli": minor
"jevitate": minor
---

Resource governance for shared machines (#205).

- **Machine-wide browser cap.** At most `--max-browsers` jevitate processes have a browser open at once, across every jevitate on the machine. They share file slots under `~/.jevitate/run/browser-slots/`. A slot whose holder died, or that sent no heartbeat for 3 minutes, is reclaimed. The default is `JEVITATE_MAX_BROWSERS`, else cores/4, at least 2 and at most 6.
- **Memory ceiling.** A run's browser memory (browser, renderers and helpers; Linux PSS, macOS RSS) is sampled every 2 s. Past `--max-browser-memory <MiB>` (else `JEVITATE_MAX_BROWSER_MEMORY_MB`, else 4 GiB or half the RAM), the session's page is closed. The run ends `inconclusive` with `failure.kind: "resource-limit"`, naming the measured value and the ceiling. It is never `crashed` and never a finding about the app.
- **Adaptive throttling.** Above 2 load per core, under 1.5 GiB available, or under memory pressure, a new run takes half the machine cap and the default settle windows double. At 4 load per core or under 512 MiB available, a new run refuses with `E_HOST_STARVED` (exit 2) unless `--ignore-host-load`.
- **Orphan cleanup.** Every launched Chromium carries `--jevitate-owner=<pid>@<start>`. Before each browser-driving command, browsers whose jevitate is gone are closed and stale slots cleared. The new `jevitate doctor [--cleanup]` reports and cleans on demand. Unmarked processes are never signalled.
- **Results and MCP.** Results record all of this in `hostHealth.resources`: the cap, the slot, the most severe throttle level and every change, the ceiling, peak memory, and any resource limit. The MCP tools that launch a browser take `maxBrowsers` and `maxBrowserMemory`.
- **Turning it off.** `JEVITATE_RESOURCE_GOVERNANCE=off` turns off the automatic parts.
