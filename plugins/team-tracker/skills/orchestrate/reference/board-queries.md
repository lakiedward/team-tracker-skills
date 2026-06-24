# Board Queries — Dispecerul

SQL-uri parametrizate pe `:pid` (`project_id`). Rulează toate prin `mcp__supabase-mcp-server__execute_sql`
(project ref `ntjzghsbrzkvpkniotaj`). Înlocuiește `:pid` cu valoarea numerică reală înainte de execuție
(Supabase MCP nu suportă placeholder-uri — interpolează direct: `WHERE project_id = 1`).

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

```sql
-- PARK: notă pe sursă + card blocat (creează cardul dacă lipsește)
UPDATE :table SET description = description || E'\n\n--- Parcat :date (Dispecer) ---\n:reason', updated_at=NOW() WHERE id=:id;
-- apoi asigură rând focus + blochează:
--   dacă tt_(bugs|features).focus_task_id IS NULL → INSERT tt_focus_tasks (source_type,source_id,title,project_id,status,priority...) și leagă focus_task_id;
--   apoi UPDATE tt_focus_tasks SET is_blocked=true, blocked_reason=:reason WHERE id=<focus_task_id>;
```

Logica `ensureFocusRow`: dacă rândul sursă nu are `focus_task_id`, creează mai întâi rândul
`tt_focus_tasks` cu `source_type='bug'|'feature'`, `source_id=:id`, câmpurile corespunzătoare,
actualizează `focus_task_id` pe rândul sursă, **apoi** aplică `is_blocked=true`.
