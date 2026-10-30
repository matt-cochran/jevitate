---
"@jevitate/cli": minor
---

Add an opt-in dev-server (Vite/HMR) settle policy (#745). `settle.devServer` / `--dev-server` discounts asset-classified reads — a Vite dev server's modules, scripts, styles, fonts and images — from settling, so cold-load and HMR churn is no longer mistaken for a hang. A non-asset write still keeps settling waiting and stays tracked, and a configured `timing.apiPrefixes` / `--api-prefix` still wins over a Vite-shaped path (an `/api/src/…` read is the API). Default behavior is unchanged.
