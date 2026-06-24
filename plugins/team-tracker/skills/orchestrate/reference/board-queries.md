# Board Queries — Dispecerul

SQL-uri parametrizate pe `:pid` (`project_id`). Rulează toate prin `mcp__supabase-mcp-server__execute_sql`
(project ref `ntjzghsbrzkvpkniotaj`). Înlocuiește `:pid` cu valoarea numerică reală înainte de execuție
(Supabase MCP nu suportă placeholder-uri — interpolează direct: `WHERE project_id = 1`).

> **Notă SKIP_TAG:** rezultatele sunt post-filtrate în firul principal pentru a exclude itemele al căror
> `title` sau `description` conține `SKIP_TAG=[manual]` (case-insensitive) — SQL-ul însuși nu filtrează
> această etichetă.

---

## Citire board (Faza 1 — read-only)

### BUGS de lucru

```sql
-- BUGS de lucru
SELECT id, title, description, priority, status, effort, image_urls, created_at, updated_at
FROM tt_bugs
WHERE project_id = :pid AND status IN ('Open','In Progress') AND COALESCE(is_archived,false)=false
ORDER BY CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 ELSE 5 END, created_at;
```

Întoarce bugurile active pentru proiect, ordonate după prioritate apoi dată.
`status IN ('Open','In Progress')` — valorile exacte din `tt_bugs.status`; nu folosi lowercase.

### FEATURES de lucru

```sql
-- FEATURES de lucru
SELECT id, title, description, type, priority, status, effort, image_urls, created_at, updated_at
FROM tt_features
WHERE project_id = :pid AND status IN ('Propus','Planificat','În Focus') AND COALESCE(is_archived,false)=false
ORDER BY CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 ELSE 5 END, created_at;
```

`status IN ('Propus','Planificat','În Focus')` — valorile exacte; `'Gata'` înseamnă terminat, nu de lucru.

### TEST PLANS + agregarea itemelor

```sql
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

Coloana derivată `testPlanColumn` (calculată în firul principal după query):
- `fail+blocked > 0` → muncă pentru `resolving-failed-test-plans`
- `test_type='ai' AND pending > 0` → muncă pentru `auto-running-test-plans`
- `total > 0 AND fail=0 AND blocked=0 AND pending=0` → done; ignoră
- altfel (total=0 sau netestat) → ignoră (plan gol / uman pending)

**Tie-break categorie dublă:** când un test plan satisface simultan `fail+blocked > 0` ȘI
`test_type='ai' AND pending > 0`, se încadrează **exclusiv** la `resolving-failed-test-plans` —
problema activă (eșecuri/blocaje) are prioritate față de rularea pending.

---

## Write-back & Park (Faza 3 — scris în DB; adăugate în Milestone B)

> Aceste SQL-uri sunt incluse pentru referință completă. **Nu le executa în Milestone A** —
> dry-run-ul din A2 este strict read-only.

### DONE (bug) — trigger-ul mută cardul pe coloana `done`

```sql
-- DONE (bug): trigger-ul mută cardul pe 'done'
UPDATE tt_bugs SET status='Fixed', effort=:effort,
  description = description || E'\n\n--- Rezolvat :date (Dispecer) ---\n:summary', updated_at=NOW()
WHERE id=:id;
```

### DONE (feature)

```sql
-- DONE (feature)
UPDATE tt_features SET status='Gata', effort=:effort,
  description = description || E'\n\n--- Rezolvat :date (Dispecer) ---\n:summary', updated_at=NOW()
WHERE id=:id;
```

### PARK — notă pe sursă + card blocat

Substituie `:table` cu `tt_bugs` dacă `kind='bug'`, sau `tt_features` dacă `kind='feature'`.

```sql
-- PARK pas 1: notă pe rândul sursă
-- (înlocuiește :table cu tt_bugs dacă kind='bug', sau tt_features dacă kind='feature')
UPDATE tt_bugs SET description = description || E'\n\n--- Parcat :date (Dispecer) ---\n:reason', updated_at=NOW() WHERE id=:id;
-- sau, dacă kind='feature':
-- UPDATE tt_features SET description = description || E'\n\n--- Parcat :date (Dispecer) ---\n:reason', updated_at=NOW() WHERE id=:id;
```

Logica `ensureFocusRow`:

1. Citește `focus_task_id` din rândul sursă.
2. Dacă `focus_task_id` este non-NULL:
   ```sql
   UPDATE tt_focus_tasks SET is_blocked=true, blocked_reason=:reason, updated_at=NOW() WHERE id=<focus_task_id>;
   ```
3. Dacă `focus_task_id IS NULL` → INSERT cu câmpurile obligatorii:
   - `title`, `description`, `project_id`
   - `status` = statusul sursei mapat: bug `Open`→`'todo'`, bug `In Progress`→`'in_progress'`; feature `Propus`/`Planificat`→`'todo'`, feature `În Focus`→`'in_progress'`
   - `priority` = număr: `Critical→1`, `High→2`, `Medium→3` (default), `Low→4`
   - `is_blocked=true`, `blocked_reason=:reason`
   - `source_type='bug'|'feature'`, `source_id=CAST(:id AS text)`
   - `order_index=0`, `created_at=NOW()`, `updated_at=NOW()`

   Valori valide pentru `tt_focus_tasks.status`: **exclusiv** `todo | in_progress | testing | done`. NU folosi `'focus'` sau `'blocked'`.

   Apoi leagă rândul sursă (înlocuiește `:table` cu `tt_bugs`/`tt_features` după `kind`):
   ```sql
   UPDATE tt_bugs SET focus_task_id=<noul id>, updated_at=NOW() WHERE id=:id;
   -- sau, dacă kind='feature':
   -- UPDATE tt_features SET focus_task_id=<noul id>, updated_at=NOW() WHERE id=:id;
   ```
