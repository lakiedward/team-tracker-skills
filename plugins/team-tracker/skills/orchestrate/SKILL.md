---
name: orchestrate
description: Use when the user wants to run an automated sweep of the entire Focus board for a project — resolves the project, reads all open bugs, features, and test plans, asks any up-front clarifying questions once, then launches a fleet of parallel workers (existing team-tracker skills) in isolated git worktrees, runs them round after round until the board is empty, lands only what is verified, parks what is uncertain, and prints a consolidated report with batched parked questions. A `--dry-run` mode prints the work list without writing anything; `--only <kind>:<id>` processes a single item. Triggers on "/orchestrate", "dă-i la tot <proiect>", "apucă-te de tot de pe Focus", "orchestrate betro", "rulează dispecerul pe <proiect>", "sweep tot board-ul", "procesează tot board-ul".
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
— muncitorul rulează direct în `repo_path`, fără worktree izolat. Modul cu flotă (Milestone C) rulează
**in-place, serializat** pentru proiectele fără git (un singur muncitor odată, fără worktree, fără merge) —
vezi **Pas C2** din „Fazele 2–3". Sari verificarea `git status` de mai jos și continuă direct la Faza 1.

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

## Fazele 2–3 — O rundă completă (flotă)

Dacă invocarea **nu** are `--dry-run` și **nu** are `--only`, rulezi modul cu flotă: o rundă în care mai
mulți muncitori lucrează în paralel, fiecare în worktree-ul lui, verificarea-pe-preview e serializată
printr-un lease unic, iar tu (firul principal) faci merge secvențial la verzi și parchezi conflictele.

> **Această secțiune definește O RUNDĂ. Corpul buclei (Milestone D) este Pas C2–C7.** Pas C0 (`run_id`) și
> triajul up-front rulează **O SINGURĂ DATĂ** la Pas L0 / Triaj, înainte de prima rundă — **niciodată** în
> interiorul buclei. În fluxul complet `/orchestrate <proiect>`, bucla (Pas L1) cheamă Pas C2–C7 în mod
> repetat, întreținând un set `attempted` și re-citind board-ul între runde. Înainte de PRIMA rundă rulează
> **triajul + pâlnia de întrebări up-front** (Milestone D, secțiunea „Triaj & întrebări up-front"); după ce
> bucla se oprește, printezi **raportul final consolidat** (nu raportul de rundă din Pas C7). **Nu duplica
> logica rundei** — bucla și modurile up-front/raport o referențiază; ea trăiește o singură dată, aici.

### Pas C0 — Generează `run_id` (în firul principal, O SINGURĂ DATĂ la Pas L0)

Workflow-ul rulează în sandbox unde `Date.now()` / `Math.random()` / `new Date()` fără argumente **aruncă**
— deci NU poate fabrica un id. **Tu** generezi `run_id` o singură dată, dintr-un timestamp Unix, și-l pasezi
în `args` la lansarea Workflow-ului și (implicit, prin args) în prompturile muncitorilor:

```bash
date +%s
```

Reține rezultatul ca `run_id` (string, ex. `"1750762800"`). Worktree-urile rundei vor sta sub
`C:/Users/lakie/Desktop/.orch-worktrees/<run_id>/`.

> **Generat O SINGURĂ DATĂ la Pas L0. NU regenera `run_id` la fiecare rundă** — ar schimba directorul
> worktree-urilor și ar deruta setul `attempted`. Bucla (Pas L1) refolosește același `run_id` în toate
> rundele comenzii.

> **`run_id` = identitatea ÎNTREGII comenzi `/orchestrate`, nu a unei singure runde.** În fluxul cu buclă
> (Milestone D), generezi `run_id` **o singură dată** la începutul comenzii (înainte de prima rundă) și-l
> refolosești pentru **toate** rundele. El identifică setul `attempted` (vezi „Faza buclă") și rădăcina de
> worktree-uri pentru toată rularea. Worktree-urile rundei N stau tot sub `.orch-worktrees/<run_id>/` —
> coliziunile de nume sunt evitate de basename-ul `<slug>-<itemId>` (un id se procesează o singură dată per
> comandă, garantat de `attempted`).

### Pas C1 — Grupare anti-conflict (înainte de fan-out)

Două branch-uri care ating **același fișier** intră în conflict la merge. Ca să eviți asta:

1. Pentru fiecare item din `work_items`, estimează **zona de cod** probabilă din `title` + `description`
   (ex. „pagina de login" → zona auth/login; „export CSV pe raport" → zona reports/export; „culoare buton"
   → zona UI/componenta respectivă). Folosește judecată — nu există o hartă exactă; grupează după
   substantivele de feature/ecran/fișier menționate.
2. **Itemele din aceeași zonă nu intră în aceeași rundă.** Dintr-un grup cu aceeași zonă, ia **un singur**
   item în runda curentă; pe celelalte **amână-le**. În fluxul cu buclă (Milestone D), amânatele NU se
   raportează ca „rulează din nou" — ele **intră automat în runda următoare**: nu le adăuga în `attempted`
   (vezi „Faza buclă"), așa că re-citirea board-ului din runda următoare le va include din nou și de data
   asta zona lor e liberă (itemul cu care se ciocneau s-a procesat deja). Astfel coliziunile de zonă se
   rezolvă natural rundă-după-rundă, nu prin re-rulare manuală.
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
    // D1: marchează `no_worktree:true` pentru muncitorii care NU editează cod — adică
    // `auto-running-test-plans` (rulează un plan, scrie rezultate în DB). Workflow-ul îl
    // rulează FĂRĂ worktree și conductorul sare merge-ul pentru aceste iteme. Ceilalți trei
    // muncitori (resolving-tt-bugs / resolving-tt-features / resolving-failed-test-plans)
    // editează cod → `no_worktree` lipsește/false.
    no_worktree: it.worker_skill === 'auto-running-test-plans' ? true : undefined,
  })),
}
```

Workflow-ul întoarce o listă de rezultate JSON (contractul:
`item_id, outcome, verify_channel, test_recommendation, effort, summary, question, worktree, branch`,
plus `needs_preview`, **`verified`**, și `no_worktree` pentru itemele test-runner). Fiecare muncitor cu
worktree și-a creat worktree-ul, a implementat, a committuit; itemele `no_worktree` (auto-running-test-plans)
au rulat un plan și au scris rezultate în DB, fără worktree;
unele rezultate au trecut printr-un stage de verificare (SQL paralel / preview serial), altele NU.
**`verified` spune adevărul**: e `true` DOAR pe rezultatele întoarse de un agent de verificare viu. Dacă
verificatorul a murit, itemul degradează la „passthrough" și revine byte-identic cu un verde verificat, DAR cu
`verified:false`. **Nu te baza pe `outcome` singur** — un `outcome:'fixed'` cu `verified:false` NU e verificat.
**Nimic nu e încă merge-uit** — merge-ul (și poarta de verificare) sunt treaba ta, mai jos.

### Pas C4 — Pasul de teste (pe verzi, în worktree, înainte de merge)

**Pasul de teste se execută NUMAI pentru iteme worktree-based verzi care au editat cod** (adică
`worker_skill ∈ {resolving-tt-bugs, resolving-tt-features, resolving-failed-test-plans}` cu
`r.no_worktree !== true`). **SARI complet Pas C4 pentru iteme `no_worktree`** (`auto-running-test-plans`) —
`test_recommendation` lor este `none` oricum și nu există worktree pe care să-l scopezi.

Pentru fiecare rezultat eligibil cu `outcome ∈ {fixed, done}` (verde, worktree prezent), execută **pasul
de teste** (identic cu Pas B5), dar acum scopat pe **worktree-ul itemului** (`r.worktree`), nu pe `repo_path`:

| `test_recommendation` | Acțiune |
|---|---|
| `"ai"` | Dispatch subagent `/writing-ai-test-plans` cu `TARGET_SOURCE_ROOT=r.worktree`, `TARGET_PROJECT_ID`, `TARGET_ITEM_ID`. |
| `"human"` | Dispatch subagent `/writing-tester-test-plans` cu același scoping. |
| `"both"` | Ambele (în paralel). |
| `"none"` | Nimic. |

Testele se scriu **în worktree** ca să intre în același merge ca fix-ul. Dacă skill-ul de teste committuiește,
committuiește în `r.worktree`. Așteaptă finalizarea înainte de merge.

### Pas C5 — Reconciliere + merge secvențial al verzilor (firul principal)

#### C5.0 — Reconciliere trimis-vs-întors (curăță worktree-urile orfane)

**Înainte de orice merge**, compară ID-urile pe care le-ai trimis cu cele care s-au întors. Un muncitor de
implementare care **a murit** nu apare deloc în lista întoarsă de Workflow — dar și-a putut crea worktree-ul
înainte să cadă, lăsându-l **orfan**. Calea worktree-ului e deterministă, deci o poți curăța fără să fi primit
ceva înapoi:

1. `sent = round_items.map(it => it.id)` (ID-urile pasate în `args.items`).
2. `returned = <rezultatele Workflow-ului>.map(r => r.item_id)`.
3. Pentru fiecare `id ∈ sent` care **NU** e în `returned` (muncitorul lui a murit):
   - Worktree-ul orfan stă la calea deterministă `C:/Users/lakie/Desktop/.orch-worktrees/<run_id>/<slug>-<id>`.
   - Curăță-l **în ordinea junction-first** (vezi `reference/worktrees.md` → CLEANUP). Muncitorul putea muri
     **înainte** sau **după** `mklink //J node_modules`, deci scoate întâi junction-ul (inofensiv dacă nu există),
     **abia apoi** worktree-ul (ignoră erorile — putea muri înainte chiar de `worktree add`):
     ```bash
     cmd //c rmdir "C:\Users\lakie\Desktop\.orch-worktrees\<run_id>\<slug>-<id>\node_modules"   # scoate DOAR reparse point-ul junction-ului, NU ținta. NICIODATĂ 'rmdir /s' aici.
     git -C <repo_path> worktree remove --force C:/Users/lakie/Desktop/.orch-worktrees/<run_id>/<slug>-<id>
     git -C <repo_path> branch -D orch/<id>
     ```
   - **PERICOL:** NICIODATĂ nu rula `git worktree remove --force <wt>` cât timp junction-ul `node_modules` mai
     există — un delete recursiv forțat ar putea traversa junction-ul și distruge `node_modules`-ul REAL al
     proiectului. Întâi `rmdir` junction-ul (plain `rmdir`, **fără** `/s`), abia apoi `worktree remove`.
   - Raportează itemul în bucket-ul „picate" ca **„❌ Picat (muncitor mort) — reia"** (Pas C7).

Asta rulează doar pentru proiecte `git=true` (cele cu worktree-uri). La `git=false` nu există worktree de curățat.

#### C5.1 — Poarta de verificare (model-C: NICIUN merge neverificat)

Procesează rezultatele întoarse **unul câte unul** (NICIODATĂ două merge-uri în paralel). Pentru fiecare rezultat
`r`, **clasifică-l întâi după poarta de verificare**, NU doar după `outcome`:

- **Item `no_worktree` (test-runner, ex. `auto-running-test-plans`)** — recunoaște-l după `r.no_worktree === true`,
  SAU după `worktree`/`branch` goale, SAU (cel mai sigur) după `worker_skill` al itemului trimis: tu știi din
  `round_items` că itemul `r.item_id` a fost dat lui `auto-running-test-plans`. Acesta **NU se merge-uiește**
  (n-are diff de cod) și **nu are worktree de curățat**. Muncitorul a scris deja rezultatele planului per item în DB în timpul rulării; tu **nu** faci
  write-back DONE pe vreun rând-sursă (planul nu se „termină" ca un bug). Dacă `r.outcome === 'done'`,
  contorizează-l ca „✅ rulat" în raport; dacă `r.outcome === 'blocked'` (planul nu s-a putut rula deloc),
  PARK normal (Pas C6, fără worktree). Nu intra în C5.2 pentru aceste iteme. Rezultatul lor informează doar
  runda următoare (pașii `fail` apar pentru `resolving-failed-test-plans`).
- **Merge DOAR dacă** `r.outcome ∈ {fixed, done}` **ȘI** `r.verified === true` **ȘI** itemul are worktree
  (`r.no_worktree !== true`). Numai atunci codul a fost efectiv verificat de un agent de verificare viu → treci
  la C5.2 (merge).
- **Dacă** `r.outcome ∈ {fixed, done}` **DAR** `r.verified !== true` (verificatorul a murit și itemul a degradat
  la passthrough, SAU `verify_channel:'none'` — n-a existat o verificare reală pe preview/SQL) → **NU face merge**.
  PARK-ează itemul (Pas C6) cu `question="verificare lipsă/eșuată — reia"` și **PĂSTREAZĂ** worktree-ul + branch-ul.
  Un verde neverificat nu aterizează niciodată.
  > **`verify_channel:'none'` ⇒ NICIODATĂ merge ⇒ PARK.** `verified:true` e legitim DOAR când
  > `verify_channel ∈ {preview, sql}` ȘI acea verificare chiar a trecut (poarta o ridică numai un agent de
  > verificare din Stage 2a/2b — vezi `round.workflow.js`). Grep / tsc / raționamentul muncitorului NU sunt
  > verificare: un astfel de rezultat raportează corect `verify_channel:'none'` + `verified:false` și se parchează.
- **Dacă** `r.outcome === 'blocked'` → PARK normal (Pas C6).

> **Regulă pentru un Claude rece:** un `outcome:'fixed'`/`'done'` cu `verified:false` arată byte-identic cu un
> verde real, dar **nu e verificat**. NU-l merge-ui pe baza `outcome`. Verifică TU flag-ul `verified` la fiecare
> rezultat înainte de merge. Singura combinație care intră la merge e `outcome ∈ {fixed,done}` **ȘI**
> `verified === true`.

#### C5.2 — Merge (doar pentru verzii verificați)

```bash
git -C <repo_path> merge --no-ff --no-edit orch/<item_id>
```

Interpretează **codul de ieșire** (vezi `reference/worktrees.md`):

- **Cod zero (merge reușit):**
  1. **Write-back DONE** — execută SQL-ul DONE din `reference/board-queries.md` (`tt_bugs.status='Fixed'`
     pentru bug, `tt_features.status='Gata'` pentru feature), interpolând `:id=item_id`, `:effort=effort`,
     `:date=<azi>`, `:summary=summary`.
  2. **CLEANUP worktree** — **junction-first** (vezi `reference/worktrees.md` → CLEANUP). Scoate ÎNTÂI
     junction-ul `node_modules`, ABIA APOI worktree-ul:
     ```bash
     cmd //c rmdir "C:\Users\lakie\Desktop\.orch-worktrees\<run_id>\<slug>-<item_id>\node_modules"   # scoate DOAR reparse point-ul junction-ului, NU ținta. NICIODATĂ 'rmdir /s' aici.
     git -C <repo_path> worktree remove --force C:/Users/lakie/Desktop/.orch-worktrees/<run_id>/<slug>-<item_id>
     git -C <repo_path> branch -D orch/<item_id>
     ```
     > **PERICOL:** NICIODATĂ nu rula `git worktree remove --force <wt>` cât timp junction-ul `node_modules`
     > mai există — un delete recursiv forțat ar putea traversa junction-ul și distruge `node_modules`-ul REAL
     > al proiectului. Întâi `rmdir` junction-ul (plain `rmdir`, **fără** `/s`), abia apoi `worktree remove`.
     > **Verificare de siguranță:** după cleanup confirmă că `<repo_path>/node_modules` încă există (junction-ul
     > scos n-a atins ținta) — dacă a dispărut, OPREȘTE-TE și raportează.
- **Cod non-zero (conflict):**
  1. **Abort** — nu lăsa repo-ul pe jumătate-merge-uit:
     ```bash
     git -C <repo_path> merge --abort
     ```
  2. **PARK** itemul (Pas C6) cu `question="conflict de merge pe <fișierele în conflict>; rezolvă manual"`.
     Decizia worktree (PĂSTREAZĂ vs CLEANUP) o ia Pas C6 prin `rev-list` — pentru un conflict branch-ul are
     mereu commit-uri (`>0`), deci rezultatul e **PĂSTREAZĂ**. NU face cleanup aici.

Ordinea merge-ului: după prioritate (verzii cu prioritate mai mare întâi), ca un eventual conflict să cadă
pe itemul mai puțin prioritar.

### Pas C6 — Park (blocked + verificare lipsă + conflicte)

Pentru fiecare rezultat care merge la PARK — adică: `outcome = 'blocked'`; SAU verde neverificat
(`outcome ∈ {fixed,done}` cu `verified !== true`, din C5.1); SAU item picat la merge cu conflict:

Execuția parkului **diferă după `kind`**:

**`kind='bug'` sau `kind='feature'`** (comportament standard):
- Pas 1 — append notă pe rândul sursă (`tt_bugs` / `tt_features`, după `kind`):
  `:reason` = `question`-ul itemului (din JSON pentru blocked; `"verificare lipsă/eșuată — reia"` pentru
  verzi neverificați; „conflict de merge pe …" pentru conflicte).
- Pas 2 — `ensureFocusRow` → `is_blocked=true`, `blocked_reason=question`. Vezi Pas B6 „blocked" pentru
  detaliile `ensureFocusRow` (mapare status focus, INSERT dacă `focus_task_id IS NULL`, legare).
  Valori valide pentru `source_type`: `'bug'` sau `'feature'` — **niciodată `'testplan'` sau `'test_plan'`**.

**`kind='testplan'`** (virtual-first — fără rând `tt_focus_tasks`):
- Pas 1 — append notă pe `tt_test_plans.description`:
  ```sql
  UPDATE tt_test_plans SET description = description || E'\n\n--- Parcat :date (Dispecer) ---\n:reason',
    updated_at=NOW() WHERE id=:id;
  ```
- **Pas 2 — SARI complet `ensureFocusRow`.** Test planurile sunt virtual-first pe Focus board: coloana lor
  e calculată din rezultatele itemelor (`pending`/`fail`/`blocked`/`pass`), nu dintr-un rând `tt_focus_tasks`.
  **Nu exista un `tt_focus_tasks` row pentru test planuri și NU trebuie creat unul.** Câmpul `is_blocked`
  nu se aplică unui test plan (tabelul valid pentru `source_type` este `'test_plan'` cu underscore, dar
  dispecerul **nu insertează niciodată un focus row** cu `source_type='test_plan'` — regula e: fără focus
  row pentru test planuri, punct). Un test plan parcat rămâne vizibil pe board prin itemele sale; nota din
  `description` este singurul artefact al parkului.

> **Regulă pentru un Claude rece:** dacă `kind='testplan'`, parkul = NUMAI `UPDATE tt_test_plans SET
> description = ...`. Nu căuta `focus_task_id`. Nu executa INSERT în `tt_focus_tasks`. Nu seta `is_blocked`.
> Orice tentativă de `ensureFocusRow` pe un test plan este greșită — `source_type='test_plan'` nu este un
> `source_type` valid pentru context-ul de park al dispecerului (chiar dacă coloana tehnic acceptă valoarea).

**Worktree la PARK — PĂSTREAZĂ doar dacă există muncă de reluat (NU păstra worktree-uri goale):**
Un muncitor blocat la **Stage 1** (implement) își poate crea worktree-ul dar **nu committuiește nimic** — un
worktree gol nu are ce relua. Verifică câte commit-uri are branch-ul peste HEAD **înainte** să decizi:

```bash
git -C <repo_path> rev-list --count HEAD..orch/<item_id>
```

- **`0`** (branch fără commit-uri — tipic pentru un block la Stage 1) → **CLEANUP** worktree + branch (nimic de
  reluat), **junction-first** (vezi `reference/worktrees.md` → CLEANUP). Scoate ÎNTÂI junction-ul `node_modules`,
  ABIA APOI worktree-ul:
  ```bash
  cmd //c rmdir "C:\Users\lakie\Desktop\.orch-worktrees\<run_id>\<slug>-<item_id>\node_modules"   # scoate DOAR reparse point-ul junction-ului, NU ținta. NICIODATĂ 'rmdir /s' aici.
  git -C <repo_path> worktree remove --force C:/Users/lakie/Desktop/.orch-worktrees/<run_id>/<slug>-<item_id>
  git -C <repo_path> branch -D orch/<item_id>
  ```
  > **PERICOL:** NICIODATĂ nu rula `git worktree remove --force <wt>` cât timp junction-ul `node_modules` mai
  > există — un delete recursiv forțat ar putea traversa junction-ul și distruge `node_modules`-ul REAL al
  > proiectului. Întâi `rmdir` junction-ul (plain `rmdir`, **fără** `/s`), abia apoi `worktree remove`.
- **`>0`** (branch cu commit-uri — verde neverificat, sau block la verificare după ce s-a implementat, sau
  conflict de merge) → **PĂSTREAZĂ** worktree-ul + branch-ul (regula PARK din `worktrees.md`). Munca trăiește
  acolo; raportul listează calea.

> Notă: pentru un item picat la **merge cu conflict** branch-ul are mereu commit-uri (`>0`) → PĂSTREAZĂ.
> Distincția `rev-list` separă block-urile goale de la implement (curăță) de orice worktree cu muncă reală (ține).
> Pentru `git=false` nu există worktree/branch — sari acest sub-pas.

### Pas C7 — Cleanup dir run-id + raport de rundă

#### C7.0 — Înlătură dir-ul părinte al rundei dacă a rămas gol

După ce toate worktree-urile rundei au fost curățate sau parcate, dir-ul părinte
`C:/Users/lakie/Desktop/.orch-worktrees/<run_id>` poate fi gol (toate verzii merge-uite + toate block-urile
goale curățate). Curăță referințele git stale și încearcă să-l ștergi (ignoră eșecul dacă au rămas worktree-uri
parcate înăuntru — atunci dir-ul NU e gol și trebuie păstrat):

```bash
git -C <repo_path> worktree prune
rmdir C:/Users/lakie/Desktop/.orch-worktrees/<run_id>
```

`rmdir` (fără `-r`) șterge dir-ul **doar dacă e gol** — deci e sigur: dacă un worktree parcat încă trăiește acolo,
comanda eșuează inofensiv și dir-ul rămâne. NU forța ștergerea. (Pentru `git=false` nu există acest dir.)

#### C7.1 — Raport de rundă (intermediar; agregat de buclă)

Printează un raport concis **al rundei curente** (rundă `r` din buclă). **Fiecare item trimis apare pe EXACT
o linie, într-un singur bucket.** Acesta e un raport *intermediar*: bucla (vezi „Faza buclă") acumulează
soartele tuturor itemelor din toate rundele și, după ce bucla se oprește, le strânge în **raportul final
consolidat** (vezi „Raport final + întrebări parcate"). Itemele „↩️ Amânate" de aici NU sunt o concluzie —
ele reintră în runda următoare; le listezi doar ca să fie vizibil progresul rundei.

```
Dispecer — rundă <r> — <slug> (project_id=<pid>) — <YYYY-MM-DD> — run_id=<run_id>

✅ Făcute & merge-uite (N):
  - [<kind> #<id>] <titlu> → <summary>   (branch orch/<id> merge-uit, worktree curățat)
⏸️ Parcate / picate (cu motiv) (M):
  - [<kind> #<id>] <titlu> → <motiv>   (worktree: <cale> | curățat)
↩️ Amânate → runda următoare (coliziune de zonă / peste SOFT_CAP) (D):
  - [<kind> #<id>] <titlu> → coliziune cu #<X>; reintră în runda următoare

Worktrees parcate (de reluat manual): <căi care încă există>
```

**Regula de încadrare (un Claude rece umple exact o linie per item):**

| Soarta itemului | Bucket | `<motiv>` |
|---|---|---|
| Merge reușit (`outcome ∈ {fixed,done}` ȘI `verified` ȘI cod-zero la merge) | ✅ Făcute | `summary` |
| Blocat la implementare (`outcome='blocked'`, vine din Stage 1) | ⏸️ Parcate / picate | `question` (ex. „prea vag — întrebare …") + `(worktree curățat)` dacă era gol |
| Picat la verificare (`outcome='blocked'` întors de un agent de verificare) | ⏸️ Parcate / picate | `question` (ex. „verificarea SQL a eșuat: …") |
| Verde neverificat (`outcome ∈ {fixed,done}` dar `verified=false`) | ⏸️ Parcate / picate | „verificare lipsă/eșuată — reia" |
| Conflict de merge | ⏸️ Parcate / picate | „conflict de merge pe <fișiere>; rezolvă manual" |
| Muncitor mort (id trimis dar neîntors — din C5.0) | ⏸️ Parcate / picate | „❌ Picat (muncitor mort) — reia" |
| Amânat (coliziune de zonă / peste `SOFT_CAP`, din Pas C1) | ↩️ Amânate | „coliziune cu #<X>; rulează din nou" |

> Block-urile de la implementare și eșecurile de verificare întorc **amândouă** `outcome:'blocked'` — de aceea
> stau în **același** bucket „⏸️ Parcate / picate", iar `<motiv>` (din `question`) le distinge. Nu inventa un
> bucket separat; un singur rând per item, cu motivul corect din tabelul de mai sus.

---

## Triaj & întrebări up-front (înainte de prima rundă)

Acesta este **primul pas al fluxului complet** `/orchestrate <proiect>` (fără `--dry-run`, fără `--only`),
rulat **o singură dată**, după Faza 1 (citirea board-ului) și **înainte** de generarea `run_id` și de prima
rundă a buclei. Scop: itemele **clar ambigue** nu intră în flotă pe ghicite — strângi întrebările lor și le
pui userului **o singură dată**, printr-un singur apel `AskUserQuestion` (tool de fir-principal). Apoi
țeși răspunsurile în prompturile muncitorilor.

### Pas T1 — Separă itemele clar ambigue

Parcurge `work_items` (din Faza 1). Marchează un item drept **clar ambiguu** DOAR dacă, fără un răspuns de la
user, un muncitor n-ar putea decide ce să facă — nu specula. Semnale concrete de ambiguitate:

- titlu/descriere vagi fără criteriu de acceptare (ex. „fă mai bine pagina X", „îmbunătățește fluxul", „mai
  frumos") — nu se poate verifica obiectiv ce înseamnă „gata";
- mai multe interpretări incompatibile, fără indiciu care e cea dorită (ex. „mută butonul" — unde?);
- decizie de produs deschisă în brief (ex. „poate ar trebui să scoatem feature-ul Y?" — întrebare, nu cerință).

Un item cu brief clar (chiar dacă mare) **NU** e ambiguu — intră în flotă; muncitorul decide tehnic. Rezervă
pâlnia up-front pentru ambiguitatea de **intenție**, nu de implementare.

> **Diferența față de park:** ambiguitatea up-front o prinzi **înainte** de a porni muncitorul (nu irosești o
> rundă pe un item care oricum s-ar bloca). Park-ul prinde incertitudinea descoperită **în timpul** lucrului
> (acțiune ireversibilă, verificare eșuată, retry-uri epuizate). Ambele duc întrebări la user — una înainte,
> alta după.

### Pas T2 — Pune întrebările o singură dată (`AskUserQuestion`, fir principal)

- Dacă **niciun** item nu e clar ambiguu → **nu** întreba nimic; pornește direct bucla (full auto). Ăsta e
  cazul normal.
- Dacă există 1+ iteme ambigue → adună întrebările lor și pune-le **într-un SINGUR apel `AskUserQuestion`**
  (un singur tool call, cu câte o întrebare per item ambiguu — `AskUserQuestion` acceptă mai multe întrebări
  odată). NU pune câte un apel per item; NU întreba în mijlocul buclei. **`AskUserQuestion` se cheamă EXCLUSIV
  aici, în firul principal** — niciodată din `round.workflow.js` (sandbox-ul e mut; vezi „Plase de siguranță"
  pct. 7).

### Pas T3 — Țese răspunsurile + decide ce intră în flotă

- Pentru fiecare item ambiguu **la care userul a răspuns**: adaugă răspunsul în brieful muncitorului (în
  promptul de la Pas C3 / `args.items[].description`, ca text suplimentar „Clarificare user: …") și include-l
  în flotă (intră în prima rundă, prin `work_items`).
- Pentru un item ambiguu **lăsat fără răspuns** (userul a sărit întrebarea): NU-l băga în flotă — marchează-l
  direct ca **parcat up-front** cu `question` = întrebarea originală, și include-l în raportul final la „Parcate".
- Itemele neambigue intră în flotă neschimbate.

Abia acum generezi `run_id` (Pas C0) și intri în „Faza buclă".

---

## Faza buclă (runde) — buclă-până-se-golește + anti-buclă-infinită

Fluxul complet `/orchestrate <proiect>` **nu rulează o singură rundă** — repetă runda (Pas C0–C7) până când
board-ul nu mai produce iteme noi acționabile, sau se atinge un plafon. Această fază **înconjoară** runda
definită în „Fazele 2–3"; **nu redefini** pașii rundei aici — cheam-o.

### Pas L0 — Inițializează identitatea rulării

O singură dată, la începutul comenzii (după triajul up-front):
- Generează `run_id` (Pas C0) — **una** pentru toată comanda, refolosită în toate rundele.
- `attempted = ∅` — un **set de chei `kind:id`** (ex. `bug:42`, `testplan:5`) procesate în această comandă.
  Identitatea lui e `run_id` (un `attempted` per rulare `/orchestrate`). NU persistă între comenzi.
- `rounds = 0`.
- `parked = []`, `done = []`, `failed = []` — acumulatori pentru raportul final (umplute din soarta fiecărui
  item, după tabelul din Pas C7.1). Adaugă aici și itemele parcate up-front din Pas T3.

### Pas L1 — O rundă

Repetă următoarele ca **o rundă**:

1. **Re-citește board-ul** (Faza 1 — query-urile 1a/1b/1c). Board-ul se schimbă între runde: write-back-urile
   rundei anterioare au mutat carduri pe „done", iar testele AI scrise într-o rundă apar acum ca planuri noi.
2. **Construiește mulțimea acționabilă a rundei** = `work_items` MINUS:
   - cheile din `attempted` (deja procesate în această comandă — anti-buclă-infinită);
   - itemele cu `SKIP_TAG` (`[manual]`) — niciodată în flotă (sunt deja excluse de Faza 1d, dar reține regula);
   - itemele **curent parcate/blocate**: orice item al cărui card Focus are `is_blocked=true` (parcat într-o
     rundă anterioară a ACESTEI comenzi, sau de o rulare trecută). Un item parcat nu se reia automat în aceeași
     comandă — așteaptă răspunsul userului (vezi „Raport final"). Practic, cheile parcate sunt deja în
     `attempted` (le adaugi când le parchezi, pasul 5), deci filtrarea pe `attempted` le acoperă; verificarea
     `is_blocked` prinde în plus itemele parcate de rulări **anterioare** care încă n-au fost deblocate.
3. **Grupare anti-conflict** (Pas C1) pe mulțimea acționabilă → `round_items` (plafonat la `SOFT_CAP`, fără
   coliziuni interne) + `deferred` (amânate — coliziune de zonă / peste `SOFT_CAP`). **Amânatele NU intră în
   `attempted`** — reintră în runda următoare.
4. **Dacă `round_items` e gol** → bucla s-a terminat (nimic nou de făcut). Ieși din buclă, treci la raport.
5. **Rulează runda** (**Pas C2–C7** pe `round_items` — corpul buclei; Pas C0 NU se repetă): lansează
   Workflow-ul, fă pasul de teste pe verzi, merge secvențial la verzii verificați, park la
   blocate/neverificate/conflicte, reconciliere orfani, cleanup, raport de rundă. Pentru fiecare item
   **procesat** (apare în `round_items` și a fost trimis Workflow-ului), **adaugă cheia `kind:id` în
   `attempted`** — indiferent de soartă (făcut, parcat, picat, muncitor mort). Acumulează soarta lui în
   `done` / `parked` / `failed`. `rounds += 1`.

### Pas L2 — Condiția de continuare

După fiecare rundă, **repetă** (înapoi la Pas L1) cât timp **TOATE** sunt adevărate:
- **(a) runda a produs ≥1 item nou acționabil** — adică `round_items` n-a fost gol (a existat muncă nouă pe
  care n-o mai încercaseși). Dacă o rundă completă iese cu `round_items` gol (tot ce rămâne e în `attempted`
  sau parcat), **nu mai e nimic nou** → **stop**.
- **(b) `rounds < max_rounds`** (valoarea întreagă pasată de user, default 6; condiția de stop este
  `rounds >= max_rounds`). La atingerea plafonului → **stop** (chiar dacă ar mai fi iteme; ce rămâne se
  raportează ca „de reluat").
- **(c) nu s-a atins un rate-limit MAX.** Dacă lansările încep să fie respinse de rate-limit → **nu mai lansa
  runde noi**; lasă runda curentă să-și termine ce-i în aer, apoi stop + raport (vezi „Plase de siguranță" pct. 3).

**Stop** = ieși din buclă și treci la „Raport final + întrebări parcate".

### Bucla de calitate (de ce progresează tests→run→fix peste runde)

Aceasta NU e o re-rulare oarbă a acelorași iteme — fiecare rundă lucrează pe **iteme noi**, datorită write-back-ului
și a generării de teste:

1. **Runda N**: `resolving-tt-bugs` / `resolving-tt-features` rezolvă bug-uri/features și, pe verzi, pasul de
   teste rulează `/writing-ai-test-plans` → scrie **planuri AI noi** (`test_type='ai'`, toate itemele `pending`).
2. **Runda N+1**: re-citirea board-ului vede acele planuri ca muncă nouă pentru `auto-running-test-plans`
   (plan AI ne-arhivat cu iteme `pending`). Au **id-uri noi** de plan → NU sunt în `attempted` → intră în flotă.
   `auto-running-test-plans` le rulează pe preview.
3. Dacă un plan AI **pică** (iteme `fail`/`blocked`), runda N+2 îl vede ca muncă pentru
   `resolving-failed-test-plans` (plan cu `fail`/`blocked`) → id de plan (tot nou pentru acest worker) →
   intră în flotă → repară defectul și marchează pașii `pass`.
4. Lanțul se golește singur: când nu mai apar planuri noi `pending` și niciun `fail`/`blocked` nou,
   `round_items` devine gol → bucla se oprește (Pas L2.a).

`attempted` (cheie `kind:id`) împiedică **reluarea ACELUIAȘI id** în aceeași comandă (anti-buclă-infinită):
un bug `Fixed` în runda N nu reapare (statusul nu mai e acționabil) și, chiar dacă ar reapărea, cheia lui e în
`attempted`. Itemele de tip diferit care apar din munca anterioară (planurile noi) au **id-uri/chei diferite**,
deci progresul e real, nu o buclă. Terminarea e garantată de **`attempted` (monoton crescător, board finit)**
ȘI de **`--max-rounds`** — chiar dacă o regulă de mapare ar genera la nesfârșit, plafonul de runde oprește.

---

## Raport final + întrebări parcate (după ce bucla se oprește)

Rulează **o singură dată**, când bucla a ieșit (board golit, plafon de runde, sau rate-limit). Înlocuiește
raportul de rundă din Pas C7.1 ca **ieșire finală** a comenzii — rapoartele de rundă au fost intermediare;
acesta consolidează toate rundele.

### Pas R1 — Raportul consolidat

Printează, în firul principal:

```
Dispecer — <slug> (project_id=<pid>) — <YYYY-MM-DD> — run_id=<run_id> — runde: <rounds>

✅ Făcute & merge-uite (N):
  - [<kind> #<id>] <titlu> → <summary>   (rundă <r>; branch orch/<id> merge-uit)
⏸️ Parcate — au nevoie de tine (M):
  - [<kind> #<id>] <titlu> → <question/motiv>   (worktree: <cale> | curățat)
❌ Picate (K):
  - [<kind> #<id>] <titlu> → <motiv>   (ex. muncitor mort / conflict de merge — reia)

Runde rulate: <rounds> / <max_rounds>   (motiv oprire: board golit | plafon runde | rate-limit)
Worktrees parcate (de reluat manual): <căi care încă există>
```

Raportul folosește **întotdeauna aceste trei bucket-uri fixe**:

- **✅ Făcute & merge-uite** = `done` — outcome merge-uit + write-back DONE executat. Intră: orice item cu
  merge reușit (`outcome ∈ {fixed,done}` ȘI `verified===true` ȘI cod-zero la merge).
- **⏸️ Parcate — au nevoie de tine** = `parked` — blocked cu o întrebare/decizie pentru user. Intră:
  `outcome='blocked'` (acțiune ireversibilă, prea vag, mai multe interpretări, retry-uri epuizate, încredere
  mică), verde neverificat (`verified=false`) parcat „verificare lipsă/eșuată — reia", ambigue up-front fără
  răspuns. Fiecare poartă un `question` sau motiv concret; acestea sunt cele transmise userului la Pas R2.
- **❌ Picate** = `failed` — eșecuri mecanice, fără întrebare pentru user, ci „reia". Intră: muncitor mort
  (id trimis dar neîntors), conflict de merge (`merge --abort` aplicat).

**Nu combina ⏸️ și ❌.** Distincția este: ⏸️ are o întrebare/decizie pentru user; ❌ este o reîncercare
mecanică. Numărătoarea trebuie să fie consistentă: fiecare item trimis în orice rundă apare exact o dată,
în exact un bucket (regula de încadrare din Pas C7.1, agregată peste runde).

### Pas R2 — Întrebări parcate în lot (`AskUserQuestion`, fir principal)

Dacă există iteme în `parked` care **poartă un `question`** (blocaje care chiar au nevoie de o decizie/un
input de la user — nu „muncitor mort/conflict", acelea sunt „reia"), pune-le userului **într-un SINGUR apel
`AskUserQuestion`** (la fel ca pâlnia up-front: un singur tool call, câte o întrebare per item parcat).
Acesta e **al doilea și ultimul** punct unde se cheamă `AskUserQuestion`, tot în firul principal.

### Pas R3 — Resume ușor: aplică răspunsurile ACUM (nu le pierde)

Când userul răspunde la întrebările parcate (din Pas R2 — same invocation, imediat după), **execută
deblocarea pentru fiecare item cu răspuns primit**, în ordinea răspunsurilor:

1. **Adaugă răspunsul în `description`-ul rândului-sursă** al itemului (`tt_bugs` / `tt_features` /
   `tt_test_plans`, după `kind`), append cu un antet de forma
   `E'\n\n--- Răspuns user :date (Dispecer) ---\n<răspuns>'`. Astfel brieful canonic conține de-acum
   clarificarea — o rulare viitoare o vede fără să re-parkeze itemul.
2. **Deblochează cardul Focus** al itemului:
   - Pentru `kind='bug'` sau `kind='feature'`: `UPDATE tt_focus_tasks SET is_blocked=false,
     blocked_reason='', updated_at=NOW() WHERE id=<focus_task_id>` (rândul focus creat la park prin
     `ensureFocusRow`).
   - Pentru `kind='testplan'`: **nu există rând `tt_focus_tasks`** (test planurile sunt virtual-first — nu se
     creează focus row la park; vezi Pas C6 / I-3). Pasul de deblocare focus se **sare** — numai append-ul
     de descriere contează.

> **„nu relua munca"** înseamnă: **NU re-citi board-ul** și **NU lansa runde noi** în aceeași invocare după
> ce aplici răspunsurile. NU înseamnă să sari aplicarea răspunsului — dacă răspunsul nu e persistat acum,
> este pierdut definitiv și o rulare viitoare va re-parca imediat itemul (brieful rămâne gol).

Efect: itemul redevine acționabil cu răspunsul deja în brief, iar **o rulare viitoare** `/orchestrate <slug>`
îl prinde în Faza 1 și-l procesează cu contextul complet. Deblocarea este **obligatorie** în această
invocare; re-citirea board-ului și lansarea de runde noi sunt amânate prin design.

> Dacă userul **nu** răspunde la un item (sare întrebarea), lasă cardul blocat și brieful neatins — rămâne
> în raport ca „de reluat" și o rulare viitoare îl va re-parca până primește un răspuns.

---

## Plase de siguranță

Regulile de guvernare care țin flota sub control. Sunt **obligatorii** — nu le slăbi „ca să meargă mai mult".
Multe sunt deja impuse de pașii de mai sus; secțiunea le strânge ca un checklist explicit și verificabil.

1. **Verificarea = poarta spre merge.** Niciun worktree nu aterizează fără un `outcome` verificat de un agent
   de verificare viu. Impus în **Pas C5.1**: merge DOAR dacă `outcome ∈ {fixed,done}` **ȘI `verified===true`**.
   Un verde cu `verified:false` (verificator mort → passthrough, sau `verify_channel:'none'`) NU se merge-uiește
   — se parchează cu „verificare lipsă/eșuată — reia". Nu te baza pe `outcome` singur.

2. **Poartă pe acțiuni ireversibile.** Definiție: **ireversibil = după merge+deploy execută X fără confirmare
   ulterioară — migrare DB, ștergere de date, push la remote, trimitere email/notificare/mesaj în afara
   sistemului.** Dacă un muncitor raportează că fix-ul cere o astfel de acțiune → muncitorul întoarce
   `outcome="blocked"` cu un `question` care descrie acțiunea ireversibilă, **fără să o execute**. Conductorul
   **NU auto-merge-uiește** și **NU execută** acea acțiune — o **parchează pentru user** (card blocat +
   întrebare în raport, Pas R2). Regula e codată în promptul muncitorului (`round.workflow.js`
   `implementPrompt`, „Reguli de incertitudine") și în target-mode-ul fiecărui skill muncitor. Acceptance live
   (amânat): un item care cere clar o migrare iese **parcat**, `tt_*.status` neschimbat, zero migrări aplicate
   (`SELECT count(*) FROM supabase_migrations.schema_migrations` egal înainte/după).

3. **Plafoane.** (a) `SOFT_CAP` muncitori per rundă (Pas C1.4 — plafonează `round_items`; restul amânate).
   (b) `max_rounds` runde maxime (default 6; stop când `rounds >= max_rounds`, Pas L2.b). (c) **Rate-limit
   MAX**: dacă lansările încep să fie respinse → **nu mai lansa runde/muncitori noi**, lasă ce-i în aer să
   termine, apoi **stop + raport** (Pas L2.c). Nu reîncerca în buclă strânsă pe rate-limit.

4. **Anti-thrash.** Muncitorul respectă **cele max 3 cicluri de retry ale propriului skill** (definite în
   fiecare skill muncitor); epuizate → `outcome="blocked"`, **nu** reîncearcă la nesfârșit. La nivel de comandă,
   setul **`attempted`** (cheie `kind:id`, Pas L0/L1.5) împiedică reluarea aceluiași id în aceeași comandă
   `/orchestrate`. Cele două straturi (retry intra-skill + `attempted` inter-rundă) garantează că un item
   stubborn se parchează, nu ciclează.

5. **Skip creativ.** Itemele cu `SKIP_TAG` (`[manual]`, case-insensitive în `title`/`description`) **nu intră
   niciodată în flotă** — excluse în Faza 1d, re-afirmat la filtrarea rundei (Pas L1.2). Sunt iteme
   creative/intangibile pe care muncitorii nu le pot rezolva; userul le scrie tag-ul din UI.

6. **Repo curat + `git=false` tratate (Faza 0).** Faza 0 **abortează** dacă `repo_path` are modificări
   necommittuite (`git status --porcelain` cod-zero cu stdout non-gol) sau dacă nu e repo git (cod non-zero).
   Pentru `git=false`, flota rulează **in-place serial, fără worktree, fără merge** (Pas C2) — nu se editează
   în paralel același working tree. Abort-ul e explicit, cu calea repo-ului și ce să facă userul.

### Cele 5 reguli incertitudine → park (regulile din promptul muncitorului)

Acestea sunt **regulile pe care fiecare muncitor le primește în prompt** (`round.workflow.js` `implementPrompt`,
linia „Reguli de incertitudine", oglindite în target-mode-ul fiecărui skill muncitor). Un muncitor care
lovește ORICARE dintre ele **NU ghicește** — întoarce `outcome="blocked"` cu un `question` clar pentru user:

1. **Prea vag** — itemul n-are un criteriu de acceptare verificabil (ce înseamnă „gata"?).
2. **Mai multe interpretări** — briefor admite citiri incompatibile, fără indiciu care e cea dorită.
3. **Acțiune ireversibilă** — fix-ul cere migrare DB / ștergere de date / push / trimitere în afară (vezi pct. 2
   de mai sus). Muncitorul descrie acțiunea în `question`, nu o execută.
4. **Retry-uri epuizate** — skill-ul și-a consumat cele max 3 cicluri fără verificare verde.
5. **Încredere mică** — muncitorul nu e sigur de corectitudine (regresie probabilă, root-cause neclar).

Cele 5 sunt enunțate identic în firul muncitorului și aici — o singură sursă de adevăr. Park-ul rezultat duce
întrebarea la user prin raportul final (Pas R2), niciodată printr-un `AskUserQuestion` din sandbox.

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
| Cleanup worktree la PARK cu muncă reală | Pierzi munca muncitorului care trebuie reluată manual | PARK păstrează worktree+branch **dacă `rev-list HEAD..orch/<id>` > 0**; cleanup la merge reușit SAU la block gol (Pas C6, `worktrees.md`) |
| A ține worktree-uri goale la PARK | Block-urile de la Stage 1 lasă worktree-uri fără commit-uri — gunoi care nu se reia | La PARK verifică `rev-list --count HEAD..orch/<id>`; `0` → CLEANUP, `>0` → PĂSTREAZĂ (Pas C6) |
| Fan-out paralel pe `git=false` | Nu poți edita în paralel același working tree fără izolare | `git=false` → in-place **serial**, fără merge (Pas C2) |
| Merge pe `outcome` fără să verifici `verified` | Un verde cu verificator mort (passthrough) arată byte-identic cu un verde real → aterizezi cod NEVERIFICAT | Merge DOAR dacă `outcome ∈ {fixed,done}` **ȘI `verified===true`**; altfel PARK „verificare lipsă/eșuată" (Pas C5.1) |
| A ignora ID-urile trimise-dar-neîntoarse | Un muncitor mort lasă un worktree orfan + branch `orch/<id>` care nu se curăță niciodată | Reconciliere `sent` vs `returned` la C5.0: curăță worktree-ul orfan la calea deterministă |
| A NU adăuga itemele procesate în `attempted` | Bucla ar reprocesa la nesfârșit același id → buclă infinită | La Pas L1.5 adaugă cheia `kind:id` în `attempted` pentru FIECARE item trimis, indiferent de soartă |
| A adăuga amânatele (coliziune de zonă) în `attempted` | Itemele amânate n-ar mai fi reluate niciodată — s-ar pierde | Amânatele NU intră în `attempted` (Pas L1.3); reintră în runda următoare când zona lor e liberă |
| A regenera `run_id` per rundă | Worktree-uri împrăștiate pe mai multe dir-uri; `attempted` resetat → buclă | Generează `run_id` O SINGURĂ DATĂ la Pas L0; refolosește-l în **toate** rundele (Pas C0) |
| A parca un `testplan` cu `ensureFocusRow` / INSERT în `tt_focus_tasks` | Test planurile sunt virtual-first — nu au focus row; `source_type='test_plan'` nu se insertează | La `kind='testplan'` parkul = NUMAI `UPDATE tt_test_plans SET description=...`; sari `ensureFocusRow` (Pas C6) |
| A chema `AskUserQuestion` din `round.workflow.js` | Sandbox-ul Workflow e mut — apelul aruncă / e ignorat; userul nu vede întrebarea | `AskUserQuestion` DOAR în firul principal: o dată up-front (Pas T2), o dată la final (Pas R2) |
| A întreba userul în mijlocul buclei (per item) | Spam de prompturi; rupe fluxul full-auto | Strânge întrebările și pune-le în LOT: un singur `AskUserQuestion` up-front, unul la final |
| A construi auto-resume în-invocare după răspunsuri | Complexitate inutilă; design-ul cere resume amânat | Pas R3: append răspuns în `description` + deblochează cardul; o rulare VIITOARE îl prinde |
| A merge-ui un item `no_worktree` (auto-running-test-plans) | N-are diff de cod; nu există branch de merge-uit | Conductorul sare merge-ul pentru `no_worktree`; rezultatul lui (rulare) informează doar runda următoare |
| A auto-executa o acțiune ireversibilă raportată de muncitor | Migrare/ștergere/push ireversibil aplicat fără acordul userului | Muncitorul o întoarce ca `blocked`+`question`; conductorul PARCHEAZĂ, nu execută (Plase de siguranță pct. 2) |
