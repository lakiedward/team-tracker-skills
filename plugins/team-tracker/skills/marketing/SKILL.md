---
name: marketing
description: Use when the user wants to work on Instagram content for a Team Tracker project in the current session — invokes "/marketing", "/marketing plan", "/marketing generate", "/marketing regen", "/marketing status", or says "facem postări pentru alkistudio", "marketing alkistudio", "hai la postările de Instagram", "ce campanii avem", "regenerează postarea", "vezi ce am cerut la needs changes", "ce postăm săptămâna asta", "plan de postări", "Instagram posts for the studio". Runs after /proiect (or resolves the project from the cwd) — builds the brand context from the project's own repo (tokens, fonts, portfolio, copy, asset inventory), reads campaign and post state from tt_marketing_* in Supabase, prints an opening report, then dispatches /marketing-plan (research + plan rows with a per-slide brief) or /marketing-generate (copy + slides rendered as images) and runs the needs-changes loop. It never approves, publishes or touches the human-gate columns; those buttons live only in Team Tracker → Marketing.
---

# marketing — orchestratorul de conținut Instagram al unui proiect

Aplică [execuția locală și verificarea în browser](../references/local-execution.md).

Team Tracker are un tab **Marketing** în care campania e containerul: postările-carusel
apar sub ea din faza de brief, se umplu live cât timp sesiunea generează, iar omul apasă
singurele butoane care sunt ale lui (Approve, Needs changes, Marchează publicat, Respinge).
Pagina nu generează nimic. **Tot conținutul vine din sesiunea asta**: research-ul, planul,
textele și slide-urile ca imagini. Skill-ul de față e partenerul de chat și dispecerul; cele
două skill-uri surori fac munca: [`/marketing-plan`](../marketing-plan/SKILL.md) scrie
campania și brief-ul, [`/marketing-generate`](../marketing-generate/SKILL.md) scrie textele
și randează slide-urile.

Spec-ul complet, cu modelul de date și deciziile luate cu omul:
`team-tracker/docs/superpowers/specs/2026-09-08-marketing-per-proiect-design.md`.

## Argumente

| Comandă | Ce face |
|---|---|
| `/marketing` | înrădăcinare + raport de deschidere + „Ce construim?" |
| `/marketing status` | doar raportul, fără întrebare |
| `/marketing plan` | sare direct la `/marketing-plan` |
| `/marketing generate [all \| <post_id>…]` | sare direct la `/marketing-generate` pe postările `planned` (sau cele numite) |
| `/marketing regen [<post_id>…]` | bucla de „needs changes": regenerează postările cu nota omului |

## Constants

| Ce | Valoare |
|---|---|
| Supabase project ref | `ntjzghsbrzkvpkniotaj` |
| Tool SQL | `mcp__supabase-mcp-server__execute_sql` (numele poate diferi per client; caută `execute_sql`) |
| Tabele | `tt_marketing_campaigns`, `tt_marketing_posts`, `tt_marketing_slides` (toate cu `project_id`) |
| Bucket | `marketing-assets` (privat; rândurile țin doar căi, niciodată URL-uri semnate) |
| Registrul de proiecte | `../orchestrate/projects.json` (cheia `alkistudio` → `project_id: 11`) |
| Coloane de poartă umană pe `tt_marketing_posts` | `approved_at`, `feedback`, `published_at`, `published_url` + statusurile `needs_changes` / `approved` / `published` / `rejected` |
| Statusuri pe care le poate scrie agentul | `planned` → `generating` → `generated`; `needs_changes` → `generating` |
| Limite Instagram (verificate 2026-09-08) | max **10** slide-uri per carusel prin API, max **5** hashtag-uri, caption ≤ 2200 caractere |
| Limba postărilor | engleză (decizia omului); limba chatului: română |

## Faza 0 — Înrădăcinare

1. Dacă sesiunea a trecut prin `/proiect`, folosește proiectul de acolo. Altfel rezolvă-l ca
   `/pontaj`: normalizează cwd-ul și fiecare `repo_path` din registru la slash-uri, fără
   majuscule; cwd egal cu sau în interiorul unui `repo_path` câștigă (cel mai lung).
   Nu duplica registrul aici. Proiect nerezolvat → întreabă o singură dată.
2. **Contextul de brand se citește din repo, nu dintr-o copie.** Pentru alkistudio
   (`WebsitePresentation`):
   - `src/styles/tokens.css` → culorile (`--bg`, `--ink`, `--ink-dim`, `--accent`);
   - `index.html` → familiile de fonturi din link-ul Google Fonts;
   - `src/data/projects.js` → array-ul `PROJECTS` (id, name, kind, client, url, year, `delivered`);
   - `src/i18n/en.json` → `intro.*` (poziționarea), `projects.<id>.*` (descrieri, capitolele
     de tur), `detail.aiCore.*` (intrări/ieșiri AI), `detail.cta.*` (textul de CTA);
   - `public/<proiect>/` → inventarul de capturi, cu
     `node ../marketing-generate/scripts/asset-inventory.mjs --assets <repo>/public`.
   Ține contextul în conversație. Nu-l scrie în repo-ul proiectului și nu-l scrie în
   directorul skill-ului (cache-ul plugin-ului se regenerează).
3. Notează ce lipsește din site și ar strica o postare: formular de contact care nu trimite,
   email placeholder, pagină About cu text de umplutură. Se spun omului la raport, nu se
   repară aici.

## Faza 1 — Starea din bază

Cu `project_id`:

```sql
select c.id, c.title, c.category, c.status, c.posts_per_week, c.target_slides,
       c.research_notes->>'searched_at' as searched_at, c.research_notes->>'valid_until' as valid_until,
       count(p.id) as posts,
       count(*) filter (where p.status = 'planned') as planned,
       count(*) filter (where p.status = 'generating') as generating,
       count(*) filter (where p.status = 'generated') as generated,
       count(*) filter (where p.status = 'needs_changes') as needs_changes,
       count(*) filter (where p.status = 'approved') as approved,
       count(*) filter (where p.status = 'published') as published
from tt_marketing_campaigns c
left join tt_marketing_posts p on p.campaign_id = c.id
where c.project_id = <project_id>
group by c.id order by c.created_at desc;

select id, campaign_id, title, portfolio_project, planned_at, status, version, target_slides, feedback
from tt_marketing_posts where project_id = <project_id> order by planned_at nulls last, order_index;
```

## Faza 2 — Raportul de deschidere

Tipărește exact blocul ăsta, în română, apoi întreabă „Ce construim?" (la `status` nu întreba):

```
Marketing · <nume proiect> (project_id <id>)

Campanii: <n> (<active> active) · Postări: <n>
  <planned> planificate · <generating> se generează · <generated> așteaptă verificarea omului
  <needs_changes> cu modificări cerute · <approved> aprobate · <published> publicate

Material per proiect din portofoliu:
  <proiect>   <n> capitole tur · <n> capturi (<phone> phone, <desktop> desktop) · <AI core / video / -> → <verdict>
  ...
  verdict: „carusel complet" (≥ 4 capitole și ≥ 4 capturi), „max 6 slide-uri" (3–8 capturi sau fără desktop),
           „nu susține carusel" (< 4 capturi distincte)

Brand: <bg> fundal · <accent> accent · <fonturi>
Limba postărilor: engleză

De reparat pe site înainte de prima postare: <lista sau „nimic">
Așteaptă în chat: <postările needs_changes cu nota omului, câte una pe rând>
```

## Faza 3 — Dispatch

| Omul vrea | Skill-ul face |
|---|---|
| un plan / o campanie nouă / „5 postări, una pe proiect" | verifică numărul real de proiecte și materialul lor, corectează cifra dacă e greșită (site-ul are 4 proiecte, nu 5; Amos nu ține un carusel) și **apoi** cheamă `/marketing-plan` |
| „generează" / „fă postările" | cheamă `/marketing-generate` pe postările `planned` ale campaniei (sau pe cele numite) |
| „vezi ce am cerut" / e ceva în `needs_changes` | bucla de mai jos |
| „aprobă" / „publică" / „șterge postarea aprobată" | **nu**: explică în două rânduri că butoanele sunt în Team Tracker → Marketing și că baza respinge scrierea din sesiune |

Întrebările pentru om se pun **grupat**, într-un singur `AskUserQuestion`, o singură dată per
comandă, exact ca la `/orchestrate`. Doar design, scop și ordine ajung la om; „ce fișier
are captura", „de ce a picat randarea", „cum găsesc Chromium" sunt ale skill-ului.

## Bucla „needs changes"

Pentru fiecare postare cu `status = 'needs_changes'`:

1. Citește `feedback`. Dacă nota numește slide-uri („slide 4", „al doilea slide", „coperta",
   „CTA-ul"), regenerarea e **țintită**: doar slide-urile numite își schimbă textul; restul
   se re-randează neschimbat la versiunea nouă (versiunea e a postării, nu a slide-ului).
   Dacă nota e generală („prea tehnic", „mai scurt"), se rescrie tot postul.
2. Spune omului în chat, într-o propoziție, cum ai citit nota. Nu întreba; el a scris deja.
3. Pornește regenerarea: `update tt_marketing_posts set status = 'generating', version = version + 1,
   updated_at = now() where id = <id> and status = 'needs_changes'` (tranziție permisă de
   trigger). **Nu atinge `feedback`**: rămâne pe rând până la următoarea decizie a omului.
4. Cheamă `/marketing-generate` pe postarea aceea, cu lista de slide-uri țintite.
5. La final raportează: „<titlu> e din nou la verificare (v<n>): am schimbat slide-urile
   <lista> după nota ta." Postarea reapare în card ca `generated`, sub nota lui.

## Reguli dure

- **Porțile umane sunt ale omului și sunt blocate în DB.** `approved_at`, `feedback`,
  `published_at`, `published_url` și statusurile `needs_changes` / `approved` / `published` /
  `rejected` se scriu doar din Team Tracker, de către om. Trigger-ul
  `tt_guard_marketing_post_human_gates` respinge scrierea din sesiune (și TRUNCATE-ul). Un
  refuz aici e poarta funcționând, nu un bug: cere-i omului butonul.
- **Niciun DDL** pe tabelele `tt_` fără cuvintele omului.
- **Nimic nu se publică pe Instagram** din sesiune (v1 e manual: omul descarcă și postează).
- **Cifrele de mockup nu sunt rezultate.** Site-ul afișează valori de produs (85%, +27%
  edge, 1k+). Într-un slide apar doar etichetate „sample output"; niciodată ca performanță
  a clientului. `validate-post.mjs` refuză altfel.
- Max 10 slide-uri, max 5 hashtag-uri, caption ≤ 2200. Limbă: engleză.
- **Nu tipări niciodată `SUPABASE_SERVICE_ROLE_KEY`** și nu-l pune într-un rând din bază.
- Nu re-întreba proiectul după `/proiect`; nu re-face înrădăcinarea la fiecare comandă.

## Raport la închidere

```
Marketing · <proiect> · <ce s-a făcut: plan / generare / regenerare>
  campanie: <titlu> (#<id>) · <n> postări · <cadență>/săpt
  scrise: <n> planificate · generate: <n> (v<n>) · regenerate: <n>
  așteaptă verificarea ta în Team Tracker → Marketing: <titluri>
  de reparat pe site: <lista sau nimic>
```

Apoi propune `/pontaj` dacă omul nu l-a cerut.

## Greșeli de evitat

- Să propui 5 postări când site-ul are 4 proiecte. Numără din `projects.js`, nu din chat.
- Să scrii `approved_at` „doar ca să testezi". Nu merge și nici nu trebuie să meargă.
- Să ștergi `feedback` la regenerare. Nota rămâne până decide omul.
- Să copiezi contextul de brand într-un fișier din directorul skill-ului: dispare la update.
- Să lași o postare pe `generating` după un eșec de randare. La eșec: `status = 'planned'`
  dacă nu exista nicio versiune, altfel rămâne pe versiunea veche cu `status = 'generated'`,
  și spui omului ce a picat.

## When to self-abort

- Proiectul nu se rezolvă din registru → întreabă o dată, apoi oprește-te.
- Repo-ul proiectului nu are `src/data/projects.js` sau `src/i18n/en.json` (nu e un site cu
  portofoliu în forma așteptată) → raportează ce lipsește; nu inventa un portofoliu.
- `SUPABASE_SERVICE_ROLE_KEY` lipsește și omul cere generare → planul merge, generarea nu;
  spune exact asta.
