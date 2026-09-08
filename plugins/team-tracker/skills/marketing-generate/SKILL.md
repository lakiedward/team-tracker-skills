---
name: marketing-generate
description: Use when planned Instagram posts of a Team Tracker project need their copy and slide images produced — invoked by /marketing ("/marketing generate", "/marketing regen") or directly as "/marketing-generate", "generează postările", "fă slide-urile", "randează caruselul", "regenerează slide 4", "render the carousel". For each planned (or needs-changes) post it writes the caption and per-slide copy from the brief and the site copy, renders every slide from the brand HTML templates with headless Chromium at 1080×1350, uploads the PNGs to the private marketing-assets bucket, writes tt_marketing_slides rows as they land so Team Tracker fills in live, and sets the post to generated. One subagent per post, in parallel. Never approves, publishes or touches the human-gate columns.
---

# marketing-generate — texte + slide-uri randate, urcate și scrise în bază

Aplică [execuția locală și verificarea în browser](../references/local-execution.md).

O postare `planned` are un brief; skill-ul ăsta o face reală: caption, textul fiecărui
slide, imaginile. Imaginile nu sunt generate de AI: fiecare slide e un template HTML pe
tokenii de brand, cu o captură reală a produsului, capturat de Chromium headless la
1080×1350 (4:5). Rândurile de slide se scriu **înainte** de imagini și se completează pe
măsură ce urcă, ca omul să vadă progresul live în Team Tracker → Marketing.

## Constants

| Ce | Valoare |
|---|---|
| Supabase project ref | `ntjzghsbrzkvpkniotaj` |
| Tabele scrise | `tt_marketing_posts` (caption, hashtags, version, status), `tt_marketing_slides` |
| Bucket | `marketing-assets` (privat); cale `<project_id>/posts/<post_id>/v<version>/slide-NN.png` |
| Cheia de upload | `SUPABASE_SERVICE_ROLE_KEY` din mediu; lipsă = stop **înainte** de orice scriere |
| Format | PNG 1080×1350; v2 (publicare automată) convertește în JPEG la publicare |
| Randare | `scripts/render-slides.mjs` + Chromium din `%LOCALAPPDATA%/ms-playwright` (fără pachete npm) |
| Validare | `scripts/validate-post.mjs`: 3–10 slide-uri, ≤ 5 hashtag-uri, caption ≤ 2200, assets pe disc, cifre etichetate |
| Limba | engleză |

Scripturile (toate doar Node 22, fără dependențe; fiecare are `*.test.mjs` lângă el):

| Script | Folosire |
|---|---|
| `scripts/asset-inventory.mjs` | `node asset-inventory.mjs --assets <repo>/public` → capturi per proiect, dimensiuni, `carousel_ready` |
| `scripts/validate-post.mjs` | `node validate-post.mjs --post post.json --assets <repo>/public` → `ok` sau lista de erori |
| `scripts/render-slides.mjs` | `node render-slides.mjs --post post.json --assets <repo>/public --out <dir> [--only 3,5]` → PNG-uri + manifest JSON |
| `scripts/upload-slides.mjs` | `node upload-slides.mjs --dir <dir> --project <id> --post <id> --version <n> [--only 3,5]` → căile urcate |

Layout-urile și placeholder-ele: `templates/README.md`; un `post.json` complet, cu toate cele 8
layout-uri pe capturi reale Betora, e în `templates/example-post.json`. Convenția de accent: în `headline`,
`*cuvântul*` dintre asteriscuri iese în Instrument Serif italic, culoarea de accent; unul
per slide, nu mai mult.

## Pas 0 — Precondiții

1. Proiect + context de brand din [`/marketing`](../marketing/SKILL.md) (rulat direct: fă
   Faza 0 de acolo).
2. `SUPABASE_SERVICE_ROLE_KEY` prezent în mediu. Lipsă → raportează și oprește-te. Nu
   ghici, nu folosi cheia `anon`, nu tipări cheia.
3. Chromium găsit: `node scripts/render-slides.mjs` îl caută singur; dacă nu, `--chrome` sau
   `MARKETING_CHROME`. Fără Chromium → fallback: MCP-ul Playwright (`browser_resize`
   1080×1350 + `browser_navigate` pe `file:///…/slide-NN.html` + `browser_take_screenshot`),
   mai lent, același rezultat.
4. Postările țintă: cele `planned` ale campaniei, sau cele numite. Pentru regenerare
   (`needs_changes`), `/marketing` a pus deja `status = 'generating'` și `version + 1`.

## Pas 1 — Un subagent per postare, în paralel

Fiecare subagent primește: rândul postării (brief, `target_slides`, `portfolio_project`,
`version`, `feedback` dacă există), contextul de brand (culori, fonturi, textele din
`en.json` pentru proiectul lui, CTA), calea `<repo>/public`, lista de slide-uri țintite (la
regenerare) și pașii 2–7 de mai jos. Subagentul scrie doar în bază și în bucket, în calea
postării lui; nu atinge repo-ul.

## Pas 2 — Pornirea (o singură scriere)

```sql
update tt_marketing_posts
   set status = 'generating', version = version + 1, updated_at = now()
 where id = <post_id> and status = 'planned'
returning version;
```

(La regenerare `version` e deja incrementată de `/marketing`; nu o incrementa iar.)

## Pas 3 — Textele

- **Caption** (engleză, ≤ 2200): prima linie e hook-ul (aceeași idee ca slide 1, alte
  cuvinte), 2–4 propoziții despre problemă și ce a ieșit, o linie de invitație („Got a
  project idea? Let's talk."), fără hashtag-uri în text. Hashtag-urile stau în coloana lor,
  ≤ 5, fără `#` în valori.
- **Per slide**, pornind din brief: `headline` ≤ 12 cuvinte, `body` ≤ 25 de cuvinte, faptele
  din `en.json` (capitolele de tur, `aiCore`), nu din memorie. Un `*accent*` per headline.
- **Cifre**: orice procent, `+N` sau `Nx` are `disclaimer` = „sample output, not client
  results" pe slide-ul lui; altfel scoate cifra. `validate-post.mjs` refuză oricum.
- La regenerare țintită: rescrie doar slide-urile numite în `feedback`; restul rămân
  cuvânt cu cuvânt ca în versiunea anterioară (citește-le din `tt_marketing_slides`).

Scrie `post.json` în scratchpad:

```json
{ "post_id": 12, "version": 2, "caption": "...", "hashtags": ["alkistudio", "betora"],
  "slides": [ { "order_index": 0, "layout": "cover", "kicker": "CASE STUDY · BETORA",
                "headline": "We built a betting app that *thinks*.", "body": "",
                "meta": "betora.ro · live 2026", "asset": null }, ... ] }
```

## Pas 4 — Validare, apoi rândurile de slide (fără imagini)

1. `node scripts/validate-post.mjs --post post.json --assets <repo>/public` până dă `ok`.
2. Inserează toate slide-urile versiunii curente cu `image_path = NULL`, ca progresul „0/N"
   să apară în app:

```sql
insert into tt_marketing_slides (post_id, version, order_index, layout, headline, body, asset_source, props)
values (<post_id>, <version>, 0, 'cover', '...', '...', null, '{"kicker":"...","meta":"..."}'::jsonb), ...;
```

`props` ține tot ce nu are coloană (`kicker`, `meta`, `inputs`, `outputs`, `stat`,
`disclaimer`, `cta`), ca o regenerare să poată reconstrui slide-ul fără brief.

## Pas 5 — Randare

`node scripts/render-slides.mjs --post post.json --assets <repo>/public --out <scratch>/post-<id>-v<n>`

- Manifestul confirmă 1080×1350 pentru fiecare PNG; altfel oprește-te la slide-ul numit.
- **Uită-te** la copertă, la un slide de captură și la CTA (Read pe PNG): text ieșit din
  marginea de 96px, font generic în loc de Bricolage Grotesque (fonturile n-au apucat să
  se încarce), captură tăiată prost. Repară textul sau props-urile și re-randează doar
  slide-ul (`--only`).
- Chromium tipărește avertismente de sandbox pe stderr; nu sunt eșec. Exit ≠ 0 sau PNG
  lipsă sunt.

## Pas 6 — Upload + completarea rândurilor, slide cu slide

`node scripts/upload-slides.mjs --dir <out> --project <project_id> --post <post_id> --version <n>`

Scriptul verifică fiecare obiect cu GET autentificat după upload. Pentru fiecare cale
întoarsă:

```sql
update tt_marketing_slides set image_path = '<path>', rendered_at = now()
 where post_id = <post_id> and version = <version> and order_index = <i>;
```

Scrie pe rând, în ordinea slide-urilor, nu într-un singur UPDATE la final: exact asta face
cardul din app să se umple live.

## Pas 7 — Închiderea postării

```sql
update tt_marketing_posts
   set caption = '<caption>', hashtags = '{a,b,c}', status = 'generated', updated_at = now()
 where id = <post_id> and status = 'generating' and version = <version>;
```

Apoi verifică: `select count(*) from tt_marketing_slides where post_id = <id> and version = <v>
and image_path is not null` = numărul de slide-uri. Dacă nu, nu închide: repară slide-ul
lipsă.

**La eșec** (randare sau upload care nu se repară): dacă `version = 1`, `status = 'planned'`
și șterge rândurile de slide ale versiunii; dacă există o versiune anterioară, `status =
'generated'` și `version = version - 1` (postarea rămâne pe ce avea), și șterge obiectele
urcate în versiunea eșuată. Raportează exact ce a picat.

## Raport

```
Generat · <titlu> (#<id>) · v<n> · <n>/<n> slide-uri · caption <n> caractere · <n> hashtag-uri
  slide-uri schimbate la regenerare: <lista sau toate>
  verificat: PNG 1080×1350 ×<n>, obiecte 200 ×<n>, rânduri cu image_path <n>/<n>
Așteaptă verificarea ta în Team Tracker → Marketing.
```

## Greșeli de evitat

- Să pui `status = 'generated'` înainte ca toate `image_path` să fie completate: cardul
  arată „Generat 3/8" și omul apasă Approve pe jumătate de carusel.
- Să urci întâi și să scrii rândurile la final: dispare progresul live.
- Să lași `feedback` gol la regenerare sau să-l rescrii. Nu e al tău.
- Să randezi cu Google Fonts neîncărcate și să nu te uiți la PNG.
- Să folosești `anon` la upload sau să tipărești cheia de service.
- Să scrii `approved_at`, `published_*`, `needs_changes`, `rejected`. Trigger-ul respinge.

## When to self-abort

- Cheia de service lipsește → înainte de orice scriere.
- Brief-ul are `asset` inexistente pe disc și nu există o captură echivalentă evidentă
  (aceeași funcție, altă limbă) → raportează slide-urile și oprește postarea aceea; celelalte
  postări continuă.
- `validate-post.mjs` refuză după două încercări de corectare → oprește postarea, raportează
  erorile literal.
