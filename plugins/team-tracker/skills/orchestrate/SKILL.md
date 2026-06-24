---
name: orchestrate
description: Use when the user wants to run an automated sweep of the entire Focus board for a project — resolves the project, reads all open bugs, features, and test plans, and (in dry-run mode) prints a full work list with the worker skill that would be dispatched for each item, without writing anything. Triggers on "/orchestrate", "dă-i la tot <proiect>", "apucă-te de tot de pe Focus", "orchestrate betro", "rulează dispecerul pe <proiect>", "sweep tot board-ul", "procesează tot board-ul".
---

# Dispecerul (Orchestrator de Focus board)

Citește board-ul Focus al unui proiect, construiește lista de muncă, și (în modul complet) lansează o flotă de
muncitori paraleli în worktree-uri izolate. În **`--dry-run`**, se oprește după ce printează lista — zero scrieri,
zero worktree-uri, zero lansări de muncitori.

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

Dacă slug-ul **nu există** în registry → abort imediat:
> "Proiectul '<slug>' nu există în projects.json. Slug-uri disponibile: <lista cheilor>."

Dacă slug-ul există, extrage:
- `project_id` — numărul întreg de folosit în toate query-urile `tt_*`
- `repo_path` — calea absolută a repo-ului sursă
- `preview_name` — numele serverului de preview (ex. `vite-dev`)
- `preview_port` — portul (ex. `3000`)

**Verifică `repo_path`:**

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

Reține `project_id`, `repo_path`, `preview_name`, `preview_port` pentru restul rulării.

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
Descriere (brief canonic):
<description verbatim — copiată exact din rândul DB>

Instrucțiuni speciale:
- Sari peste Step 0 și Step 2 din flow-ul normal; folosește parametrii TARGET_* de mai sus.
- Procesează exclusiv rândul cu id=<id>.
- La final, întoarce DOAR JSON-ul structurat din contractul skill-ului (nu adăuga text în afara JSON-ului).
- Dacă acțiunea necesită o migrare DB / ștergere de date / push la remote / trimitere în afara sistemului
  → întoarce outcome="blocked" cu o întrebare clară despre acea acțiune ireversibilă (nu executa).
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
Asteaptă finalizarea subagentului/subagentelor de testare înainte de a continua la write-back.

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
```sql
UPDATE :table SET description = description || E'\n\n--- Parcat :date (Dispecer) ---\n:reason', updated_at=NOW() WHERE id=:id;
```
Unde `:reason` = valoarea `question` din JSON.

2. Asigură rândul focus și marchează blocat (`ensureFocusRow`):
   - Citește `focus_task_id` de pe rândul sursă.
   - Dacă `focus_task_id IS NULL` → INSERT în `tt_focus_tasks` cu
     `source_type='bug'|'feature'`, `source_id=:id`, `title=<titlul itemului>`,
     `project_id=<project_id>`, `status='focus'`, `priority=<prioritatea itemului>`;
     apoi UPDATE rândul sursă să seteze `focus_task_id=<noul id>`.
   - Execută:
     ```sql
     UPDATE tt_focus_tasks SET is_blocked=true, blocked_reason=:reason WHERE id=<focus_task_id>;
     ```

### Pas B7 — Raport final (mod `--only`)

Printează un raport concis:

```
Dispecer — --only <kind>:<id> — <slug> — <YYYY-MM-DD>

[<kind> #<id>] <titlu>
  Status:  <Fixed | Gata | Blocat>
  Outcome: <fixed | done | blocked>
  Efort:   <effort>
  Canal:   <verify_channel>
  Teste:   <test_recommendation> → <ce s-a lansat>
  Rezumat: <summary>
  <dacă blocked> Întrebare pentru user: <question>
```

---

## Fazele 2–4 complete (Milestone C, D — neimplementate încă)

Fazele de execuție completă (flotă de muncitori, worktree-uri izolate, merge secvențial, buclă de runde,
pâlnie de întrebări, raport final complet, guvernare) vor fi adăugate în Milestone C–D.
Înainte ca acestea să existe în fișier, invocarea fără `--dry-run` și fără `--only` trebuie să printeze:

```
Dispecer — modul de execuție completă (flotă) nu este încă implementat (Milestone C+).
Opțiuni disponibile acum:
  /orchestrate <slug> --dry-run          — citește board-ul și printează lista de muncă
  /orchestrate <slug> --only bug:<id>    — rezolvă un singur bug end-to-end
  /orchestrate <slug> --only feature:<id> — implementează un singur feature end-to-end
```

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
