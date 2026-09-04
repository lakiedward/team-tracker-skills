# `/proiect-nou` — the house overlay

The repo skeleton comes from the ecosystem generator; these folders are what the skill lays
on top of it. The overlay is small and ours; the build config stays the tool's.

## Order of application

1. **Generator** — `npm create vite@latest <slug> -- --template react-ts` (stack
   `vite-react`) or `npm create astro@latest <slug> -- --template minimal --typescript strict
   --no-install --no-git` (stack `astro`).
2. **`templates/common/`** copied over the repo root. Every stack gets it.
3. **`templates/<stack>/`** copied over the result. A file present in both wins from the
   stack folder (`.env.example` for Astro, for instance).
4. **`package.json` merge** — the `scripts`, `dependencies` and `devDependencies` of
   `common/package.scripts.json`, then of `<stack>/package.scripts.json`, are merged into the
   generator's `package.json`. Stack wins over common; **a package the generator already
   lists keeps the generator's range** (`typescript`, `@types/node`, `vite` …) — the ranges
   in these files are a fallback for what the generator does not ship. The skill then pins
   real versions by installing: `npm install`, then
   `npm install -D vitest jscpd @types/node` (+ `tailwindcss @tailwindcss/vite` for
   `vite-react`, `@astrojs/check` for `astro`) and `npm install @supabase/supabase-js`
   (+ `react-router` for `vite-react`). `@types/node` is needed by both tests
   (`node:fs`, `node:child_process`); the Vite generator ships it, Astro's minimal template
   does not, and `astro check` type-checks `tests/` because its `tsconfig` includes `**/*`.
5. **`scripts/`** — the skill copies `check-rules.mjs` and `ui-conventions.mjs` from
   `../scripts/` into the repo's `scripts/` (they are not part of `templates/`).
6. **`.gitignore`** — the lines of `common/gitignore.append` are appended, skipping lines the
   generator's file already has.
7. **Placeholders — last, over every file including the merged `package.json`** — every
   `{{NAME}}` is replaced (table below); the `dev` script carries `{{PREVIEW_PORT}}`, so a
   replacement pass that runs before the merge leaves it unrendered. Files ending in
   `.tmpl` are written without the suffix (`CLAUDE.md.tmpl` → `CLAUDE.md`,
   `docs/sitemap.md.tmpl` → `docs/sitemap.md`). `_fragments/` folders are **read, never
   copied**: their content fills a placeholder (`{{FOLDER_TREE}}`).
8. **Generator leftovers deleted** (the dead-code rule applies from commit one):
   `vite-react`: `src/App.tsx`, `src/App.css`, `src/index.css`, `src/assets/react.svg`,
   `public/vite.svg`, and the `<link rel="icon">` line in `index.html` that points at it;
   `astro`: `src/pages/index.astro` is overwritten, nothing else to delete with the minimal
   template. In `index.html` (`vite-react`) set `lang="ro"` and `<title>{{PROJECT_NAME}}</title>`.
   `src/vite-env.d.ts` holds a `/// <reference types="vite/client" />` triple-slash
   directive. It stays: `check-rules.mjs` treats `/// <reference` directives (and a
   first-line shebang) as the only two non-comments, verified on a scaffold, so the file
   passes as is.
9. **After copying**, in this order:
   `npm run conventions` → `docs/ui-conventions.md` (everything canonical, nothing measured
   yet); `npm run check:rules` (must exit 0 on the fresh repo — it is what
   `tests/check-rules.test.ts` asserts); `cp CLAUDE.md AGENTS.md`; `npm run typecheck`;
   `npm test`; `git init` + first commit `chore: schelet /proiect-nou`.
10. `capacitor/` (in `vite-react/`) is copied **only when the platform is `app`**.

## Placeholders

| Placeholder | Meaning | Default when not asked |
|---|---|---|
| `{{PROJECT_NAME}}` | Human-readable name, used in titles and the hero | required |
| `{{PROJECT_BRIEF}}` | One sentence: what the product is (from the intake) | required |
| `{{SLUG}}` | `tt_projects.slug`, also the folder name | required |
| `{{PROJECT_ID}}` | `tt_projects.id` — known only after Faza 3; the skill writes `pending`, then patches `CLAUDE.md` + `AGENTS.md` after the tracker insert (second commit) | `pending` |
| `{{STACK}}` | `vite-react` or `astro` | required |
| `{{PLATFORM}}` | `site` or `app` — drives the verification viewports | `site` |
| `{{CODEBASE}}` | `projects.json → codebases[].label`: `website` for a site, `app` for an app; the prefix of every stable key | `website` |
| `{{REPO_URL}}` | GitHub URL, or `local only (no remote yet)` | `local only (no remote yet)` |
| `{{SUPABASE_REF}}` | Supabase project ref; `.env.example` builds the URL from it | `none-yet` |
| `{{PREVIEW_NAME}}` | Name in `.claude/launch.json` and `projects.json → preview_name` | `<slug>-dev` |
| `{{PREVIEW_PORT}}` | Dev-server port; a bare number (it lands in JSON and in `--port`) | `5173` for vite-react, `4321` for astro |
| `{{LIVE_URL}}` | Production URL or `not deployed yet` | `not deployed yet` |
| `{{LANGUAGES}}` | UI languages, e.g. `RO` or `RO (default) + EN` | `RO` |
| `{{CREATED_AT}}` | ISO date of the scaffold | today |
| `{{COLOR_BG}}` | Page background | `#ffffff` |
| `{{COLOR_SURFACE}}` | Cards, inputs, dialogs | `#f6f7f9` |
| `{{COLOR_TEXT}}` | Body text | `#111827` |
| `{{COLOR_TEXT_MUTED}}` | Secondary text | `#6b7280` |
| `{{COLOR_PRIMARY}}` | The action colour | `#2563eb` |
| `{{COLOR_PRIMARY_CONTRAST}}` | Text on primary and danger | `#ffffff` |
| `{{COLOR_ACCENT}}` | Highlights, success | `#059669` |
| `{{COLOR_DANGER}}` | Destructive, errors | `#dc2626` |
| `{{COLOR_BORDER}}` | Borders, dividers | `#e5e7eb` |
| `{{FONT_SANS}}` | Body font stack | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| `{{FONT_DISPLAY}}` | Heading font stack | `var(--font-sans)` |
| `{{CONTRAST_TEXT_ON_BG}}` | Measured ratio, e.g. `15.9:1` | required (Faza 1 measures it) |
| `{{CONTRAST_PRIMARY}}` | Ratio of `primary-contrast` on `primary` | required (Faza 1 measures it) |
| `{{SITEMAP_PAGES}}` | The rendered page blocks (format below), from `scripts/sitemap-to-surfaces.mjs` | required |
| `{{FOLDER_TREE}}` | Content of `<stack>/_fragments/folder-tree.md` | filled by the skill |

The default colours pass WCAG AA (`text` on `bg` 15.9:1, white on `#2563eb` 5.2:1); they are
only a fallback when the human said "propune tu" and picked none of the proposals.

### `{{SITEMAP_PAGES}}` block format

One block per page, pages in navigation order, produced by `scripts/sitemap-to-surfaces.mjs`
from the same rows it inserts into `tt_ui_surfaces`:

```markdown
## Contact — `/contact`

Stable key: `website:page:/contact` · required for launch: **yes**

Purpose: cum ne găsești și cum ne scrii; adresa, programul, telefonul apăsabil, formularul.

| Section | Stable key | Purpose | Required |
|---|---|---|---|
| Hartă | `website:section:harta:website:page:/contact` | locația pe hartă, cu link de navigare | yes |
| Program | `website:section:program:website:page:/contact` | orele pe zile, cu ziua curentă marcată | yes |
| Formular | `website:section:formular:website:page:/contact` | nume, e-mail, mesaj; confirmare pe ecran | yes |
| Rețele sociale | `website:section:retele-sociale:website:page:/contact` | link-uri către profiluri | no |
```

Shared chrome (header, footer, navigation) appears once, in the block of the layout hub page,
as `/ui-audit` already does. Labels are the human's words; keys come from `stableSurfaceKey`
in `../../ui-audit/scripts/audit-contract.mjs`, never retyped.

## What each file is

### `common/`

| Path | Role |
|---|---|
| `src/styles/tokens.css` | The design tokens: `:root` custom properties with colour and font placeholders, fixed spacing / type / radius / shadow scales. Single source of truth. |
| `src/lib/cn.ts` | Class-name join used by the catalog (in `common/` because the catalog imports it). |
| `src/components/ui/*` | The canonical catalog in React + TypeScript: `Button`, `Input`, `Select`, `Card`, `Section` (`data-section`), `Dialog` (native `<dialog>`, focus return), `Toast` + `useToast` + `toastContext`, `EmptyState`, `Spinner`, `index.ts` barrel. Astro repos keep it only if they add React islands; otherwise the skill deletes `src/components/ui/` and `src/lib/cn.ts` after copying. |
| `tests/docs-mirror.test.ts` | Fails when `AGENTS.md` differs from `CLAUDE.md` (byte compare). |
| `tests/check-rules.test.ts` | Runs `node scripts/check-rules.mjs` and expects exit 0, so the rule suite guards itself under `vitest run`. |
| `.claude/launch.json` | Preview definition for the browser gate. |
| `.env.example` | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (Astro overrides with `PUBLIC_`). |
| `gitignore.append` | Lines appended to the generator's `.gitignore`. |
| `package.scripts.json` | `check:rules`, `conventions`, `test` scripts + `vitest`, `jscpd`, `typescript` dev deps. |
| `docs/sitemap.md.tmpl` | Snapshot of the intake; header says the truth is UI Coverage. |
| `docs/design-system.md.tmpl` | Tokens table, contrast, breakpoints, catalog with allowed variants, Tailwind mapping table. |
| `CLAUDE.md.tmpl` | The 11 sections from the spec, in order; `AGENTS.md` is `cp CLAUDE.md AGENTS.md`. |

### `vite-react/`

| Path | Role |
|---|---|
| `src/main.tsx` | Entry: imports `tokens.css` then `global.css`, mounts `<App />` in `#root`. |
| `src/app/App.tsx`, `src/app/routes.tsx` | `ToastProvider` + `RouterProvider`; one placeholder route (`react-router` v7, `createBrowserRouter`). |
| `src/pages/Home.tsx` | Example page: `<Section stableKey="{{CODEBASE}}:section:hero:{{CODEBASE}}:page:/">`. The first construction session replaces it. |
| `src/lib/supabase.ts` | Client from `import.meta.env.VITE_*`; throws in Romanian when the env is missing. |
| `src/styles/global.css` | `@import "tailwindcss"`, resets Tailwind's colour / text / radius / shadow namespaces, maps tokens with `@theme inline reference`, base styles. |
| `vite.config.ts` | Replaces the generator's: `react()` + `tailwindcss()` plugins, nothing else. |
| `package.scripts.json` | `dev` with `--port {{PREVIEW_PORT}} --strictPort`, `typecheck: tsc -b` (the template's `tsconfig.json` is solution-style, so `tsc --noEmit` would check nothing), `react-router`, `@supabase/supabase-js`, `tailwindcss`, `@tailwindcss/vite`. |
| `capacitor/README.md` | Add-on steps for apps: init, platforms, sync, 375-only rule. Copied only for `app`. |
| `_fragments/folder-tree.md` | Fills `{{FOLDER_TREE}}` in `CLAUDE.md`. Not copied. |

### `astro/`

| Path | Role |
|---|---|
| `src/layouts/Base.astro` | `<html>` shell importing `tokens.css` + `global.css`; `title`, `description`, `lang` (default `ro`). |
| `src/components/Section.astro` | `<section data-section={stableKey}>` with title / description and the `.section*` classes. |
| `src/pages/index.astro` | Example page using `Base` + `Section` with the hero stable key. |
| `src/styles/global.css` | Plain CSS on tokens: reset, `.section*`, `.button` (+ `-primary` / `-secondary` / `-ghost` / `-danger` / `-sm`), `.card`, `.field*`, `.input`, `.select`, `.empty-state*`; one `768px` media query. No Tailwind. |
| `src/lib/supabase.ts`, `.env.example` | Same as Vite with the `PUBLIC_` prefix Astro exposes to the client. |
| `package.scripts.json` | `dev` with `--port`, `typecheck: astro check`, `@astrojs/check`, `@supabase/supabase-js`. |
| `_fragments/folder-tree.md` | Fills `{{FOLDER_TREE}}`. Not copied. |

**React islands in Astro**: they go in `src/components/islands/`, mounted with
`client:visible` / `client:only="react"` from a `.astro` section, after `npx astro add react`.
An island imports the React catalog from `src/components/ui/` — keep that folder when the
first island appears; until then the skill removes it so the repo has no unused code.

## Tailwind v4 assumptions (verify when Tailwind moves)

- Tokens keep their public names (`--color-primary` …) because Astro and plain CSS read them
  directly. Tailwind's theme namespaces of the same name are cleared with `--color-*: initial`
  (also `--text-*`, `--radius-*`, `--shadow-*`), then redefined in `@theme inline reference`:
  `inline` makes utilities carry the value (`var(--color-primary)`) instead of a theme
  variable reference; `reference` stops Tailwind from emitting its own `:root` copy, so the
  only definition of `--color-primary` is `tokens.css` and there is no self-referencing
  declaration in the output. `--font-*` is not cleared so `font-weight` utilities survive;
  `--font-sans` and `--font-display` are simply redefined.
- `--spacing: var(--space-1)` makes every spacing utility a multiple of the 4px token.
- `rounded-full` and `rounded-none` are Tailwind's static utilities and are kept; only
  `--radius-sm/md/lg` are mapped.
- Verified on 2026-09-04 against what the generator produces today — Vite 8.2,
  `@vitejs/plugin-react` 6.1, React 19.2, TypeScript 6.0 — with `tailwindcss` +
  `@tailwindcss/vite` 4.3.3, `react-router` 8.3, `vitest` 5.0: `tsc -b` and `vite build`
  pass, `bg-primary` compiles to `background-color: var(--color-primary)`, `p-6` to
  `calc(var(--space-1) * 6)`, opacity modifiers to `color-mix(in oklab, var(--color-text)
  50%, transparent)`, and the output holds exactly one `--color-primary` definition.
- **Do not fall back to `vitest@^4`**: with npm 10.9.x its peer set crashes
  `npm install` (`Cannot read properties of null (reading 'edgesOut')`). `vitest@^5` is what
  `package.scripts.json` asks for and what installs cleanly; the pristine generator output
  installs fine on its own.

## Safe to edit later vs regenerated

| File | After scaffold |
|---|---|
| `CLAUDE.md` (+ `cp` to `AGENTS.md`) | Edited by hand; sections 10–11 grow, the rest changes with a decision. |
| `docs/design-system.md` | Edited by hand when `tokens.css` changes. |
| `src/styles/tokens.css` | Edited by hand — every change is a Decisions line. |
| `src/components/ui/*` | Edited by hand — extend with variants, never fork. |
| `docs/sitemap.md` | **Snapshot** — not regenerated; the truth is UI Coverage. |
| `docs/ui-conventions.md` | **Generated** by `npm run conventions`; never edited by hand. |
| `scripts/check-rules.mjs`, `scripts/ui-conventions.mjs` | Owned by the skill; updated by copying a newer version from the plugin, not by local edits. |
| `tests/docs-mirror.test.ts`, `tests/check-rules.test.ts` | Stay as they are. |
| `.claude/launch.json`, `.env.example` | Edited when the port or the Supabase project changes; mirror the change in `projects.json`. |
