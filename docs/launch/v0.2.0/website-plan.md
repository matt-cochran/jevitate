# jevitate.com: what's left for the v0.2.0 launch

The homepage and launch surfaces are implemented in the site worktree
`/home/mc/worktrees/site-launch` (branch `site/v0.2.0-launch`, from `origin/dev`). The build
passes. The changes are **not committed**: the commit step was blocked by the local permission
policy. This page lists what the maintainer still has to do. The full description of the changes
is in `LAUNCH-REPORT.md`, under "Public Website". Docs-page rewrites stay in jevitate-site issue
#16. Only pages that contradicted the CLI were touched here.

## 1. Commit and open the PR (site repo)

```bash
cd /home/mc/worktrees/site-launch
git status                      # Unified.astro and Regression.astro are already staged for deletion
pnpm install && pnpm run build  # expect "13 page(s) built"
git add src/pages/docs public/llms.txt public/llms-full.txt
git commit -m "docs: fix commands and claims that contradict the 0.2.0 CLI"   # full message in LAUNCH-REPORT.md
git add -A
git commit -m "homepage: v0.2.0 launch positioning, demo slot, quick start, SEO metadata"
git push -u origin site/v0.2.0-launch   # then open a PR into dev
```

## 2. Drop in the demo recording

Record it by following `docs/demo.md` → "Recording the launch GIF or video" in the jevitate repo.
Use the same recording as the README.

1. Copy the files to the site:
   - `public/demo/jevitate-demo.mp4` (H.264, 1280×720 or larger, 20 to 30 s, muted, under ~8 MB)
   - `public/demo/jevitate-demo-poster.png` (a still of the final "fixed" frame)
2. In `src/config.ts`, set:
   ```ts
   export const demo = {
     videoSrc: "/demo/jevitate-demo.mp4",
     posterSrc: "/demo/jevitate-demo-poster.png",
     caption: "…unchanged…",
   } as const;
   ```
3. That switches the `#demo` section from the step list to a `<video controls muted playsinline>`
   player, and adds the **Watch the demo** CTA to the hero. Nothing else changes.
4. `pnpm run build`, then check `/` at 375px and 1440px.

## 3. Switch on the v0.2.0 banner (at release time)

After the GitHub release exists, set this in `src/config.ts`:

```ts
export const releaseBanner = {
  enabled: true,
  version: "0.2.0",
  text: "Jevitate 0.2.0 is out: app-declared invariants, replay-verified fixes and a CI gate.",
  href: "https://github.com/matt-cochran/jevitate/releases/tag/<the real tag>",
} as const;
```

The banner renders only when `enabled` is true **and** `href` is non-empty, so it can't point at
a page that doesn't exist yet. Use the actual tag the release workflow created (for example
`@jevitate/cli@0.2.0`, URL-encoded, or `v0.2.0` if you publish the release under that tag). Turn
it off again after a few weeks.

## 4. Social preview

- The site's Open Graph and Twitter image is already `public/og/jevitate-og.png` (1200×630). It
  is rendered from `scripts/og/card.html` with `scripts/og/render.mjs` (instructions in the
  file), and uses the site's own colors and fonts.
- The GitHub social preview (1280×640, same design) is in the jevitate repo at
  `docs/assets/social-preview.png`. Upload it under **Settings → General → Social preview**.

## 5. Deploy (don't deploy before the jevitate release)

- The site deploys from `main` (Cloudflare Workers Builds: `npm run build`, then
  `npx wrangler deploy`). The flow is PR into `dev`, review, then `dev` → `main`.
- **Order matters.** The homepage links to `github.com/matt-cochran/jevitate/blob/main/docs/…`,
  `CHANGELOG.md` and `CONTRIBUTING.md`. Those files only exist on jevitate `main` after v0.2.0 is
  merged there, so merge the site to `main` **after** the jevitate release PR lands. Otherwise the
  capability cards and "Run the 2-minute demo yourself" link will 404.
- The quick-start and demo commands assume `@jevitate/cli@0.2.0` is on npm. 0.1.0 has no
  `--invariants`, `regression run`, `jevitate check` or `--save-storage-state`.

## 6. After the #149 / #150 merges

- `src/pages/docs/ux.astro` says there is no viewport flag. That stops being true when #149
  (`--viewport`/`--device`) merges, so update it under #16.
- Add `--viewport`/`--device` and the invariants `budget` key to the flags reference under #16.

## 7. Checks to repeat before merging to main

```bash
pnpm run build
pnpm run preview   # then click through, or run any internal-link checker over dist/*.html
```

- Mobile (375×812) and desktop (1440×900). There should be no horizontal scroll, and the hero CTAs
  should be visible in the first desktop viewport.
- Keyboard: Tab from the top reaches "Try it", "Try Jevitate", "View on GitHub" and "Run the
  2-minute demo yourself", each with a visible focus outline. The Copy buttons announce as
  "Copy the commands: …".
- Headings: one `h1` per page, and `h2` for every homepage section.
- View source: `<link rel="canonical">`, `og:image`, `twitter:image` and the JSON-LD block are
  present. `/robots.txt` and `/sitemap.xml` resolve.
