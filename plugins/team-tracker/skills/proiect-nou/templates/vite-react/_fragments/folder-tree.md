```text
src/
├── main.tsx                 entry: imports tokens.css + global.css, mounts <App />
├── app/
│   ├── App.tsx              providers (ToastProvider) + <RouterProvider>
│   └── routes.tsx           react-router route table — one entry per page
├── pages/                   one file per route (PascalCase.tsx); the page composes Sections
├── components/
│   └── ui/                  the canonical catalog: Button, Input, Select, Card, Section,
│                            Dialog, Toast (+ useToast, toastContext), EmptyState, Spinner
├── hooks/                   custom hooks (useX.ts) — created with the first hook
├── lib/                     supabase.ts, cn.ts, pure logic and data access (camelCase.ts)
└── styles/
    ├── tokens.css           the design tokens — single source of truth
    └── global.css           Tailwind import + token → theme mapping + base styles
docs/                        sitemap.md (snapshot), design-system.md, ui-conventions.md (generated),
                             superpowers/{specs,plans}/
scripts/                     check-rules.mjs, ui-conventions.mjs
tests/                       Vitest — one <feature>.test.ts per feature
capacitor/                   (apps only) the Capacitor add-on steps
```
