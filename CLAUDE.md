# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # start dev server (localhost:4321)
npm run build     # production build to dist/
npm run preview   # preview production build
```

Scripts use `node ./node_modules/astro/astro.js` directly (not `astro` CLI) to avoid Vercel permission errors on Windows-committed repos.

## Architecture

Astro 5 static site with Tailwind CSS. No framework components — all `.astro` files.

**Content Collections** (`src/content/config.ts`):
- `abroad`, `projects`, `economics`, `books` — all use the same `postSchema` (`title`, `date`, `description`, `tags?`)
- `photography` — custom schema with `cover` (path string), `photos[]` (`src`, `caption?`), `location?`
- `film` — custom schema with `cover`, `photos[]`, `camera?`, `film?`; nested under `photography/film/`
- `timeline` — YAML data collection (currently unused, no page routes)

**Page patterns** — two consistent layouts used across all content sections:

1. List page (`/[section]/index.astro`): header block with gray uppercase tag + h1 + description, then a `divide-y divide-gray-100` list of date | title+description | arrow rows.

2. Detail page (`/[section]/[slug].astro`): `max-w-2xl` article with back link → gray uppercase tag → h1 → date → `prose prose-gray` content.

**Exception**: `photography/` uses a different visual style — dark overlay hero image + CSS columns masonry grid. The list page (`photography/index.astro`) still uses dark card overlays with `#4a9eff` accent color, unlike the white/gray palette everywhere else. `photography/film/` is a nested sub-section with its own list + detail pages, same dark style.

**BaseLayout** (`src/layouts/BaseLayout.astro`): fixed nav with active-path highlighting, GitHub + Bilibili icon links, `<slot />` wrapped in `<main class="pt-[57px]">`.

**Homepage** (`src/pages/index.astro`): hero → WHO AM I / WHERE IS IT panel (profile photo + two text columns) → recent posts ticker (auto-sorted from all 4 text collections, max 5) → section cards grid → photography preview (latest 3 albums).

## Fonts & Styling

- Body: `Noto Sans SC` (Google Fonts)
- Headings (h1–h3): `Noto Serif SC`
- Prose content: `prose prose-gray` from `@tailwindcss/typography`
- Color palette: white background, `gray-900` text, `gray-300`/`gray-400` for secondary/muted

## Static Assets

Photos live in `public/photos/`. The Equatorial Guinea album references `/photos/eq-001.jpeg` through `/photos/eq-098.jpeg`. Profile photo: `/photos/profile/ef00a9f15c4043ceea0cf65a5646a7c.jpg`.

## Deployment

Vercel — auto-deploys on push to `main`. GitHub: `https://github.com/enhen-x/Personal-website.git`.
