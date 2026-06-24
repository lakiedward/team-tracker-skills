---
name: orchestrate
description: Use when the user wants to run an automated sweep of the entire Focus board for a project — resolves the project, reads all open bugs, features, and test plans, and (in dry-run mode) prints a full work list with the worker skill that would be dispatched for each item, without writing anything. Triggers on "/orchestrate", "dă-i la tot <proiect>", "apucă-te de tot de pe Focus", "orchestrate betro", "rulează dispecerul pe <proiect>", "sweep tot board-ul", "procesează tot board-ul".
---

# Dispecerul (Orchestrator de Focus board)

Citește board-ul Focus al oricărui proiect din `projects.json`, construiește lista de muncă, și (în modul
complet) lansează o flotă de muncitori paraleli în worktree-uri izolate. În **`--dry-run`**, se oprește după
ce printează lista — zero scrieri, zero worktree-uri, zero lansări de muncitori.

Skill-ul funcționează pentru **orice proiect înregistrat în `projects.json`** — BetRO, team-tracker,
Pagina-Prezentare-Betora, Padel-Team, gradinita-amos, motiontimisoara, culcush, popicu_tips și oricare altul
adăugat ulterior. BetRO (`betro`) este proiectul folosit ca exemplu în snippet-urile de mai jos; înlocuiește
slug-ul cu cel al proiectului tău. Proiectele fără repo local pe disc (ex. `telegram_tips`, `website`) nu sunt
în registru și nu pot fi orchestrate local — comanda va aborta cu un mesaj clar.

**Arhitectura:** Acest skill este **Conductorul** — rulează în firul principal, pune întrebările userului,
lansează Workflow-uri per rundă, face merge la worktree-uri verificate, și raportează. Workflow-urile
(Milestone C) sunt headless și mute; interacțiunea cu userul stă DOAR în firul principal.

## Argumente

| Argument | Descriere | Default |
|---|---|---|
| `<proiect>` | Slug-ul din `projects.json` (ex. `betro`) | **obligatoriu** |
| `--dry-run` | Citește board-ul și printează lista de muncă; nu lansează nimic, nu scrie nimic | absent |
| `--max-rounds N` | Numărul maxim de runde de lucru | `6` |
| `--only <kind>:<id>` | Procesează un singur item (`bug:42` sau `feature:17`); sare dry-run-ul și execută end-to-end | absent |

Exemplu: `/orchestrate betro --dry-run` · `/orchestrate betro` · `/orchestrate betro --max-rounds 3` · `/orchestrate betro --only bug:42` · `/orchestrate betro --only feature:17`

## Constante

Valorile per-proiect (`project_id`, `repo_path`, `git`, `preview_name`, `preview_port`) vin din `projects.json`.
Cele globale sunt fixe:

| Nume | Valoare |
|---|---|
| Registry proiecte | `C:/Users/lakie/Desktop/team-tracker-skills/plugins/team-tracker/skills/orchestrate/projects.json` |
| Board queries | `C:/Users/lakie/Desktop/team-tracker-skills/plugins/team-tracker/skills/orchestrate/reference/board-queries.md` |
| Supabase ref | `ntjzghsbrzkvpkniotaj` |
| `SKIP_TAG` | `[manual]` (case-insensitive) |
| `SOFT_CAP` | `min(6, min(16, cores-2))` |
| Worktrees root | `C:/Users/lakie/Desktop/.orch-worktrees` |

Nu întreba userul despre aceste valori. Dacă Supabase MCP nu e conectat sau `projects.json` lipsește, abort
cu o singură linie.

---

## Faza 0 — Resolve project

Citește `projects.json` (calea din Constante de mai sus). Caută slug-ul `<proiect>` ca cheie top-level.

```js
// pseudocod — execută ca Read pe fișier, nu ca script Node
const registry = JSON.parse(readFile('...projects.json'))
const entry = registry[slug]   // ex. registry['betro']
```

**Dacă slug-ul nu există în registry** → abort imediat:
> "Proiectul '<slug>' nu e în registru (projects.json). Proiecte fără repo local (ex. telegram_tips, website) nu pot fi orchestrate local."
> Adaugă: "Slug-uri disponibile: <lista cheilor din projects.json>."

Dacă slug-ul există, extrage câmpurile de mai jos. Toate vin din intrarea din `projects.json`:

| Câmp | Tip | Descriere |
|---|---|---|
| `project_id` | număr întreg | folosit în toate query-urile `tt_*` |
| `repo_path` | string | calea absolută a repo-ului sursă |
| `git` | boolean | `true` dacă root-ul are git; `false` dacă nu |
| `preview_name` | string \| null | numele serverului de preview (ex. `vite-dev`); `null` = preview indisponibil |
| `preview_port` | număr \| null | portul preview-ului; `null` dacă `preview_name` e null |

**Handling `git = false`:**
Git worktrees sunt indisponibile pentru acest proiect. Modul `--only` (Milestone B) funcționează în continuare
— muncitorul rulează direct în `repo_path`, fără worktree izolat. Modul cu flotă (Milestone C) va rula
in-place / serializat pentru proiectele fără git (nu se implementează acum; documentat pentru planificare
ulterioară). Sari verificarea `git status` de mai jos și continuă direct la Faza 1.

**Handling `preview_name = null`:**
UI preview verification este indisponibilă pentru acest proiect. Muncitorul trebuie să verifice exclusiv
prin SQL impersonation, sau să lase itemele care necesită verificare UI `blocked` cu motivul
`"preview_name=null — verificare UI imposibilă; rezolvă manual sau configurează un server de preview"`.
Skill-urile de rezolvare tratează deja „canal de verificare indisponibil" ca motiv valid de parcare — referă-te
la secțiunea „verification channel unavailable" din skill-ul muncitor ales.

**Verifică `repo_path`** (numai dacă `git = true`):

```bash
git -C <repo_path> status --porcelain
```

Interpretează rezultatul **după codul de ieșire, nu doar după stdout**:

- **Comanda iese cu cod non-zero** (directorul lipsește sau calea nu este un repo git) → abort:
  "repo lipsă / nu e repo git: `<repo_path>`. Verifică că `repo_path` din projects.json este corect."
- **Comanda iese cu cod zero și stdout non-gol** (există modificări necommittuite) → abort:
  "Repo murdar: `<repo_path>` are modificări necommittuite. Commit sau stash întâi, apoi reîncearcă."
- **Comanda iese cu cod zero și stdout gol** → repo curat, continuă.

Distincția dintre „director lipsă" și „repo curat" se face exclusiv prin codul de ieșire al comenzii
— ambele returnează stdout gol, dar numai directorul lipsă/non-repo iese cu cod non-zero.

Reține `project_id`, `repo_path`, `git`, `preview_name`, `preview_port` pentru restul rulării.

---

## Faza 1 — Citește board-ul

**Pas 1 obligatoriu — ping Supabase MCP:** înainte de orice alt query, execută:

```sql
SELECT 1
```

prin `mcp__supabase-mcp-server__execute_sql` (project ref `ntjzghsbrzkvpkniotaj`). Dacă apelul
eșuează sau conexiunea este deconectată → abort imediat cu un singur rând:

> "Supabase MCP neconectat — reconectează și reia."

Acest ping este **obligatoriu** — nu îl sări și nu îl condiționa de dubii. Numai după ce ping-ul
reușește, continuă cu query-urile de mai jos.

Rulează toate trei query-urile din `reference/board-queries.md` în **paralel** prin
`mcp__supabase-mcp-server__execute_sql` (project ref `ntjzghsbrzkvpkniotaj`).
Înlocuiește `:pid` cu valoarea numerică a `project_id` (ex. `1`).

### 1a. Query BUGS

```sql
SELECT id, title, description, priority, status, effort, image_urls, created_at, updated_at
FROM tt_bugs
WHERE project_id = <project_id> AND status IN ('Open','In Progress') AND COALESCE(is_archived,false)=false
ORDER BY CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 ELSE 5 END, created_at;
```

### 1b. Query FEATURES

```sql
SELECT id, title, description, type, priority, status, effort, image_urls, created_at, updated_at
FROM tt_features
WHERE project_id = <project_id> AND status IN ('Propus','Planificat','În Focus') AND COALESCE(is_archived,false)=false
ORDER BY CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 ELSE 5 END, created_at;
```

### 1c. Query TEST PLANS

```sql
SELECT p.id, p.title, p.description, p.priority, p.test_type, p.is_archived,
       COUNT(i.*) FILTER (WHERE i.result='pending') AS pending,
       COUNT(i.*) FILTER (WHERE i.result='fail')    AS fail,
       COUNT(i.*) FILTER (WHERE i.result='blocked') AS blocked,
       COUNT(i.*) AS total
FROM tt_test_plans p LEFT JOIN tt_test_items i ON i.test_plan_id = p.id
WHERE p.project_id = <project_id> AND COALESCE(p.is_archived,false)=false
GROUP BY p.id;
```

### 1d. Construiește lista de muncă

**Excludere `SKIP_TAG`:** ignoră orice item al cărui `title` sau `description` conține `[manual]`
(case-insensitive). Loghează fiecare item sărit cu motivul `SKIP_TAG`.

**Mapare `worker_skill`:**

| Tip item | Condiție | `worker_skill` |
|---|---|---|
| Bug | `status IN ('Open','In Progress')` | `resolving-tt-bugs` |
| Feature | `status IN ('Propus','Planificat','În Focus')` | `resolving-tt-features` |
| Test plan | `fail + blocked > 0` | `resolving-failed-test-plans` |
| Test plan | `test_type='ai' AND pending > 0` | `auto-running-test-plans` |
| Test plan | altfel | ignoră (done sau netestat-uman) |

Un test plan poate apărea în **ambele** categorii (`fail+blocked > 0` ȘI `test_type='ai' AND pending > 0`).
În acest caz, prioritizează `resolving-failed-test-plans` (problema activă > rulare automată).

**Rezultat:** o listă ordonată `work_items`:

```
[
  { kind: 'bug',      id, title, priority, status, worker_skill: 'resolving-tt-bugs' },
  { kind: 'feature',  id, title, priority, status, worker_skill: 'resolving-tt-features' },
  { kind: 'testplan', id, title, priority, pending, fail, blocked, worker_skill: '...' },
  ...
]
```

Dacă `work_items` e gol → raportează: "Board gol: niciun item acționabil pentru proiectul `<slug>`
(project_id=<pid>). Nimic de făcut." și oprește.

---

## Mod `--dry-run`

Dacă flag-ul `--dry-run` este prezent, **execută doar Faza 0 și Faza 1**, apoi printează rezultatele
și **termină imediat** — fără să lansezi niciun Workflow, fără să scrii nimic în DB,
fără să creezi worktree-uri.

### Output dry-run

**1. Tabel cu lista de muncă:**

Coloana `Status` pentru rândurile de tip `testplan` este un șir sintetic (ex. `ai/3 pending`,
`2 fail`), nu statusul brut din DB; bug-urile și feature-urile afișează statusul lor raw.

```
Dispecer — dry-run — <slug> (project_id=<pid>) — <YYYY-MM-DD>

| # | Kind     | ID  | Prioritate | Status       | Titlu (truncat 70 ch)         | Worker skill                  |
|---|----------|-----|------------|--------------|-------------------------------|-------------------------------|
| 1 | bug      | 42  | High       | Open         | Butonul X nu funcționează ... | resolving-tt-bugs             |
| 2 | feature  | 17  | Medium     | Planificat   | Adaugă export CSV ...         | resolving-tt-features         |
| 3 | testplan | 5   | —          | ai/3 pending | Teste smoke login ...         | auto-running-test-plans       |
...

Total: <N> iteme acționabile  (<B> bug-uri · <F> features · <T> test plans)
Sărite (SKIP_TAG): <S> iteme
```

**2. Rezumat per item — ce s-ar rula:**

Pentru fiecare item din tabel, printează o linie de forma:

```
[bug #42]      resolving-tt-bugs        → „Investighează și rezolvă bug-ul #42: <titlu>. TARGET_PROJECT_ID=<pid> TARGET_ITEM_ID=42"
[feature #17]  resolving-tt-features    → „Implementează feature #17: <titlu>. TARGET_PROJECT_ID=<pid> TARGET_ITEM_ID=17"
[testplan #5]  auto-running-test-plans  → „Rulează planul de test AI #5: <titlu>. TARGET_PROJECT_ID=<pid> TARGET_ITEM_ID=5"
```

**3. Notă de confirmare:**

```
-- DRY-RUN: zero scrieri în DB · zero worktree-uri · zero muncitori lansați --
Pentru a rula efectiv: /orchestrate <slug>  (sau /orchestrate <slug> --max-rounds N)
```

**Dry-run-ul se termină aici.** Nu continua la Faza 2 sau mai departe.

---

## Modul `--only <kind>:<id>` — un singur item end-to-end (Milestone B)

Dacă flag-ul `--only <kind>:<id>` este prezent (ex. `--only bug:42` sau `--only feature:17`),
**nu rulezi dry-run-ul** și nu lansezi o flotă completă. Execuți exact un item, verifici rezultatul,
scrii testele, și scrii în DB. Flow-ul complet de mai jos.

### Pas B1 — Resolve & validare

Execută Faza 0 și Faza 1 normal (resolve din `projects.json`, ping Supabase, citire board).
Extrage `kind` și `id` din argumentul `--only`:
- `kind` ∈ `bug` | `feature`; orice altceva → abort: "`kind` invalid; acceptat: `bug` sau `feature`."
- `id` trebuie să fie un număr întreg pozitiv; altfel → abort.

Verifică că itemul există în lista de muncă construită în Faza 1. Dacă nu apare (statusul nu e acționabil
sau itemul are `SKIP_TAG`) → abort cu un singur rând explicativ.

### Pas B2 — Alege skill-ul muncitor

| `kind` | `worker_skill` |
|---|---|
| `bug` | `resolving-tt-bugs` |
| `feature` | `resolving-tt-features` |

### Pas B3 — Dispatch subagent muncitor (un singur Agent)

Lansează **un singur subagent** (`Agent` tool) cu promptul de mai jos. Muncitorul trebuie să fie
instruit să ruleze în **Orchestrator target mode** (secțiunea dedicată din SKILL.md-ul skill-ului
ales) și să întoarcă EXCLUSIV JSON-ul structurat ca ultimul mesaj.

Promptul subagentului:

```
Rulează skill-ul <worker_skill> în ORCHESTRATOR TARGET MODE pentru un singur item.

TARGET_PROJECT_ID=<project_id>
TARGET_SOURCE_ROOT=<repo_path>
TARGET_ITEM_ID=<id>

Item: [<kind> #<id>] <title>
Descriere (brief canonic — copiată verbatim din setul de rezultate al citirii board-ului din Faza 1; nu e necesară o nouă interogare DB pentru aceasta):
<description verbatim din rândul DB citit în Faza 1>

Instrucțiuni speciale:
- Sari peste Step 0 și Step 2 din flow-ul normal; folosește parametrii TARGET_* de mai sus.
- Procesează exclusiv rândul cu id=<id>.
- La final, întoarce DOAR JSON-ul structurat din contractul skill-ului (nu adăuga text în afara JSON-ului).
- Dacă acțiunea necesită o migrare DB / ștergere de date / push la remote / trimitere în afara sistemului
  → întoarce outcome="blocked" cu o întrebare clară despre acea acțiune ireversibilă (nu executa).
- Dacă kind='feature', adaugă în promptul muncitorului instrucția: 'Sari și peste Step 3c (decision gate) — Dispecerul a preautorizat procesarea acestui item.'
```

Notă: în Milestone B nu se creează worktree-uri — `TARGET_SOURCE_ROOT` este repo-ul direct (`repo_path`).
Câmpurile `worktree` și `branch` din JSON pot lipsi sau fi goale.

### Pas B4 — Citește rezultatul (JSON contract)

Muncitorul întoarce un JSON cu cheile:

```
item_id · outcome · verify_channel · test_recommendation · effort · summary · question
```

Parsează JSON-ul. Dacă muncitorul n-a returnat un JSON valid → tratează ca `outcome="blocked"` cu
`question="Muncitorul nu a returnat JSON valid; verifică manual."`.

### Pas B5 — Pasul de teste (înainte de write-back)

Dacă `outcome = 'blocked'`, sari direct la Pas B6 — nu lansa niciun subagent de testare.

Execută pasul de teste **înainte de a marca itemul gata** — diff-ul trebuie să fie vizibil pentru
skill-ul de scris teste, care operează pe același `TARGET_SOURCE_ROOT`.

Mapează `test_recommendation`:

| `test_recommendation` | Acțiune |
|---|---|
| `"ai"` | Dispatch un subagent care rulează `/writing-ai-test-plans` scopat pe item (`TARGET_ITEM_ID`, `TARGET_PROJECT_ID`, `TARGET_SOURCE_ROOT`). Instruiește-l să scrie un plan de test AI pentru modificările aduse de acest item. |
| `"human"` | Dispatch un subagent care rulează `/writing-tester-test-plans` cu același scoping. |
| `"both"` | Dispatch ambele subagente (unul pentru AI, unul pentru uman), în același mesaj (paralel). |
| `"none"` | Nu lansa niciun subagent de testare. |

Subagentul de testare primește: `TARGET_PROJECT_ID`, `TARGET_SOURCE_ROOT`, `TARGET_ITEM_ID`, titlul
și descrierea itemului, și instrucția că fix-ul este deja aplicat în `TARGET_SOURCE_ROOT`.
Așteaptă finalizarea subagentului/subagentelor de testare înainte de a continua la write-back.

### Pas B6 — Write-back sau Park

**Dacă `outcome = "fixed"` (bug) sau `outcome = "done"` (feature):**

Execută SQL-ul DONE corespunzător din `reference/board-queries.md`, interpolând:
- `:id` → `item_id`
- `:effort` → valoarea `effort` din JSON
- `:date` → data curentă `YYYY-MM-DD`
- `:summary` → valoarea `summary` din JSON

Pentru bug:
```sql
UPDATE tt_bugs SET status='Fixed', effort=:effort,
  description = description || E'\n\n--- Rezolvat :date (Dispecer) ---\n:summary', updated_at=NOW()
WHERE id=:id;
```

Pentru feature (trigger-ul `trg_sync_focus_on_feature_done` mută automat cardul pe `deployed`):
```sql
UPDATE tt_features SET status='Gata', effort=:effort,
  description = description || E'\n\n--- Rezolvat :date (Dispecer) ---\n:summary', updated_at=NOW()
WHERE id=:id;
```

**Dacă `outcome = "blocked"`:**

Pasul de teste NU se execută pentru un item blocat (nimic nu s-a implementat).

Execută SQL-ul PARK din `reference/board-queries.md`:

1. Append notă pe rândul sursă (`tt_bugs` sau `tt_features`, după `kind`):

   Substituie `:table` cu `tt_bugs` dacă `kind='bug'`, sau `tt_features` dacă `kind='feature'`.
   ```sql
   UPDATE tt_bugs SET description = description || E'\n\n--- Parcat :date (Dispecer) ---\n:reason', updated_at=NOW() WHERE id=:id;
   -- sau, dacă kind='feature':
   UPDATE tt_features SET description = description || E'\n\n--- Parcat :date (Dispecer) ---\n:reason', updated_at=NOW() WHERE id=:id;
   ```
   Unde `:reason` = valoarea `question` din JSON.

2. Asigură rândul focus și marchează blocat (`ensureFocusRow`):
   - Citește `focus_task_id` de pe rândul sursă (via SELECT pe `tt_bugs` sau `tt_features`, după `kind`).
   - Dacă `focus_task_id` este prezent (non-NULL):
     ```sql
     UPDATE tt_focus_tasks SET is_blocked=true, blocked_reason=:reason, updated_at=NOW() WHERE id=<focus_task_id>;
     ```
   - Dacă `focus_task_id IS NULL` → INSERT în `tt_focus_tasks`:
     - `title` = titlul itemului
     - `description` = descrierea itemului
     - `project_id` = `<project_id>`
     - `status` = statusul sursei mapat la coloana focus:
       - bug `Open` → `'todo'`; bug `In Progress` → `'in_progress'`
       - feature `Propus`/`Planificat` → `'todo'`; feature `În Focus` → `'in_progress'`
     - `priority` = număr: `Critical→1`, `High→2`, `Medium→3` (default), `Low→4`
     - `is_blocked` = `true`
     - `blocked_reason` = `:reason`
     - `source_type` = `'bug'` dacă `kind='bug'`, altfel `'feature'`
     - `source_id` = `CAST(:id AS text)`
     - `order_index` = `0`
     - `created_at` = `NOW()`
     - `updated_at` = `NOW()`

     Folosește numai valori valide pentru `tt_focus_tasks.status`: `todo | in_progress | testing | done`. NU folosi `'focus'` sau `'blocked'` — starea blocată se exprimă exclusiv prin `is_blocked=true` + `blocked_reason`.

     Apoi leagă rândul sursă:
     Substituie `:table` cu `tt_bugs` dacă `kind='bug'`, sau `tt_features` dacă `kind='feature'`.
     ```sql
     UPDATE tt_bugs SET focus_task_id=<noul id>, updated_at=NOW() WHERE id=:id;
     -- sau, dacă kind='feature':
     UPDATE tt_features SET focus_task_id=<noul id>, updated_at=NOW() WHERE id=:id;
     ```

### Pas B7 — Raport final (mod `--only`)

Printează un raport concis:

```
Dispecer — --only <kind>:<id> — <slug> — <YYYY-MM-DD>

[<kind> #<id>] <titlu>
  Status:  <Fixed | Gata | Blocat>  ('Blocat' e eticheta de afișare; în DB statusul sursei rămâne neschimbat — 'Open'/'Propus' etc.)
  Outcome: <fixed | done | blocked>
  Efort:   <effort>
  Canal:   <verify_channel>
  Teste:   <test_recommendation> → <ce s-a lansat>
  Rezumat: <summary>
  <dacă blocked> Întrebare pentru user: <question>
```

---

## Fazele 2–3 — O rundă completă (flotă, Milestone C)

Dacă invocarea **nu** are `--dry-run` și **nu** are `--only`, rulezi modul cu flotă: o rundă în care mai
mulți muncitori lucrează în paralel, fiecare în worktree-ul lui, verificarea-pe-preview e serializată
printr-un lease unic, iar tu (firul principal) faci merge secvențial la verzi și parchezi conflictele.

> **Scope Milestone C: o singură rundă.** Bucla-până-se-golește (re-citește board-ul și repetă), pâlnia
> de întrebări up-front și secțiunea de guvernare extinsă vin în Milestone D. În C: citește board-ul o
> dată (Faza 1), rulează o rundă, raportează. Vezi nota de la sfârșitul acestei secțiuni.

### Pas C0 — Generează `run_id` (în firul principal)

Workflow-ul rulează în sandbox unde `Date.now()` / `Math.random()` / `new Date()` fără argumente **aruncă**
— deci NU poate fabrica un id. **Tu** generezi `run_id` o singură dată, dintr-un timestamp Unix, și-l pasezi
în `args` la lansarea Workflow-ului și (implicit, prin args) în prompturile muncitorilor:

```bash
date +%s
```

Reține rezultatul ca `run_id` (string, ex. `"1750762800"`). Worktree-urile rundei vor sta sub
`C:/Users/lakie/Desktop/.orch-worktrees/<run_id>/`.

### Pas C1 — Grupare anti-conflict (înainte de fan-out)

Două branch-uri care ating **același fișier** intră în conflict la merge. Ca să eviți asta:

1. Pentru fiecare item din `work_items`, estimează **zona de cod** probabilă din `title` + `description`
   (ex. „pagina de login" → zona auth/login; „export CSV pe raport" → zona reports/export; „culoare buton"
   → zona UI/componenta respectivă). Folosește judecată — nu există o hartă exactă; grupează după
   substantivele de feature/ecran/fișier menționate.
2. **Itemele din aceeași zonă nu intră în aceeași rundă.** Dintr-un grup cu aceeași zonă, ia **un singur**
   item în runda curentă; pe celelalte **amână-le** (în Milestone C, fără buclă, „amânat" = raportat ca
   „amânat — coliziune de zonă cu #X; rulează din nou ca să-l prinzi"). În Milestone D, amânatele intră
   automat în runda următoare.
3. Itemele din **zone diferite** rulează în paralel (asta e câștigul flotei).
4. **Plafonează la `SOFT_CAP`**: dacă rămân mai multe iteme independente decât `SOFT_CAP`, ia primele
   `SOFT_CAP` (ordonate după prioritate din Faza 1) în runda curentă; restul → amânate.

Rezultatul = `round_items` (lista plafonată, fără coliziuni interne) + `deferred` (amânatele).

### Pas C2 — Per-proiect: `git=false` și `preview_name=null`

- **`git = false`** (ex. `popicu_tips`): worktree-urile sunt indisponibile. Itemele rulează **in-place în
  `repo_path`, SERIALIZAT** — nu poți edita în paralel același working tree. În acest caz **nu** lansa
  Workflow-ul cu fan-out paralel; în schimb procesează `round_items` **unul câte unul** (ca în modul
  `--only`, dar iterativ), fiecare cu `TARGET_SOURCE_ROOT = repo_path`. **Fără merge** (nu există branch
  `orch/*` de merge-uit) — schimbarea e deja în repo. Sari Pasul C5 (merge) pentru aceste iteme.
- **`preview_name = null`**: în `args` pasează `preview_name=null`, `preview_port=null`. Workflow-ul va
  forța verificarea pe SQL și va parca itemele care cer obligatoriu UI. Nu există stage de preview.

### Pas C3 — Lansează Workflow-ul rundei

Pentru proiecte cu `git=true`, lansează `round.workflow.js` (tool-ul `Workflow`) cu:

```js
args = {
  project_id:   <project_id>,
  slug:         "<slug>",                 // basename worktree (ex. "betro")
  repo_path:    "<repo_path>",
  git:          <true|false>,
  preview_name: <"vite-dev" | null>,
  preview_port: <3000 | null>,
  run_id:       "<run_id>",               // generat la Pas C0 — NU lăsa Workflow-ul să-l facă
  soft_cap:     <SOFT_CAP>,
  items: round_items.map(it => ({
    kind: it.kind, id: it.id, title: it.title,
    description: <descrierea verbatim din Faza 1>,
    worker_skill: it.worker_skill,
  })),
}
```

Workflow-ul întoarce o listă de rezultate JSON (contractul cu 9 chei:
`item_id, outcome, verify_channel, test_recommendation, effort, summary, question, worktree, branch`,
plus `needs_preview`). Fiecare muncitor și-a creat worktree-ul, a implementat, a committuit, și (unde a
fost cazul) a fost verificat — SQL în paralel, preview serial. **Nimic nu e încă merge-uit** — merge-ul e
treaba ta, mai jos.

### Pas C4 — Pasul de teste (pe verzi, în worktree, înainte de merge)

Pentru fiecare rezultat cu `outcome ∈ {fixed, done}` (verde), execută **pasul de teste** (identic cu Pas B5),
dar acum scopat pe **worktree-ul itemului** (`r.worktree`), nu pe `repo_path`:

| `test_recommendation` | Acțiune |
|---|---|
| `"ai"` | Dispatch subagent `/writing-ai-test-plans` cu `TARGET_SOURCE_ROOT=r.worktree`, `TARGET_PROJECT_ID`, `TARGET_ITEM_ID`. |
| `"human"` | Dispatch subagent `/writing-tester-test-plans` cu același scoping. |
| `"both"` | Ambele (în paralel). |
| `"none"` | Nimic. |

Testele se scriu **în worktree** ca să intre în același merge ca fix-ul. Dacă skill-ul de teste committuiește,
committuiește în `r.worktree`. Așteaptă finalizarea înainte de merge.

> Pentru iteme `no_worktree` (ex. `auto-running-test-plans` în Milestone D) pasul de teste e `none` și
> nu există merge.

### Pas C5 — Merge secvențial al verzilor (firul principal)

Procesează rezultatele verzi **unul câte unul** (NICIODATĂ două merge-uri în paralel). Pentru fiecare:

```bash
git -C <repo_path> merge --no-ff --no-edit orch/<item_id>
```

Interpretează **codul de ieșire** (vezi `reference/worktrees.md`):

- **Cod zero (merge reușit):**
  1. **Write-back DONE** — execută SQL-ul DONE din `reference/board-queries.md` (`tt_bugs.status='Fixed'`
     pentru bug, `tt_features.status='Gata'` pentru feature), interpolând `:id=item_id`, `:effort=effort`,
     `:date=<azi>`, `:summary=summary`.
  2. **CLEANUP worktree**:
     ```bash
     git -C <repo_path> worktree remove --force C:/Users/lakie/Desktop/.orch-worktrees/<run_id>/<slug>-<item_id>
     git -C <repo_path> branch -D orch/<item_id>
     ```
- **Cod non-zero (conflict):**
  1. **Abort** — nu lăsa repo-ul pe jumătate-merge-uit:
     ```bash
     git -C <repo_path> merge --abort
     ```
  2. **PARK** itemul (Pas C6) cu `question="conflict de merge pe <fișierele în conflict>; rezolvă manual"`.
  3. **PĂSTREAZĂ** worktree-ul + branch-ul `orch/<item_id>` (NU face cleanup) — munca trăiește acolo.

Ordinea merge-ului: după prioritate (verzii cu prioritate mai mare întâi), ca un eventual conflict să cadă
pe itemul mai puțin prioritar.

### Pas C6 — Park (blocked + conflicte)

Pentru fiecare rezultat cu `outcome = 'blocked'` **și** pentru fiecare item picat la merge cu conflict:

- Execută SQL-ul PARK din `reference/board-queries.md` (notă pe rândul sursă + `ensureFocusRow` →
  `is_blocked=true`, `blocked_reason=question`). Vezi Pas B6 „blocked" pentru detaliile `ensureFocusRow`
  (mapare status focus, INSERT dacă `focus_task_id IS NULL`, legare).
- **PĂSTREAZĂ** worktree-ul + branch-ul (regula PARK din `worktrees.md`). NU face cleanup.
- `:reason` = `question`-ul itemului (din JSON pentru blocked; „conflict de merge pe …" pentru conflicte).

### Pas C7 — Raport de rundă

Printează un raport concis al rundei:

```
Dispecer — rundă (Milestone C) — <slug> (project_id=<pid>) — <YYYY-MM-DD> — run_id=<run_id>

✅ Făcute & merge-uite (N):
  - [<kind> #<id>] <titlu> → <summary>   (branch orch/<id> merge-uit, worktree curățat)
⏸️ Parcate pentru tine (M):
  - [<kind> #<id>] <titlu> → <question / motivul conflictului>   (worktree: <cale>)
↩️ Amânate (coliziune de zonă / peste SOFT_CAP) (D):
  - [<kind> #<id>] <titlu> → coliziune cu #<X>; rulează din nou ca să-l prinzi
❌ Picate la verificare (K):
  - [<kind> #<id>] <titlu> → <motiv>

Worktrees parcate (de reluat manual): <căi>
```

### Notă de scope (Milestone C vs. D)

În Milestone C rulezi **o singură rundă**. Itemele amânate (coliziune de zonă sau peste `SOFT_CAP`) **nu**
sunt reluate automat — raportul le listează ca „rulează din nou". Bucla-până-se-golește (`attempted`-set,
re-citire board, repetare până nu mai e nimic nou), întrebările up-front printr-un `AskUserQuestion`,
suportul pentru toate cele 4 tipuri de muncitor într-o rundă, și secțiunea de guvernare numerotată
vin în **Milestone D**. Până atunci, pentru a procesa amânatele, rulează `/orchestrate <slug>` din nou.

---

## Greșeli de evitat

| Greșeală | De ce contează | Fix |
|---|---|---|
| Lowercase pe statusuri | DB-ul folosește exact `Open`, `In Progress`, `Propus`, `Planificat`, `În Focus`, `Gata`, `Fixed` — case-sensitive în filtre UI | Hardcodează valorile exacte |
| `project_id` lipsă din query | Ai citi iteme din alte proiecte | Faza 0 îl rezolvă; include-l în FIECARE query |
| A rula dry-run cu Supabase MCP deconectat | Query-urile eșuează silenți | Pas 1 din Faza 1: ping obligatoriu `SELECT 1` — nu condiționa de dubii |
| A scrie în DB în dry-run | Dry-run-ul e promisiunea de „zero scrieri" | Faza 1 = SELECT-uri pure; niciun UPDATE/INSERT în dry-run |
| Să sari SKIP_TAG check | Itemele `[manual]` sunt creative/intangibile; muncitorii nu le pot rezolva | Filtrează după 1d, înaintea oricărei alte procesări |
| Abort silențios la repo murdar | Userul nu știe de ce nu s-a întâmplat nimic | Mesaj explicit cu calea repo-ului și ce să facă |
| A lăsa Workflow-ul să genereze `run_id` | `Date.now()`/`Math.random()`/`new Date()` ARUNCĂ în sandbox-ul Workflow | Conductorul generează `run_id` (Pas C0, `date +%s`) și-l pasează în `args.run_id` |
| Merge în paralel al worktree-urilor | Două merge-uri simultane în `repo_path` corup indexul / se calcă | Merge **secvențial**, un singur item odată (Pas C5) |
| Cleanup worktree la PARK/conflict | Pierzi munca muncitorului care trebuie reluată manual | PARK păstrează worktree+branch; cleanup DOAR la merge reușit (`worktrees.md`) |
| Fan-out paralel pe `git=false` | Nu poți edita în paralel același working tree fără izolare | `git=false` → in-place **serial**, fără merge (Pas C2) |
| Merge fără verificare | Aterizezi cod neverificat | Doar `outcome ∈ {fixed,done}` (verificat preview/SQL) intră la merge; `blocked` → PARK |
