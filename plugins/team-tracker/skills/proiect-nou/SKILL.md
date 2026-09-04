---
name: proiect-nou
description: Use when the user wants to start a brand-new project end to end — invokes "/proiect-nou <slug>" or says "proiect nou", "începem un proiect nou", "creează proiectul X", "fă-mi scheletul pentru site-ul Y", "new project". From the human's site map (pages + what each must do) it runs an interactive creation session that scaffolds the repo from the house template (tokens as the single design source, canonical component catalog, a CLAUDE.md whose rules are enforced by `npm run check:rules`, AGENTS.md mirror), generates the UI conventions file the Consistență UI panel reads, and creates the project in Team Tracker with every page and section in UI Coverage as `planned` surfaces carrying their purpose — zero criteria, zero human gates. Writes only after the displayed proposal is confirmed. Triggers include "proiect nou", "/proiect-nou", "pornim proiectul", "creează proiectul", "site nou", "app nou", "start a new project".
---

# Proiect nou

Sesiunea de creare a unui proiect. Pornește de la site map-ul omului — fiecare pagină cu ce
trebuie să facă — și lasă în urmă trei lucruri care de obicei apar târziu sau deloc: un repo
cu sistemul de design ca sursă unică și reguli verificate de o comandă, convențiile UI
generate din ziua zero, și proiectul în Team Tracker cu toate paginile și secțiunile lor în
UI Coverage, cu scopul fiecăreia memorat. Design spec:
`team-tracker/docs/superpowers/specs/2026-09-04-proiect-nou-si-sesiunea-de-constructie-design.md`.

Comanda: `/proiect-nou <slug>`. Fără slug, întreabă-l. Un slug care există deja în
`tt_projects` nu e o eroare: oferă modul „adaugă ce lipsește" (doar suprafețe noi, după cheie
stabilă) și nu recrea nimic.

Vorbește română. Fiecare întrebare merge prin unealta de întrebări cu opțiuni a clientului,
cu 2–4 variante, una marcată „Propunerea mea: …" cu motivul în aceeași frază (regula 22 din
`/plan-deadlines`). Runde de cel mult 3–4 întrebări, apoi te oprești și aștepți.

## Reguli dure

1. **Zero scrieri înainte de confirmare.** Fazele 0 și 1 nu ating nici discul, nici baza.
   Propunerea completă se afișează, omul confirmă explicit, abia apoi se scrie.
2. **Zero criterii la creare.** Paginile și secțiunile intră cu `purpose`, nu cu criterii
   în `tt_ui_surface_criteria`. Un criteriu se scrie doar după ce omul a văzut secțiunea pe
   ecran; altfel Gate 0 s-ar putea apăsa pe hârtie.
3. **Nicio poartă umană.** `manual_verdict`, `verdict_fingerprint`, `spec_approved_at`,
   `shipped_at`, `launch_stage` nu se scriu — baza le respinge oricum. `planning_enabled`
   rămâne al omului.
4. **Niciun DDL.** Migrarea care a adus `planned`, `purpose` și coloanele de convenții e în
   app (`20260904120000_planned_surfaces_and_purpose.sql`). Dacă lipsește din bază (eroare pe
   coloană), oprește-te și spune că app-ul nu e la zi; nu o aplica tu.
5. **Niciun secret prin chat.** Cheile Supabase ale proiectului nou le pune omul în `.env`;
   tu scrii doar `.env.example`.
6. **Cheile stabile vin din contractul auditului.** Fiecare suprafață primește
   `stable_key` din `../ui-audit/scripts/audit-contract.mjs` (`stableSurfaceKey`), prin
   `scripts/sitemap-to-surfaces.mjs`. Așa `/ui-audit` recunoaște secțiunea când o găsește în
   cod și o trece pe `active` în loc să creeze un duplicat.
7. **Chrome-ul partajat o singură dată.** Header, footer, navigația sunt unități canonice pe
   pagina-hub a layout-ului, nu câte una pe fiecare pagină.
8. **Overlay-ul nu se editează în proiect, ci în template.** Ce e greșit în `templates/` se
   repară aici, ca următorul proiect să nu moștenească greșeala.

Supabase project ref: `ntjzghsbrzkvpkniotaj`. Numele uneltei MCP de SQL variază per client
(`mcp__supabase-mcp-server__execute_sql`, `mcp__…__execute_sql`); folosește-o pe cea din
mediul curent.

## Faza 0 — Intake

Cere, în ordinea asta, doar ce lipsește din mesajul omului:

1. **Numele** proiectului și **slug-ul** (`[a-z0-9_]+`, cum sunt cele din
   `../orchestrate/projects.json`).
2. **Platforma**: `site` (web; viewporturi 1440×900, 768×1024, 375×812) sau `app` (native;
   doar 375×812). Decide `platforms` pe toate suprafețele și setul de viewporturi din
   `docs/design-system.md`.
3. **Stack-ul**: `vite-react` (site sau app; app primește add-on-ul Capacitor) sau `astro`
   (site de prezentare, conținut static). Recomandă `astro` doar când nu există login,
   formulare cu backend sau stare de utilizator.
4. **Site map-ul**: o pagină pe rând, cu rută (sau nume) și ce trebuie să facă. Acceptă
   orice formă (listă, tabel, proză). Normalizează în structura de mai jos și citește-i-o
   înapoi, pe scurt, ca să confirme că ai înțeles fiecare pagină.
5. **Brand-ul**: culori, fonturi, logo — „ce ai", nu „tot". Ce lipsește se propune în Faza 1.
6. **Profilul de livrare**: brief-ul (îl propui din site map), definiția de „gata" (o propui
   ca listă verificabilă: fiecare pagină de lansare livrată, build verde, deploy pe domeniu,
   date reale), deadline, owner (din `tt_members` active), ore pe săptămână.

Apoi, **per pagină**, propune secțiunile din ce are de obicei o pagină de felul ei — contact:
hartă, program, telefon apăsabil, formular cu confirmare; listă: filtre, listă, stare goală,
paginare; produs: galerie, preț, acțiune principală, detalii; formular: câmpuri, validare,
confirmare — bifează ce a cerut deja omul și ridică restul ca întrebări cu opțiunile
„Obligatoriu la lansare" / „Opțional" / „Nu ne trebuie", cu recomandarea ta. Recomandă
„obligatoriu" doar pentru ce contează la lansare; când e util dar nu acum, propune tu
„opțional", ca scopul să nu crească din politețe.

Chrome-ul partajat: propune o pagină-hub (de obicei `/`) și pune acolo, o singură dată,
`Header`, `Footer`, `Navigație`. Pe celelalte pagini nu le repeta.

Rezultatul fazei e `sitemap.json` în memorie (nescris încă):

```json
{
  "codebase": "website",
  "platform": "web",
  "pages": [
    {
      "route": "/contact",
      "label": "Contact",
      "purpose": "Vizitatorul găsește adresa, programul și un formular care confirmă trimiterea.",
      "navigation_hint": "Meniu → Contact",
      "required_for_launch": true,
      "importance": "launch",
      "sections": [
        { "label": "Hartă", "purpose": "Harta cu pin pe adresă, deschide navigația la tap.", "required_for_launch": true, "importance": "launch" }
      ]
    }
  ]
}
```

`codebase` e `website` pentru site și `app` pentru app; e același label care intră în
`projects.json → codebases[].label` și în `codebase_label` al suprafețelor. `purpose` e în
cuvintele omului plus cerințele funcționale acceptate — el e ce citește sesiunea de
construcție și promptul din Productivitate.

## Faza 1 — Sistemul de design

1. **Paleta.** Din brand când există. Ce lipsește: 2–3 propuneri complete
   (`bg`, `surface`, `text`, `text-muted`, `primary`, `primary-contrast`, `accent`,
   `danger`, `border`), fiecare cu contrastul calculat (WCAG AA: text ≥ 4.5, butoane ≥ 3)
   și cu motivul (domeniul, precedentul din produsele similare, lizibilitatea pe telefon).
   O paletă care pică AA nu se propune.
2. **Fonturi**: `sans` și `display`; propune din familii cu licență liberă dacă omul nu are.
3. **Scările**: spațiere pe bază de 4px, tipografie `xs…3xl`, raze, umbre — default-urile din
   `templates/common/src/styles/tokens.css`; le schimbi doar dacă omul cere.
4. **Catalogul canonic**: Button (primary, secondary, ghost, danger), Input, Select, Card,
   Section, Dialog, Toast, EmptyState. Confirmă cu omul dacă produsul mai cere ceva de la
   început (de exemplu Tabs sau Badge); altfel catalogul e cel din template.

Toate valorile ajung în `tokens.css` prin placeholder-ele din `templates/README.md`. Nicio
culoare și nicio mărime literală în componente: `check:rules` le prinde.

## Faza 2 — Propunerea

Afișează, într-un singur mesaj, tot ce urmează să se întâmple:

1. **Repo**: calea (`<Desktop>/<slug>`), stack-ul, comenzile exacte ale generatorului și
   ale overlay-ului, portul de preview (alege unul liber: citește `preview_port` din toate
   intrările din `projects.json` și ia următorul din intervalul 3000–3999), dacă se creează
   repo privat pe GitHub (`gh repo create <slug> --private --source . --push`).
2. **Sistemul de design**: paleta cu contrastele, fonturile, catalogul.
3. **Site map-ul cu cheile stabile**: tabel pagină → rută → secțiuni (label · cheie ·
   obligatoriu) — ieșirea din `node "<skill_dir>/scripts/sitemap-to-surfaces.mjs" --input
   <sitemap.json>`.
4. **Team Tracker**: rândul `tt_projects` (nume, slug, coloanele de convenții), profilul de
   livrare, N pagini + M secțiuni `planned`, intrarea din `projects.json`.
5. **Ce NU se face**: criterii, porți, deploy, hosting.

Închide cu: „Creez proiectul `<slug>` așa?" și așteaptă un da explicit. Orice modificare
cerută refă propunerea; nu scrie parțial.

## Faza 3 — Scheletul repo-ului

În ordinea asta, oprindu-te la prima eroare:

Ordinea exactă, cu lista fișierelor și a placeholder-elor, e în `templates/README.md`
(„Order of application"); ea bate rezumatul de mai jos dacă diferă.

1. Generatorul ecosistemului, ne-interactiv — verifică flag-urile curente cu `--help`
   înainte: `npm create vite@latest <slug> -- --template react-ts`, respectiv
   `npm create astro@latest <slug> -- --template minimal --typescript strict --no-install
   --no-git`.
2. Overlay: copiază `templates/common/`, apoi `templates/<stack>/` (fișierul din stack
   câștigă); pentru `app` și `capacitor/`. Folderele `_fragments/` nu se copiază: umplu
   placeholder-e.
3. `package.json`: îmbină `scripts`, `dependencies`, `devDependencies` din
   `common/package.scripts.json`, apoi din `<stack>/package.scripts.json`; ce listează deja
   generatorul își păstrează versiunea. Copiază `scripts/check-rules.mjs` și
   `scripts/ui-conventions.mjs` din acest skill în `scripts/`. Lipește `gitignore.append`.
4. Placeholder-ele, **ultimele**, peste toate fișierele, inclusiv `package.json` îmbinat
   (`dev` poartă `{{PREVIEW_PORT}}`): `{{PROJECT_NAME}}`, `{{SLUG}}`, `{{STACK}}`,
   `{{PLATFORM}}`, `{{CODEBASE}}`, `{{PREVIEW_*}}`, `{{COLOR_*}}`, `{{FONT_*}}`,
   `{{CONTRAST_*}}`, `{{CREATED_AT}}`, `{{FOLDER_TREE}}` din `_fragments/`,
   `{{SITEMAP_PAGES}}` din `node "<skill_dir>/scripts/sitemap-to-surfaces.mjs" --input
   <sitemap.json> --markdown`. `{{PROJECT_ID}}` rămâne `pending` până la Faza 4. Fișierele
   `.tmpl` se scriu fără sufix.
5. Șterge resturile generatorului (regula de cod mort se aplică de la primul commit):
   lista din README, pasul 8. `src/vite-env.d.ts` rămâne: `check:rules` acceptă directiva
   `/// <reference`.
6. `npm install`, apoi `npm install -D vitest jscpd @types/node` (+ `tailwindcss
   @tailwindcss/vite` la `vite-react`, `@astrojs/check` la `astro`) și
   `npm install @supabase/supabase-js` (+ `react-router` la `vite-react`).
7. `npm run conventions` → `docs/ui-conventions.md` cu totul `RESPECTATĂ`, `măsurat 0`
   (Contrast rămâne `FĂRĂ CANONIC` doar dacă paleta e încă placeholder — nu e cazul aici).
8. `cp CLAUDE.md AGENTS.md`, apoi `npm run check:rules`, `npm run typecheck`, `npm test` —
   toate verzi pe proiectul gol. Dacă pică, repară în template (regula 8), nu doar în proiect.
9. `git init -b main`, commit `chore: schelet /proiect-nou (<stack>)`. Dacă omul a cerut,
   `gh repo create <slug> --private --source . --push`.
10. `.claude/launch.json` are deja numele și portul din placeholder-e; verifică-l.

Nu porni serverul de dezvoltare ca dovadă: proiectul gol nu are ce arăta. Dovada sunt
comenzile din pasul 5.

## Faza 4 — Team Tracker

O singură tranzacție SQL, în ordinea asta:

1. `INSERT INTO tt_projects (name, slug, is_archived, ui_conventions_repo,
   ui_conventions_path, ui_conventions_ref, ui_conventions_private)` — repo-ul GitHub în
   forma `owner/repo` dacă există, altfel `NULL` (panoul spune „încă nu"); `ref` e `main`;
   `private` după cum a fost creat. `RETURNING id`.
2. `INSERT INTO tt_delivery_profiles` cu brief, `definition_of_done`, deadline,
   `owner_member_id`, `weekly_capacity_hours`, `planning_enabled = false`. Nu atinge
   `launch_stage`.
3. Suprafețele: SQL-ul din `node "<skill_dir>/scripts/sitemap-to-surfaces.mjs" --input
   <sitemap.json> --sql --project-id <id>` — pagini întâi, secțiuni cu `parent_id` rezolvat
   după cheia părintelui, `inventory_state = 'planned'`, `inventory_origin = 'manual'`,
   `purpose`, `required_for_launch`, `manual_importance`, `platforms`, `codebase_label`.
   Zero rânduri în `tt_ui_surface_criteria`.
4. Verifică: `COUNT(*)` pe pagini și secțiuni egal cu propunerea; `tt_section_pipeline`
   arată fiecare secțiune `planned` cu `next_action = 'needs_spec'`.

După commit, în afara bazei:

5. Intrarea în `../orchestrate/projects.json`: `{ "project_id", "repo_path", "codebases":
   [{ "label": "<codebase>", "repo_path" }], "git": true, "preview_name", "preview_port" }`.
6. Înlocuiește `{{PROJECT_ID}}` în `CLAUDE.md`, regenerează `AGENTS.md`, commit
   `chore: leagă proiectul de Team Tracker (#<id>)`.

## Faza 5 — Raport

Compact, în română:

- proiectul: id, slug, repo, port, stack;
- site map-ul cu cheile stabile și ce e obligatoriu la lansare (N/M secțiuni);
- sistemul de design: paleta cu contrastele, unde stau tokens și convențiile;
- comenzile repo-ului: `dev`, `test`, `check:rules`, `conventions`;
- ce urmează: `/borne` pentru praguri, `/plan-deadlines <slug>` pentru prima coadă; prima
  sesiune de construcție se copiază din Productivitate → coada zilei, iar o secțiune
  `planned` primește automat playbook-ul de construcție;
- dacă panoul Consistență UI nu vede încă convențiile: app-ul citește sursa din
  `tt_projects` abia după deploy-ul care aduce PR-ul 2 din spec; spune-o o singură dată.

Propune `/pontaj` la închiderea sesiunii.

## Modul „adaugă ce lipsește"

Când slug-ul există deja: încarcă suprafețele curente, rulează Faza 0 doar pentru paginile
noi sau secțiunile noi, generează cheile, arată diff-ul (ce se adaugă, ce există deja după
cheie, ce ar fi duplicat de chrome) și inserează doar ce lipsește. Nu modifica `purpose` al
unei suprafețe existente fără să întrebi — poate fi deja rescris de om în UI Coverage.

## Checklist de calitate

- [ ] Nicio scriere pe disc sau în bază înainte de confirmarea explicită.
- [ ] Fiecare pagină și secțiune are `purpose` în cuvintele omului; zero criterii create.
- [ ] Cheile stabile vin din `stableSurfaceKey`, cu `codebase` identic cu `codebases[].label`.
- [ ] Chrome-ul partajat există o singură dată, pe pagina-hub.
- [ ] Paleta trece AA; nicio valoare literală în componente; `tokens.css` e singura sursă.
- [ ] `npm run conventions`, `npm run check:rules`, `npm test` verzi pe proiectul gol.
- [ ] `AGENTS.md` identic cu `CLAUDE.md`; `{{PROJECT_ID}}` înlocuit după insert.
- [ ] `projects.json` are intrarea, cu port liber și `codebases[].label`.
- [ ] Nicio poartă umană, niciun `launch_stage`, niciun DDL, niciun secret în chat.
- [ ] Raportul spune pașii următori și, o singură dată, dacă panoul de convenții încă nu
      citește din `tt_projects`.
