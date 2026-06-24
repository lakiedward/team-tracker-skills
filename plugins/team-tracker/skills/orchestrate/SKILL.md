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

Exemplu: `/orchestrate betro --dry-run` · `/orchestrate betro` · `/orchestrate betro --max-rounds 3`

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

- Dacă directorul nu există → abort: "repo_path '<repo_path>' nu există pe disc."
- Dacă comanda întoarce linii (modificări necommittuite) → abort: "Repo murdar: `<repo_path>` are
  modificări necommittuite. Commit sau stash întâi, apoi reîncearcă."
- Dacă e curat (output gol) → continuă.

Reține `project_id`, `repo_path`, `preview_name`, `preview_port` pentru restul rulării.

---

## Faza 1 — Citește board-ul

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

## Fazele 2–4 (Milestone B, C, D — neimplementate încă)

Fazele de execuție (lansare flotă, merge worktree-uri, buclă de runde, raport final, pâlnie de întrebări,
guvernare) vor fi adăugate în Milestone B–D. Înainte ca acestea să existe în fișier, invocarea fără
`--dry-run` trebuie să printeze:

```
Dispecer — modul de execuție completă nu este încă implementat (Milestone B+).
Rulează cu --dry-run pentru a vedea lista de muncă.
```

---

## Greșeli de evitat

| Greșeală | De ce contează | Fix |
|---|---|---|
| Lowercase pe statusuri | DB-ul folosește exact `Open`, `In Progress`, `Propus`, `Planificat`, `În Focus`, `Gata`, `Fixed` — case-sensitive în filtre UI | Hardcodează valorile exacte |
| `project_id` lipsă din query | Ai citi iteme din alte proiecte | Faza 0 îl rezolvă; include-l în FIECARE query |
| A rula dry-run cu Supabase MCP deconectat | Query-urile eșuează silenți | Step 0: ping `execute_sql` cu `SELECT 1` dacă ai dubii |
| A scrie în DB în dry-run | Dry-run-ul e promisiunea de „zero scrieri" | Faza 1 = SELECT-uri pure; niciun UPDATE/INSERT în dry-run |
| Să sari SKIP_TAG check | Itemele `[manual]` sunt creative/intangibile; muncitorii nu le pot rezolva | Filtrează după 1d, înaintea oricărei alte procesări |
| Abort silențios la repo murdar | Userul nu știe de ce nu s-a întâmplat nimic | Mesaj explicit cu calea repo-ului și ce să facă |
