# Capacitor add-on (apps only)

`/proiect-nou` copies this folder only when the platform is **app**. The web build stays the
same Vite + React + Tailwind project; Capacitor wraps `dist/` in a native shell. Nothing here
changes how sections, tokens or the tracker work.

## One-time setup

```bash
npm install @capacitor/core @capacitor/cli
npx cap init "{{PROJECT_NAME}}" ro.{{SLUG}}.app --web-dir dist
npm install @capacitor/android @capacitor/ios
npx cap add android
npx cap add ios
```

`npx cap init` writes `capacitor.config.ts`; keep it at the repo root and commit it. The
generated `android/` and `ios/` folders are committed too — they hold signing and plugin
configuration that the build cannot regenerate.

## Every release

```bash
npm run build
npx cap sync
npx cap open android
npx cap open ios
```

`cap sync` copies `dist/` into both platforms and installs native plugin code. Run it after
every `npm install` that adds a Capacitor plugin.

## Rules that differ from a site

- **One viewport: 375.** Design and verify at 375 wide only; there is no desktop layout and
  the `md:` prefix is not used in app components.
- **Safe areas** come from `env(safe-area-inset-*)`; add `viewport-fit=cover` to the
  `<meta name="viewport">` in `index.html` so they are reported.
- **Native-only features** (push, biometrics, Apple Sign-In sheet, camera) cannot be
  verified in the browser preview. They are left `Open` in the tracker with a note for a
  human on a device — never marked done from the preview.
- **Router**: `createBrowserRouter` works inside the shell; deep links need
  `@capacitor/app` and a handler in `src/app/`, added when the first one is needed.
- **Supabase** reads `.env` at build time; the anon key ships in the bundle, so RLS is the
  security boundary, as on the web.
