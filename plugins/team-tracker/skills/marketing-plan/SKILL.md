---
name: marketing-plan
description: Use when the session needs a new Instagram campaign plan for a Team Tracker project — invoked by /marketing (or directly as "/marketing-plan", "fă planul de postări", "planifică o campanie", "ce postăm și când", "plan campaign", "research Instagram patterns"). Researches current Instagram carousel patterns on the web (cached for 60 days in the campaign's research_notes), asks its clarifying questions once in a single batch, checks the real material available per portfolio project, then writes one tt_marketing_campaigns row and one tt_marketing_posts row per post with status planned, a date, and a complete per-slide brief. Writes no images and never touches the human-gate columns.
---

# marketing-plan — research + planul unei campanii, ca rânduri în bază

Aplică [execuția locală și verificarea în browser](../references/local-execution.md).

Planul e prima formă a unei postări: un rând `planned` cu un brief per slide, vizibil în
Team Tracker sub campania lui, **înainte** să existe vreo imagine. Skill-ul ăsta scrie doar
planul. Textele finale și slide-urile le face `/marketing-generate`. Contextul de brand și
starea din bază vin de la [`/marketing`](../marketing/SKILL.md), care e cel ce apelează
skill-ul ăsta; rulat direct, fă întâi Faza 0 de acolo.

## Constants

| Ce | Valoare |
|---|---|
| Supabase project ref | `ntjzghsbrzkvpkniotaj` |
| Tabele scrise | `tt_marketing_campaigns`, `tt_marketing_posts` |
| `created_by` | `Claude Code` |
| Categorii (`category`) | `case_study`, `behind_the_build`, `how_we_work`, `whats_next` |
| Default-uri (parametri per campanie, nu reguli) | 2 postări/săpt, 8 slide-uri țintă, engleză |
| Valabilitatea research-ului | 60 de zile (`research_notes.valid_until`) |
| Limite | 3–10 slide-uri (API-ul de publicare acceptă 10), ≤ 5 hashtag-uri |

Schema relevantă:

```sql
tt_marketing_campaigns (id, project_id, title, category, rationale, research_notes jsonb,
                        posts_per_week, target_slides, language, status draft|active|done, created_by)
tt_marketing_posts     (id, project_id, campaign_id, order_index, title, portfolio_project,
                        planned_at date, target_slides, brief jsonb, caption, hashtags text[],
                        version, status, feedback, approved_at, published_at, ...)
```

`brief` e o listă ordonată: `[{ "n", "layout", "kicker", "headline", "body", "asset",
"inputs", "outputs", "stat", "disclaimer", "cta", "meta" }]`. Layout-urile sunt cele din
`../marketing-generate/templates/README.md`: `cover`, `statement`, `screenshot_phone`,
`screenshot_desktop`, `split`, `diagram`, `stat`, `cta`. `asset` e calea reală din
`public/` a site-ului (ex. `betora/betora-1.webp` pentru telefon, `betora/desktop-1.webp` pentru
desktop; `culcush/culcush-N.webp` + `culcush/tour-N.webp`; `phones/padel-N.webp`), verificată pe disc.

## Pas 1 — Research (o dată per campanie, refolosit 60 de zile)

Dacă există o campanie a proiectului cu `research_notes.valid_until >= azi`, refolosește-i
notele și sari peste căutare; spune-i omului că le-ai refolosit și de când sunt.

Altfel caută pe web (WebSearch), 4–6 interogări, anul curent în interogare:

- pattern-uri de carusel Instagram pentru studiouri de software / agenții (hook pe primul
  slide, densitate de text, număr de slide-uri care ține atenția, CTA pe ultimul slide);
- semnalele de ranking curente (watch time, likes per reach, **sends per reach**);
- limitele curente: slide-uri per carusel, hashtag-uri, format 4:5;
- ce funcționează la studiile de caz B2B (problemă → soluție → dovadă → invitație).

Scrie în `research_notes`:

```json
{ "searched_at": "YYYY-MM-DD", "valid_until": "YYYY-MM-DD",
  "sources": [ { "title": "...", "url": "...", "note": "ce am luat de aici" } ],
  "patterns": [ "hook-ul e o afirmație, nu un titlu", "max 12 cuvinte pe slide", "..." ],
  "limits": { "max_slides": 10, "max_hashtags": 5, "ratio": "4:5" } }
```

Nu inventa surse. Dacă o căutare nu întoarce nimic util, spune asta în `patterns` ca
„neverificat" și mergi pe limitele cunoscute din tabelul de constante.

## Pas 2 — Întrebările, o singură dată

Un singur `AskUserQuestion` cu toate întrebările deschise, fiecare cu opțiuni și
recomandare pe prima poziție. Tipic:

| Întrebare | Opțiuni (recomandarea prima) |
|---|---|
| Categoria campaniei | studiu de caz + „behind the build" intercalate / doar studii de caz / altă categorie |
| Cadență | 2/săpt (marți, joi) / 3/săpt (luni, miercuri, vineri) / 1/săpt |
| Unghiul studiilor de caz | problema clientului, nu stack-ul / stack-ul, pentru un public tehnic |
| Cifrele de mockup din site | le etichetez „sample output" / le scot complet |
| Ordinea | proiectul live primul (Betora) / alfabetic / cum spune omul |
| Slide-ul de CTA | „Got a project idea? Let's talk." + link-ul proiectului / doar link-ul studioului |

Ce omul a decis deja în sesiune sau în spec nu se re-întreabă. Răspunsurile intră în
`rationale` (ca text, în cuvintele lui) și în brief.

## Pas 3 — Verificarea materialului

Înainte de plan, pentru fiecare proiect din `projects.js`:

- capitole de tur: numărul de intrări `projects.<id>.tour.*` (sau echivalentul) din `en.json`;
- capturi: din `asset-inventory.mjs` (phone / desktop / video, `carousel_ready`);
- blocuri extra: AI core (`detail.aiCore.<id>`), video, desktop.

Regula de dimensionare:

| Material | `target_slides` |
|---|---|
| ≥ 4 capitole și ≥ 4 capturi distincte | 8 |
| 3–8 capturi sau fără desktop | 6 |
| < 4 capturi distincte | **exclus** din campanie; se spune omului cu numărul exact |

Tipărește tabelul înainte să scrii ceva. Dacă omul a cerut „câte o postare per proiect" și un
proiect e exclus, spune-i și oferă înlocuirea (o a doua categorie pe proiectele rămase).

## Pas 4 — Structura brief-ului

**Studiu de caz (8 slide-uri):**

| n | layout | conținut |
|---|---|---|
| 1 | `cover` | hook: o afirmație despre ce face produsul, cu un cuvânt `*accentuat*`; `kicker` = „CASE STUDY · <PROIECT>"; `meta` = url + an |
| 2 | `statement` | clientul și problema, în cuvintele lui, fără jargon |
| 3–6 | `screenshot_phone` / `screenshot_desktop` | o funcție per slide, o captură reală per slide (capitolele de tur); headline = numele funcției, body = o propoziție |
| 7 | `diagram` sau `stat` | unghiul AI / tehnic: intrări → ieșiri din `aiCore`; orice cifră cu `disclaimer` = „sample output, not client results" |
| 8 | `cta` | „Got a project idea? Let's talk." + `cta` = link-ul; `meta` = studioul |

**Behind the build (5–6 slide-uri):** `cover` (decizia, ca afirmație) → `statement`
(problema de inginerie, pentru client) → 2–3 × `screenshot_*` / `split` (ce a ieșit) →
`cta`. Sursa: `docs/superpowers/` din repo-ul proiectului respectiv, nu doar site-ul.

Padel (fără desktop): 6 slide-uri, fără `screenshot_desktop`. Amos: exclus până are material.

## Pas 5 — Scrierea rândurilor

Datele: `planned_at` începe din prima zi de postare a săptămânii următoare și avansează după
cadență (2/săpt → marți și joi; 3/săpt → luni, miercuri, vineri; 1/săpt → marți). Ordinea
postărilor e ordinea decisă de om. Categoriile intercalate alternează: caz, build, caz, build.

Un singur CTE, ca la `writing-tester-test-plans`:

```sql
with c as (
  insert into tt_marketing_campaigns (project_id, title, category, rationale, research_notes,
                                      posts_per_week, target_slides, language, status, created_by)
  values (<project_id>, 'Case studies · sept 2026', 'case_study', '<rationale>', '<json>'::jsonb,
          2, 8, 'en', 'active', 'Claude Code')
  returning id
)
insert into tt_marketing_posts (project_id, campaign_id, order_index, title, portfolio_project,
                                planned_at, target_slides, brief, hashtags, status, created_by)
select <project_id>, c.id, t.idx, t.title, t.slug, t.day::date, t.slides, t.brief::jsonb,
       t.tags::text[], 'planned', 'Claude Code'
from c cross join (values
  (0, 'Betora · case study', 'betora', '2026-09-15', 8, '[...]', '{alkistudio,betora,productdesign,ai}'),
  (1, 'Culcush · case study', 'culcush', '2026-09-17', 8, '[...]', '{alkistudio,culcush,ecommerce,webgl}')
) as t(idx, title, slug, day, slides, brief, tags);
```

`status` intră **doar** `planned`; `feedback`, `approved_at`, `published_*` rămân NULL.
Trigger-ul respinge altfel. Un plan pentru un proiect care are deja o campanie `active`
pe aceeași categorie: întreabă în batch-ul de la Pas 2 dacă o continuă sau deschide alta.

## Pas 6 — Verificare și raport

1. `select count(*) from tt_marketing_posts where campaign_id = <id>` = numărul planificat.
2. Fiecare `brief` are exact `target_slides` intrări, `n` de la 1 la N, layout-uri valide,
   fiecare `asset` există pe disc (rulează `validate-post.mjs` pe un `post.json` construit
   din brief; fără caption încă, deci ignoră eroarea de caption).
3. Raport:

```
Plan scris · <titlu campanie> (#<id>) · <categorie> · <n>/săpt · <slide-uri> slide-uri
  <data>  <titlu postare>  <proiect>  <n> slide-uri
  ...
  excluse: <proiect: motiv cu numere> sau nimic
  research: <nou, N surse> / <refolosit din YYYY-MM-DD>
Vezi în Team Tracker → Marketing → Campanii. Când vrei imaginile: /marketing generate.
```

## Greșeli de evitat

- Să scrii `brief` fără `asset` la slide-urile de captură: `/marketing-generate` nu ghicește
  fișiere.
- Să folosești capturi RO pentru postări în engleză: fișierul fără sufix e engleza, `-ro.webp` e româna.
- Să pui cifrele din `aiCore` / `pulse` ca rezultate. Sunt valori de mockup.
- Să inserezi postări fără `project_id`. Nu apar în app.
- Să re-cauți pe web la fiecare campanie deși notele sunt valabile.

## When to self-abort

- Niciun proiect din portofoliu nu e `carousel_ready` → spune-i omului ce lipsește; nu scrie
  o campanie goală.
- Omul cere o categorie fără sursă în repo (ex. „how we work" fără text despre proces) →
  întreabă o singură dată de unde vin faptele; nu inventa.
