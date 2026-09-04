```text
src/
├── pages/                   file-based routes: index.astro is `/`, contact.astro is `/contact`
├── layouts/
│   └── Base.astro           the <html> shell: imports tokens.css + global.css, meta, <slot />
├── components/
│   ├── Section.astro        renders <section data-section="…">; every UI Coverage section uses it
│   └── islands/             React islands, only where a section needs client interaction
│                            (add @astrojs/react first; islands import components/ui/ from React)
├── lib/                     supabase.ts, pure logic and data access (camelCase.ts)
└── styles/
    ├── tokens.css           the design tokens — single source of truth
    └── global.css           plain CSS: reset + canonical classes (.button, .card, .input,
                             .empty-state, .section) built only on tokens
public/                      static assets served as-is
docs/                        sitemap.md (snapshot), design-system.md, ui-conventions.md (generated),
                             superpowers/{specs,plans}/
scripts/                     check-rules.mjs, ui-conventions.mjs
tests/                       Vitest — one <feature>.test.ts per feature
```
