# Dispecerul (Orchestrator de Focus board) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un skill `/orchestrate <proiect>` care citește board-ul Focus, pornește o flotă de muncitori paraleli (skill-urile existente) în worktree-uri izolate, scrie testele la final, aterizează doar ce e verificat, parchează ce e nesigur, și mătură board-ul în runde până se golește — totul în Claude Code, pe abonamentul MAX.

**Architecture:** Două straturi. (1) **Conductor** = `SKILL.md` rulat în firul principal: rezolvă proiectul, citește board-ul, pune întrebările (la user, în chat), lansează câte un **Workflow per rundă**, face merge la worktree-urile verzi (secvențial), raportează, și buclează până se golește. (2) **Workflow** (script JS rulat de tool-ul `Workflow`) = o rundă headless: triază, fan-out de muncitori (fiecare în worktree-ul lui: implementează → verifică → scrie teste → commit în worktree), serializează verificarea-pe-preview printr-un lease, și întoarce rezultate structurate. Interacțiunea cu userul (întrebări) stă DOAR în firul principal; Workflow-ul e mut.

**Tech Stack:** Claude Code skills (Markdown `SKILL.md`), tool-ul `Workflow` (JS în sandbox), Supabase MCP (`mcp__supabase-mcp-server__execute_sql` / `apply_migration`), Claude Preview MCP (`mcp__Claude_Preview__*`), `git worktree`, skill-urile existente `resolving-tt-bugs` / `resolving-tt-features` / `resolving-failed-test-plans` / `auto-running-test-plans` / `writing-ai-test-plans` / `writing-tester-test-plans`.

---

## Model de testare (citește înainte de toate)

Livrabilul e un **skill Claude Code** (instrucțiuni Markdown + un script de Workflow + un JSON de config + mici editări la skill-uri surori). Nu are cod clasic unit-testabil: scriptul de Workflow rulează **doar** în harness (sandbox, fără filesystem/Node API, fără `import`), iar restul e prompt/prose pe care le execută Claude. Deci **„testul" fiecărui task e un acceptance check concret** — o aserțiune pe output-ul de dry-run, un rezultat de query MCP, sau o rulare live păzită — **nu** pytest/node-test. Unde apare logică pură rulabilă standalone, o testăm cu `node --test`; în v1 nu există așa ceva semnificativ, deci verificăm prin observație. Acceptance check-urile de mai jos sunt scrise să fie neambigue (comandă exactă + ce trebuie să vezi).

## Decizii rezolvate pentru v1 (închid §14 din spec)

1. **Override pe skill-uri** = parametri expliciți. Conductorul pasează muncitorului `TARGET_PROJECT_ID`, `TARGET_SOURCE_ROOT` (calea worktree-ului) și `TARGET_ITEM_ID`; skill-ul, dacă-i primește, **sare peste Step 0 (auto-detecția din cwd) și peste clasificarea în masă**, procesând un singur rând. Fallback: worktree-urile se numesc cu slug-ul proiectului ca basename, deci Step 0 rezolvă corect și fără override.
2. **`resolving-tt-features` Step 5** = task de verificat-și-oglindit (Task B5). Dacă lipsește, îl adăugăm copiind tabelul din `resolving-tt-bugs`.
3. **Iteme „creative" / intangibile** = se sar itemele al căror `title` sau `description` conține tokenul `[manual]` (case-insensitive). Constantă configurabilă `SKIP_TAG`. (Fără migrare; userul îl scrie din UI.)
4. **Preview MCP multi-server (model B)** = amânat la v2. v1 = un singur lease pe preview.
5. **Plafon de concurență** = `SOFT_CAP = min(6, engineCap)`, unde `engineCap = min(16, nuclee-2)` îl impune motorul Workflow oricum. Configurabil.
6. **Worktrees pe Windows** = sub `C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId>`, branch `orch/<itemId>`; curățate la merge/abandon.

## Constante (referențiate de taskuri)

| Nume | Valoare |
|---|---|
| `SKILLS_DIR` | `C:/Users/lakie/Desktop/team-tracker-skills/plugins/team-tracker/skills` |
| `ORCH_DIR` | `<SKILLS_DIR>/orchestrate` |
| `SUPABASE_REF` | `ntjzghsbrzkvpkniotaj` |
| Supabase MCP | `mcp__supabase-mcp-server__execute_sql`, `mcp__supabase-mcp-server__apply_migration` |
| Preview MCP | `mcp__Claude_Preview__*` (start/list/click/fill/snapshot/inspect/screenshot/console_logs) |
| Exemplu entry | `betro`: `project_id=1`, repo `C:/Users/lakie/Desktop/BETRO`, `git=true`, preview `vite-dev:3000` — valorile reale vin din `projects.json` (slug, project_id, repo_path, git, preview_name, preview_port) |
| Worktrees root | `C:/Users/lakie/Desktop/.orch-worktrees` |
| `SKIP_TAG` | `[manual]` |
| `SOFT_CAP` | `min(6, min(16, cores-2))` |

### Statusuri reale (din `team-tracker/src/lib/api.ts`)

- **bugs** `tt_bugs.status` ∈ `Open · In Progress · Fixed · Closed`. **De lucru** = `Open, In Progress`. „Gata" = `Fixed`.
- **features** `tt_features.status` ∈ `Propus · Planificat · În Focus · Gata`. **De lucru** = `Propus, Planificat, În Focus`. „Gata" = `Gata`.
- **test plans** `tt_test_plans` (+ `tt_test_items.result` ∈ `pass · fail · blocked · pending`), `test_type` ∈ `ai · human`, `is_archived`. Coloană derivată (vezi `testPlanColumn`): toate `pass` → done; rămase `fail/blocked` după ce toate sunt testate → `test_issues`; parțial testat → `testing`; netestat → `todo`.
  - **Muncă `resolving-failed-test-plans`** = planuri ne-arhivate cu ≥1 item `fail` sau `blocked`.
  - **Muncă `auto-running-test-plans`** = planuri `test_type='ai'`, ne-arhivate, cu ≥1 item `pending`.
- **Write-back „gata"**: un UPDATE pe `tt_bugs.status='Fixed'` / `tt_features.status='Gata'` mută automat cardul pe coloana `done` (trigger DB — confirmat în `api.ts:468`). Deci write-back-ul = doar update pe rândul-sursă.
- **Park (te-așteaptă)**: (a) append notă în `description`-ul sursei (ca skill-urile), ȘI (b) pune cardul Focus `is_blocked=true, blocked_reason=...` (creează rândul `tt_focus_tasks` dacă lipsește — vezi `ensureFocusRow`).

---

## File Structure

| Fișier | Responsabilitate | Task |
|---|---|---|
| `<ORCH_DIR>/SKILL.md` | Conductorul: instrucțiuni pas-cu-pas pentru firul principal (resolve → plan → întrebări → buclă de runde → merge → raport) | A2, B6, C4, D2, D4 |
| `<ORCH_DIR>/projects.json` | Registru: slug → `{project_id, repo_path, preview_name, preview_port}` | A1 |
| `<ORCH_DIR>/round.workflow.js` | Scriptul de Workflow al unei runde (triază + fan-out + lease preview + rezultate) | C1, C2, D1 |
| `<ORCH_DIR>/reference/board-queries.md` | SQL-urile exacte de citit board-ul + write-back + park | A2, D3 |
| `<ORCH_DIR>/reference/worktrees.md` | Comenzile git worktree (create / merge / cleanup) pentru firul principal | C3 |
| `<SKILLS_DIR>/resolving-tt-bugs/SKILL.md` | + bloc „Orchestrator target mode" (single-item override) | B1 |
| `<SKILLS_DIR>/resolving-tt-features/SKILL.md` | + override + verifică Step 5 | B5 |
| `<SKILLS_DIR>/resolving-failed-test-plans/SKILL.md` | + override single-item | D5 |
| `<SKILLS_DIR>/auto-running-test-plans/SKILL.md` | + override single-item | D5 |
| `<ORCH_DIR>/.claude-plugin` notă | înregistrarea skill-ului în pluginul team-tracker (dacă e nevoie) | A2 |

---

# Milestone A — Fundație read-only + dry-run

**Rezultat livrabil & testabil:** `/orchestrate betro --dry-run` rezolvă proiectul, citește board-ul, și **printează lista de muncă + ce muncitori/prompturi AR porni**, fără să atingă cod. Nimic distructiv.

### Task A1: Registrul de proiecte

**Files:**
- Create: `<ORCH_DIR>/projects.json`

- [ ] **Step 1: Scrie registrul (8 intrări — toate proiectele cu repo local)** [completat]

```json
{
  "betro": {
    "project_id": 1,
    "repo_path": "C:/Users/lakie/Desktop/BETRO",
    "preview_name": "vite-dev",
    "preview_port": 3000
  }
}
```

- [ ] **Step 2: Acceptance — rezolvarea funcționează**

Verifică manual: `betro` → `project_id=1`, `repo_path` există.
Run: `node -e "const m=require('C:/Users/lakie/Desktop/team-tracker-skills/plugins/team-tracker/skills/orchestrate/projects.json'); console.log(Object.keys(m).length, m.padel_team.project_id, m.culcush.git, m.popicu_tips.preview_name)"`
Expected: `8 12 false null`

- [ ] **Step 3: Commit**

```bash
git -C C:/Users/lakie/Desktop/team-tracker-skills add plugins/team-tracker/skills/orchestrate/projects.json
git -C C:/Users/lakie/Desktop/team-tracker-skills commit -m "feat(orchestrate): project registry"
```

### Task A2: SKILL.md scaffold + Faza 0 (resolve) + dry-run read

**Files:**
- Create: `<ORCH_DIR>/SKILL.md`
- Create: `<ORCH_DIR>/reference/board-queries.md`

- [ ] **Step 1: Scrie `board-queries.md` cu cele 3 query-uri de muncă (exacte)**

Conținut obligatoriu — trei blocuri SQL parametrizate pe `:pid`:

```sql
-- BUGS de lucru
SELECT id, title, description, priority, status, effort, image_urls, created_at, updated_at
FROM tt_bugs
WHERE project_id = :pid AND status IN ('Open','In Progress') AND COALESCE(is_archived,false)=false
ORDER BY CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 ELSE 5 END, created_at;

-- FEATURES de lucru
SELECT id, title, description, type, priority, status, effort, image_urls, created_at, updated_at
FROM tt_features
WHERE project_id = :pid AND status IN ('Propus','Planificat','În Focus') AND COALESCE(is_archived,false)=false
ORDER BY CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 ELSE 5 END, created_at;

-- TEST PLANS + agregarea itemelor (clasificare în firul principal)
SELECT p.id, p.title, p.description, p.priority, p.test_type, p.is_archived,
       COUNT(i.*) FILTER (WHERE i.result='pending') AS pending,
       COUNT(i.*) FILTER (WHERE i.result='fail')    AS fail,
       COUNT(i.*) FILTER (WHERE i.result='blocked') AS blocked,
       COUNT(i.*) AS total
FROM tt_test_plans p LEFT JOIN tt_test_items i ON i.test_plan_id = p.id
WHERE p.project_id = :pid AND COALESCE(p.is_archived,false)=false
GROUP BY p.id;
```

Plus regula de mapare (text): `fail+blocked>0` → `resolving-failed-test-plans`; `test_type='ai' AND pending>0` → `auto-running-test-plans`; altfel → ignoră (deja done / uman pending).

- [ ] **Step 2: Scrie `SKILL.md` — frontmatter + Faza 0 + Faza 1(citire) + modul dry-run**

`SKILL.md` trebuie să conțină EXACT secțiunile (autor: scrie prose concretă pentru fiecare):
- **Frontmatter** `name: orchestrate`, `description:` cu triggere („/orchestrate", „dă-i la tot <proiect>", „apucă-te de tot de pe Focus", „orchestrate betro").
- **Argumente**: `<proiect>` (slug din `projects.json`), flag-uri `--dry-run`, `--max-rounds N` (default 6).
- **Faza 0 — Resolve**: citește `projects.json`, ia `project_id`, `repo_path`, `preview_name`. Dacă slug-ul lipsește → abort cu o linie. Confirmă `repo_path` există și e repo git curat (`git -C <repo> status --porcelain`); dacă are modificări necommittuite → abort („repo murdar; commit/stash întâi").
- **Faza 1 — Citește board-ul**: rulează cele 3 query-uri din `board-queries.md` cu `:pid`. Exclude itemele cu `SKIP_TAG` în title/description. Construiește lista de muncă: `[{kind, id, title, priority, status, worker_skill}]`.
- **Mod `--dry-run`**: printează (a) tabel cu lista de muncă, (b) pentru fiecare item, ce `worker_skill` ar rula și un rezumat de 1 rând al promptului. NU lansează niciun Workflow, NU scrie nimic. Termină.

- [ ] **Step 3: Acceptance — dry-run pe BetRO**

Invocă `/orchestrate betro --dry-run` în firul principal (din orice cwd).
Expected: un tabel cu bug-urile `Open/In Progress`, features `Propus/Planificat/În Focus`, și planurile de test cu probleme/pending ale proiectului 1; fiecare cu skill-ul muncitor mapat; zero scrieri în DB; zero worktrees.
Cross-check: numărul de bug-uri din tabel = rezultatul query-ului BUGS rulat direct prin Supabase MCP.

- [ ] **Step 4: Commit**

```bash
git -C C:/Users/lakie/Desktop/team-tracker-skills add plugins/team-tracker/skills/orchestrate/SKILL.md plugins/team-tracker/skills/orchestrate/reference/board-queries.md
git -C C:/Users/lakie/Desktop/team-tracker-skills commit -m "feat(orchestrate): skill scaffold + board read + dry-run"
```

---

# Milestone B — Un muncitor end-to-end (bugs, serial, fără worktree)

**Rezultat livrabil & testabil:** `/orchestrate betro --only bug:<id>` ia UN bug, îl rezolvă prin `resolving-tt-bugs` în target-mode, verifică, scrie testul recomandat, marchează `Fixed` sau parchează. Rulează direct în repo (worktree-urile vin în C). Dovedește cuplajul cu skill-ul existent.

### Task B1: Adaugă „Orchestrator target mode" la `resolving-tt-bugs`

**Files:**
- Modify: `<SKILLS_DIR>/resolving-tt-bugs/SKILL.md` (adaugă o secțiune nouă, nu rescrie restul)

- [ ] **Step 1: Adaugă secțiunea „## Orchestrator target mode (single item)" la final**

Conținut obligatoriu (prose concretă):
> Dacă invocarea primește `TARGET_PROJECT_ID`, `TARGET_SOURCE_ROOT` și `TARGET_ITEM_ID` (din Dispecer):
> - **Sari peste Step 0** (auto-detecția din cwd): folosește `TARGET_PROJECT_ID` ca `<project_id>` și `TARGET_SOURCE_ROOT` ca `<source_root>`.
> - **Sari peste Step 2** (clasificarea în masă): procesează DOAR rândul `id = TARGET_ITEM_ID` (rulează aceeași interogare dar cu `AND id = TARGET_ITEM_ID`).
> - Restul flow-ului (3a–3e, verificare, effort, Step 5) e identic.
> - **Nu** porni/reporni preview-ul dacă `TARGET_PREVIEW_SERVER_ID` e dat — refolosește-l (lease-ul e deținut de Dispecer).
> - **Nu** printa raportul Step 4 în masă; întoarce un rezultat structurat (vezi mai jos) ca ULTIM mesaj.
> - **Output structurat** (ultimul mesaj, JSON): `{ "item_id", "outcome": "fixed|blocked", "verify_channel": "preview|sql|none", "test_recommendation": "ai|human|both|none", "effort", "summary", "question": "<dacă blocked: ce-ți trebuie de la user>" }`.

- [ ] **Step 2: Acceptance — citire, nu execuție**

Verifică textual: secțiunea există, definește toți cei 3 parametri, și formatul JSON de output cu cheile exacte `item_id, outcome, verify_channel, test_recommendation, effort, summary, question`.
(Nu rulăm încă — execuția e testată în B6.)

- [ ] **Step 3: Commit**

```bash
git -C C:/Users/lakie/Desktop/team-tracker-skills add plugins/team-tracker/skills/resolving-tt-bugs/SKILL.md
git -C C:/Users/lakie/Desktop/team-tracker-skills commit -m "feat(resolving-tt-bugs): orchestrator single-item target mode"
```

### Task B5: Oglindește la `resolving-tt-features` (override + Step 5)

**Files:**
- Modify: `<SKILLS_DIR>/resolving-tt-features/SKILL.md`

- [ ] **Step 1: Verifică dacă features are un Step 5 (recomandare testare)**

Run: `grep -n "writing-ai-test-plans\|Recomandare testare\|Step 5" C:/Users/lakie/Desktop/team-tracker-skills/plugins/team-tracker/skills/resolving-tt-features/SKILL.md`
Dacă nu apare → adaugă un Step 5 identic ca structură cu cel din `resolving-tt-bugs` (tabelul AI/Uman/Ambele/Niciunul + blocul „Recomandare testare").

- [ ] **Step 2: Adaugă aceeași secțiune „Orchestrator target mode"** ca la B1, cu output structurat identic (cheile la fel), dar `outcome: "done|blocked"` (features folosesc `Gata`, nu `Fixed`).

- [ ] **Step 3: Acceptance**

`grep` confirmă: secțiunea target mode există + există tabelul Step 5 cu cele 4 ramuri.

- [ ] **Step 4: Commit**

```bash
git -C C:/Users/lakie/Desktop/team-tracker-skills add plugins/team-tracker/skills/resolving-tt-features/SKILL.md
git -C C:/Users/lakie/Desktop/team-tracker-skills commit -m "feat(resolving-tt-features): target mode + ensure Step 5"
```

### Task B6: Conductor — execută UN bug end-to-end + pasul de teste + write-back/park

**Files:**
- Modify: `<ORCH_DIR>/SKILL.md` (adaugă Faza 2-simplă + Faza 3 pentru un singur item; flag `--only kind:id`)
- Modify: `<ORCH_DIR>/reference/board-queries.md` (adaugă write-back & park SQL)

- [ ] **Step 1: Adaugă în `board-queries.md` SQL-urile de write-back & park**

```sql
-- DONE (bug): trigger-ul mută cardul pe 'done'
UPDATE tt_bugs SET status='Fixed', effort=:effort,
  description = description || E'\n\n--- Rezolvat :date (Dispecer) ---\n:summary', updated_at=NOW()
WHERE id=:id;

-- DONE (feature)
UPDATE tt_features SET status='Gata', effort=:effort,
  description = description || E'\n\n--- Rezolvat :date (Dispecer) ---\n:summary', updated_at=NOW()
WHERE id=:id;

-- PARK: notă pe sursă + card blocat (creează cardul dacă lipsește)
UPDATE :table SET description = description || E'\n\n--- Parcat :date (Dispecer) ---\n:reason', updated_at=NOW() WHERE id=:id;
-- apoi asigură rând focus + blochează:
--   dacă tt_(bugs|features).focus_task_id IS NULL → INSERT tt_focus_tasks (source_type,source_id,title,project_id,status,priority...) și leagă focus_task_id;
--   apoi UPDATE tt_focus_tasks SET is_blocked=true, blocked_reason=:reason WHERE id=<focus_task_id>;
```

- [ ] **Step 2: Adaugă în `SKILL.md` flow-ul pentru `--only <kind>:<id>`**

Prose obligatorie:
- alege `worker_skill` după `kind` (bug→`resolving-tt-bugs`, feature→`resolving-tt-features`);
- dispatch UN subagent (`Agent` tool) cu promptul: skill-ul muncitor + `TARGET_PROJECT_ID=<pid>`, `TARGET_SOURCE_ROOT=<repo_path>` (în B fără worktree: chiar repo-ul), `TARGET_ITEM_ID=<id>`, descrierea itemului verbatim, și instrucția să întoarcă DOAR JSON-ul structurat;
- citește JSON-ul: dacă `outcome=fixed/done` → **execută pasul de teste** (vezi Step 3) → write-back DONE; dacă `outcome=blocked` → write-back PARK (notă + card blocat) cu `question`.

- [ ] **Step 3: Adaugă „pasul de teste" (execută recomandarea Step 5)**

Prose obligatorie: după un `outcome` reușit, mapează `test_recommendation`:
- `ai` → dispatch un subagent care rulează `/writing-ai-test-plans` scopat pe item (target mode similar);
- `human` → `/writing-tester-test-plans`;
- `both` → ambele;
- `none` → nimic.
Pasul ăsta rulează **în același worktree/sursă**, înainte de a marca itemul „gata", ca diff-ul să fie vizibil pentru skill-ul de scris teste.

- [ ] **Step 4: Acceptance — un bug real, păzit**

Alege un bug BetRO `Open` cu risc mic (UI/copy). Rulează `/orchestrate betro --only bug:<id>`.
Expected, în ordine: subagent rulează `resolving-tt-bugs` target-mode → întoarce JSON `outcome=fixed` → se scrie un plan de test AI (`tt_test_plans` are un rând nou `test_type='ai'` pentru item) → `tt_bugs.status='Fixed'` → cardul apare pe coloana `done` în team-tracker.
Verify SQL: `SELECT status,effort FROM tt_bugs WHERE id=<id>` → `Fixed`; `SELECT count(*) FROM tt_test_plans WHERE project_id=1 AND test_type='ai' AND created_at > now()-interval '10 min'` → ≥1.
Dacă bug-ul iese `blocked`: `tt_focus_tasks.is_blocked=true` + `blocked_reason` non-gol, iar `tt_bugs.status` rămâne `Open`.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/lakie/Desktop/team-tracker-skills add plugins/team-tracker/skills/orchestrate
git -C C:/Users/lakie/Desktop/team-tracker-skills commit -m "feat(orchestrate): single-item end-to-end + test step + writeback/park"
```

---

# Milestone C — Flotă: worktrees, paralelism, lease pe preview, grupare anti-conflict

**Rezultat livrabil & testabil:** o rundă reală: mai mulți muncitori în worktree-uri paralele, verificare-pe-preview serializată prin lease, merge secvențial al verzilor, park la conflict.

### Task C3: Helper worktrees pentru firul principal

**Files:**
- Create: `<ORCH_DIR>/reference/worktrees.md`

- [ ] **Step 1: Scrie comenzile exacte (create / merge-if-green / cleanup)**

```bash
# CREATE (per item) — branch nou din HEAD-ul curent al repo-ului
git -C <repo_path> worktree add -b orch/<itemId> C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId> HEAD

# MERGE-IF-GREEN (firul principal, secvențial) — după ce muncitorul a committuit în worktree
git -C <repo_path> merge --no-ff --no-edit orch/<itemId>     # conflict → ABORT + park
# la conflict:
git -C <repo_path> merge --abort

# CLEANUP (după merge reușit SAU abandon)
git -C <repo_path> worktree remove --force C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId>
git -C <repo_path> branch -D orch/<itemId>   # doar dacă merge-uit sau abandonat; la PARK păstrează branch-ul
```

Plus regula text: la **PARK** păstrăm worktree-ul + branch-ul (userul/relansarea îl reia); la **merge reușit** sau **abandon explicit** curățăm.

- [ ] **Step 2: Acceptance — un ciclu manual de worktree**

Run (păzit, pe BetRO):
```bash
git -C C:/Users/lakie/Desktop/BETRO worktree add -b orch/test-0 C:/Users/lakie/Desktop/.orch-worktrees/t/betro-0 HEAD
git -C C:/Users/lakie/Desktop/BETRO worktree list
git -C C:/Users/lakie/Desktop/BETRO worktree remove --force C:/Users/lakie/Desktop/.orch-worktrees/t/betro-0
git -C C:/Users/lakie/Desktop/BETRO branch -D orch/test-0
```
Expected: `worktree list` arată worktree-ul; după remove dispare; `BETRO` rămâne neatins pe branch-ul lui.

- [ ] **Step 3: Commit** (`feat(orchestrate): worktree lifecycle reference`)

### Task C1: Workflow-ul unei runde — triaj + fan-out (fără lease încă)

**Files:**
- Create: `<ORCH_DIR>/round.workflow.js`

- [ ] **Step 1: Scrie scheletul Workflow cu triaj + fan-out paralel**

Scriptul primește `args = { project_id, repo_path, preview_name, run_id, items: [{kind,id,title,description,worker_skill}], soft_cap }` și întoarce rezultate per item. Worktree-urile le creează **muncitorul** (prima lui acțiune), nu scriptul (scriptul n-are git).

```js
export const meta = {
  name: 'orchestrate-round',
  description: 'O rundă: fan-out de muncitori pe itemele unui proiect, fiecare în worktree-ul lui',
  phases: [{ title: 'Implement' }, { title: 'Verify' }],
}

const items = args.items
const WORKTREE_ROOT = 'C:/Users/lakie/Desktop/.orch-worktrees'

function workerPrompt(it) {
  const wt = `${WORKTREE_ROOT}/${args.run_id}/betro-${it.id}`
  return [
    `Rulează skill-ul ${it.worker_skill} în ORCHESTRATOR TARGET MODE pentru un singur item.`,
    `Prima ta acțiune: creează worktree-ul și lucrează DOAR în el:`,
    `  git -C ${args.repo_path} worktree add -b orch/${it.id} ${wt} HEAD`,
    `TARGET_PROJECT_ID=${args.project_id}`,
    `TARGET_SOURCE_ROOT=${wt}`,
    `TARGET_ITEM_ID=${it.id}`,
    `Item: [${it.kind} #${it.id}] ${it.title}`,
    `Descriere (brief canonic): ${it.description}`,
    `Reguli de incertitudine: dacă e prea vag / mai multe interpretări / acțiune ireversibilă (migrare DB, ștergere, push, trimis în afară) / skill-ul și-a epuizat retry-urile / încredere mică — NU ghici: întoarce outcome="blocked" cu o întrebare clară.`,
    `La final, COMMIT în worktree dacă ai schimbat ceva: git -C ${wt} add -A && git -C ${wt} commit -m "orch: <item>".`,
    `Întoarce DOAR JSON-ul structurat din contractul skill-ului (item_id, outcome, verify_channel, test_recommendation, effort, summary, question, worktree="${wt}", branch="orch/${it.id}").`,
  ].join('\n')
}

const RESULT_SCHEMA = {
  type: 'object',
  required: ['item_id','outcome'],
  properties: {
    item_id: { type: 'number' }, outcome: { enum: ['fixed','done','blocked'] },
    verify_channel: { enum: ['preview','sql','none'] },
    test_recommendation: { enum: ['ai','human','both','none'] },
    effort: { type: 'string' }, summary: { type: 'string' },
    question: { type: 'string' }, worktree: { type: 'string' }, branch: { type: 'string' },
  },
}

const results = await parallel(items.map(it => () =>
  agent(workerPrompt(it), { label: `${it.kind}:${it.id}`, phase: 'Implement', schema: RESULT_SCHEMA })
))
return results.filter(Boolean)
```

- [ ] **Step 2: Acceptance — fan-out pe 2 iteme mici**

Lansează `round.workflow.js` cu `args.items` = 2 bug-uri BetRO independente (zone de cod diferite). Urmărește `/workflows`.
Expected: 2 muncitori în paralel sub „Implement", fiecare creează worktree-ul lui (`git worktree list` arată 2), fiecare întoarce JSON valid (schema trece). `BETRO` rămâne pe branch-ul original (muncitorii commit în branch-urile lor `orch/*`).

- [ ] **Step 3: Commit** (`feat(orchestrate): round workflow — triage + parallel fan-out`)

### Task C2: Lease pe preview (serializează verificarea-pe-preview)

**Files:**
- Modify: `<ORCH_DIR>/round.workflow.js`

- [ ] **Step 1: Separă verificarea în două căi — SQL paralel, preview serial**

Schimbă contractul: muncitorul **implementează + commit**, dar **NU verifică pe preview**; întoarce `needs_preview: true|false` (true dacă `verify_channel='preview'`). Apoi în script:

```js
// Stage 1: implement (parallel) — fără verificare pe preview
const impl = (await parallel(items.map(it => () =>
  agent(implementPrompt(it), { label: `${it.kind}:${it.id}`, phase: 'Implement', schema: RESULT_SCHEMA })
))).filter(Boolean)

// Stage 2a: itemele cu verificare SQL — paralel (n-au resursă comună)
const sqlItems = impl.filter(r => r.verify_channel === 'sql' && r.outcome !== 'blocked')
const sqlVerified = await parallel(sqlItems.map(r => () =>
  agent(verifyPrompt(r, 'sql'), { label: `verify-sql:${r.item_id}`, phase: 'Verify', schema: RESULT_SCHEMA })
))

// Stage 2b: itemele cu preview — SERIAL (lease unic pe preview :3000)
const previewItems = impl.filter(r => r.needs_preview && r.outcome !== 'blocked')
const previewVerified = []
for (const r of previewItems) {                 // un singur muncitor pe preview la un moment dat
  previewVerified.push(await agent(verifyPrompt(r, 'preview'), { label: `verify-prev:${r.item_id}`, phase: 'Verify', schema: RESULT_SCHEMA }))
}
return [...impl.filter(r => r.outcome === 'blocked'), ...sqlVerified.filter(Boolean), ...previewVerified.filter(Boolean)]
```

`verifyPrompt(r,'preview')` spune muncitorului: pornește/folosește preview-ul `vite-dev:3000`, conduce checkul în worktree-ul lui `r.worktree`, întoarce `outcome` actualizat.

- [ ] **Step 2: Acceptance — două iteme UI verifică pe rând, nu simultan**

Lansează runda cu 2 bug-uri UI. În `/workflows`, faza „Verify" pentru cele două preview-uri trebuie să fie **secvențială** (unul după altul), nu suprapusă; cele SQL (dacă există) rulează paralel.

- [ ] **Step 3: Commit** (`feat(orchestrate): preview lease — serial preview verify, parallel SQL`)

### Task C4: Conductor — lansează runda, merge secvențial verzii, park la conflict

**Files:**
- Modify: `<ORCH_DIR>/SKILL.md`
- Modify: `<ORCH_DIR>/reference/board-queries.md` (reutilizează write-back/park din B)

- [ ] **Step 1: Adaugă „Faza 2-3 (rundă completă)" în SKILL.md**

Prose obligatorie:
- **grupare anti-conflict**: înainte de fan-out, grupează itemele după zona de cod estimată (din titlu/descriere); itemele care ating probabil aceleași fișiere **nu intră în aceeași rundă** (se amână în runda următoare). Restul → `args.items`, plafonate la `SOFT_CAP`.
- lansează `round.workflow.js` cu `args`;
- pe rezultate: pentru fiecare `outcome` verde → **pasul de teste** (din B Step 3, dar acum în worktree) → `git merge --no-ff orch/<id>` în repo (secvențial); **conflict → `merge --abort` + PARK** itemul cu `question="conflict de merge pe <fișiere>; rezolvă manual"`; merge reușit → cleanup worktree + write-back DONE;
- `outcome=blocked` → PARK (păstrează worktree-ul) + write-back notă/card.

- [ ] **Step 2: Acceptance — rundă pe 3 iteme, una forțată în conflict**

Pregătește 3 bug-uri: 2 pe zone diferite, 2 care ating intenționat același fișier (ca să forțezi un conflict la al doilea merge). Rulează `/orchestrate betro` (fără dry-run), dar limitat la cele 3 (`--only`-multiplu sau un proiect de test).
Expected: cele independente → `Fixed` + worktree curățat; perechea-conflict → primul `Fixed`, al doilea **parcat** cu `blocked_reason` despre conflict, `BETRO` rămâne curat (fără merge pe jumătate), worktree-ul parcat încă există.

- [ ] **Step 3: Commit** (`feat(orchestrate): full round — anti-conflict grouping, sequential merge, park-on-conflict`)

---

# Milestone D — Toate tipurile, buclă-până-se-golește, pâlnia de întrebări, raport, guvernare

**Rezultat livrabil & testabil:** `/orchestrate betro` complet: bug-uri + features + teste, în runde, până se golește; întrebările strânse și puse userului; raport final; toate plasele de siguranță.

### Task D5: Target mode la `resolving-failed-test-plans` și `auto-running-test-plans`

**Files:**
- Modify: `<SKILLS_DIR>/resolving-failed-test-plans/SKILL.md`
- Modify: `<SKILLS_DIR>/auto-running-test-plans/SKILL.md`

- [ ] **Step 1:** Adaugă la fiecare aceeași secțiune „Orchestrator target mode" (cu `TARGET_ITEM_ID` = `test_plan_id`), output structurat cu aceleași chei (`outcome ∈ done|blocked`, `test_recommendation='none'` — testele nu nasc alte teste).
- [ ] **Step 2: Acceptance** — `grep` confirmă secțiunea + contractul JSON în ambele fișiere.
- [ ] **Step 3: Commit** (`feat(test-plan skills): orchestrator target mode`)

### Task D1: Workflow — suportă toate cele 4 tipuri de muncitor

**Files:**
- Modify: `<ORCH_DIR>/round.workflow.js`

- [ ] **Step 1:** `workerPrompt`/`implementPrompt` aleg skill-ul după `it.worker_skill` (deja vine din triaj). Testele (`auto-running-test-plans`) nu editează cod → fără worktree, fără merge: marchează `it.no_worktree=true` și sari peste git pentru ele.
- [ ] **Step 2: Acceptance** — o rundă cu câte un item din fiecare tip (1 bug, 1 feature, 1 failed-test-plan, 1 pending-ai-test-plan) întoarce 4 JSON-uri valide; cel de `auto-running` nu creează worktree.
- [ ] **Step 3: Commit** (`feat(orchestrate): all four worker types in a round`)

### Task D2: Buclă-până-se-golește + anti-buclă-infinită

**Files:**
- Modify: `<ORCH_DIR>/SKILL.md`

- [ ] **Step 1: Adaugă „Faza buclă (runde)" în SKILL.md**

Prose obligatorie:
- ține un set `attempted` (chei `kind:id`) pe `run_id`;
- **rundă** = citește board-ul → scoate `attempted` și `SKIP_TAG` și parcatele → grupare anti-conflict → lansează workflow → merge/park/write-back → adaugă procesatele în `attempted`;
- **repetă** cât: (a) runda a produs ≥1 item nou acționabil, ȘI (b) `rounds < --max-rounds`, ȘI (c) nu s-a atins rate-limit;
- **stop** când o rundă completă nu mai are iteme noi (tot ce rămâne e parcat/attempted) sau s-a atins plafonul.
- Notă: testele AI scrise într-o rundă apar ca `pending-ai` în runda următoare → `auto-running-test-plans` → eventualele `fail` → `resolving-failed-test-plans` (bucla de calitate). `attempted` previne reluarea la infinit a aceluiași item în aceeași comandă.

- [ ] **Step 2: Acceptance — bucla se închide**

Rulează `/orchestrate betro --max-rounds 3` pe un board mic. Urmărește: runda 1 rezolvă bug-uri + scrie teste AI; runda 2 rulează acele teste AI (apar ca pending) și rezolvă eventualele fail; runda 3 (sau mai devreme) raportează „nimic nou acționabil" și se oprește. Nu reia un item deja `Fixed`.

- [ ] **Step 3: Commit** (`feat(orchestrate): loop-until-dry with attempted-set guard`)

### Task D4: Pâlnia de întrebări (lot la început + la final) + raport

**Files:**
- Modify: `<ORCH_DIR>/SKILL.md`

- [ ] **Step 1: Întrebări up-front**

Prose: în triaj, itemele clar ambigue NU intră în flotă; se strâng întrebările lor și, **înainte de prima rundă**, se pun userului printr-un singur `AskUserQuestion` (în firul principal). Răspunsurile se țes în promptul muncitorului. Dacă nu-s ambigue → pornește direct.

- [ ] **Step 2: Întrebări parcate + raport final**

Prose: după ce buclele se opresc, printează raportul:
```
Dispecer — <proiect> — <data>
✅ Făcute & merge-uite (N):  - [kind #id] titlu → summary (commit)
⏸️ Parcate pentru tine (M):  - [kind #id] titlu → întrebarea/blocajul concret
❌ Picate (K):               - [kind #id] titlu → motiv
Runde: R · worktrees parcate: <căi>
```
Apoi, dacă există parcate cu `question`, pune-le în lot printr-un `AskUserQuestion`. (Reluarea — rularea de reluare — e v1.1: deocamdată raportul listează ce-i de deblocat.)

- [ ] **Step 3: Acceptance — un board cu un item intenționat ambiguu**

Adaugă un bug cu titlu vag (ex. „fă mai bine pagina"). Rulează `/orchestrate betro`.
Expected: înainte de flotă, `AskUserQuestion` întreabă despre bug-ul vag; restul rulează; la final raportul are secțiunea „Parcate" dacă ceva a ieșit blocked; cardurile parcate apar `is_blocked` în team-tracker.

- [ ] **Step 4: Commit** (`feat(orchestrate): question funnel + final report`)

### Task D3: Guvernare — poarta pe ireversibile, plafon, anti-thrash (verifică firele)

**Files:**
- Modify: `<ORCH_DIR>/SKILL.md` (secțiune „## Plase de siguranță")

- [ ] **Step 1: Scrie secțiunea de guvernare (checklist explicit)**

Prose obligatorie, ca reguli numerotate:
1. **Verificarea = poarta spre merge**: niciun worktree nu se merge-uiește fără `outcome` verificat (preview/SQL). (Deja impus de flow; afirmă-l.)
2. **Poartă pe ireversibile**: dacă un muncitor raportează că fix-ul cere migrare DB / ștergere de date / push / trimis în afară → `outcome=blocked` cu `question` (nu execută). Dispecerul le pune userului; nu auto-merge.
3. **Plafon**: `SOFT_CAP` muncitori/rundă; `--max-rounds`; la rate-limit MAX → oprește lansările noi, termină ce-i în aer, raportează.
4. **Anti-thrash**: muncitorul respectă cele max 3 cicluri ale skill-ului; epuizate → `blocked`, nu reîncearcă la nesfârșit. `attempted` previne reluarea în aceeași comandă.
5. **Skip creativ**: itemele cu `SKIP_TAG` nu intră niciodată în flotă.
6. **Repo curat înainte**: Faza 0 abortează dacă `BETRO` are modificări necommittuite.

- [ ] **Step 2: Acceptance — poarta pe ireversibile**

Adaugă (sau alege) un item care necesită clar o migrare DB. Rulează `/orchestrate betro`.
Expected: itemul iese **parcat** cu o întrebare despre migrare, `tt_*.status` neschimbat, fără migrare aplicată (`SELECT count(*) FROM supabase_migrations.schema_migrations` neschimbat înainte/după).

- [ ] **Step 3: Commit** (`feat(orchestrate): governance rails — irreversible gate, caps, anti-thrash`)

---

## Self-Review (rulat după scriere, înainte de execuție)

**1. Acoperirea spec-ului** (spec §→task):
- §5 Faza 0/1 (resolve+citește) → A2 ✓
- §5 Faza 2 (fan-out, worktree) → C1, C3 ✓
- §5 Faza 3 (verify+land+teste+park) → B6, C2, C4, D4 ✓
- §5 Faza 4 (raport+întrebări) → D4 ✓
- §6 Paralelism A (lease preview, SQL paralel, grupare) → C2, C4 ✓
- §7 componente (skill A2/registry A1/adaptor B1,B5,D5/write-back B6/pâlnie D4) ✓
- §8 integrare (override+single-item+secvențial) → B1, B5, D5 ✓
- §9 guvernare (5 reguli + ireversibil + plafon + anti-thrash + skip creativ) → D3 ✓
- §10 buclă-până-se-golește + anti-infinit → D2 ✓
- §11 erori (conflict→park, preview down→park, repo murdar→abort) → C4, D3, A2 ✓
- §12 dry-run → A2 ✓
- Gap acceptat în v1: **rularea de reluare** (consumă răspunsurile la parcate și reia) e marcată v1.1 în D4 — raportul listează ce-i de deblocat, dar nu reia automat. De adăugat ca task D6 dacă userul o vrea în v1.

**2. Scan placeholder-uri:** fără „TBD/TODO"; fiecare task are fișiere exacte, comenzi exacte, și acceptance observabil. Secțiunile de `SKILL.md` sunt prose-artefacte → specificate prin „conținut obligatoriu" + acceptance, nu cod fals.

**3. Consistență de tip:** contractul JSON al muncitorului (`item_id, outcome, verify_channel, test_recommendation, effort, summary, question, worktree, branch`) e identic în B1/B5/D5 și în `RESULT_SCHEMA` (C1). `outcome` = `fixed` (bug) / `done` (feature, test-plan) / `blocked` — folosit consistent în write-back (B6) și buclă (D2).

> **Notă de scope:** dacă la execuție Milestone D pare prea mare pentru o singură sesiune, se poate tăia după Milestone C (orchestrator pe bug-uri+features, o rundă, cu merge/park) ca primă livrare, și D ca a doua. A/B/C/D sunt deja ordonate ca livrări succesive testabile.
