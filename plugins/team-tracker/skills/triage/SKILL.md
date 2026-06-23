---
name: triage
description: Use when the user wants to make order in EVERYTHING that's to be done across the team-tracker projects — rank the whole backlog and clean it up. Reads the BetRO Supabase (tt_bugs + tt_features + tt_test_plans across ALL projects), produces one explainable priority ranking ("ce e de făcut" — top global + per project), flags duplicates / stale / done-not-archived / missing-priority, then on confirmation applies only the safe cleanup (default priority where missing, archive old done items) so the unified Focus board reflects a clean, prioritized backlog. Has a read-only `--digest` mode for the daily "ce e de făcut azi" routine. Trigger this whenever the user says "fă ordine", "triază tot", "triage", "ce e de făcut", "prioritizează", "fă curățenie în backlog", "order the backlog", "what should I work on", "clean up the tracker", "ce am de făcut peste tot", even if they don't name a specific table or project. Do NOT use it to FIX bugs/features (that's resolving-tt-bugs / resolving-tt-features) — this skill only organizes the tracker, it never touches app code.
---

# triage — order everything that's to be done

One pass over **all** team-tracker work (bugs + features + test plans, every project), ranked into a clear
"do next" order, with the clutter (duplicates, stale, done-not-archived, missing priority) surfaced. Then, only
if the user confirms, it applies the **safe** cleanup so the unified Focus board shows a tidy, prioritized backlog.

This is the triage engine behind the Focus board. It is a **pure data tool**: it reads and (on confirm) writes the
team-tracker tracker tables in the BetRO Supabase. It never edits any app's source code — fixing work items is the
job of `resolving-tt-bugs` / `resolving-tt-features` / `resolving-failed-test-plans`.

## Why this skill exists

The team runs many apps (Betora/BetRO, Culcush, Padel Team, Telegram Tips, the landing page, …) and tracks all of
their work in one Supabase (project ref `ntjzghsbrzkvpkniotaj`): `tt_bugs`, `tt_features`, `tt_test_plans` (+
`tt_test_items`), all tagged with `project_id → tt_projects`. The Focus page shows everything on a board, but
"everything" piles up: bugs with no priority, features proposed months ago and forgotten, fixed bugs never archived,
near-duplicate reports. Deciding what to actually do next, by hand, across every project, is exactly the kind of
repetitive cross-cutting judgement this skill industrializes.

Unlike the other tt skills, **triage is global** — it does NOT scope to one project from the cwd. It reads `tt_projects`
for names and processes every project's open work, because the whole point is one ordered view of *all* of it. That's
safe here precisely because triage only writes to the shared tracker tables, never to any app's repo.

## Constants

| Item | Value |
|------|-------|
| Supabase project id (holds tt_* tables) | `ntjzghsbrzkvpkniotaj` |
| SQL access | `mcp__supabase-mcp-server__execute_sql` (the per-teammate Supabase MCP) |
| Scope | **ALL projects** — never add a `project_id` filter |
| Active bug statuses | `Open`, `In Progress` |
| Active feature statuses | `Propus`, `Planificat`, `În Focus` (done = `Gata`) |
| Active test plan | not archived AND has ≥1 `fail` or `pending` item (all-passed = done) |
| Stale threshold | `updated_at` older than **60 days** (flag for review) |
| Archive-done threshold | done item `updated_at` older than **30 days** (candidate to archive) |
| Default priority | `Medium` (applied to active bugs/features with no priority) |
| Writes allowed on confirm | set default priority; **backfill missing `effort`**; archive old done items; stamp `tt_triage_marks`. **Nothing else is automatic.** |
| Effort backfill | only where `effort IS NULL`: `high` if title/description smells UI/UX (must look good on mobile+desktop), else `medium`. Never overwrites an effort a resolving/writing skill already set. Values: `low\|medium\|high\|max\|ultracode`. |
| Never auto | merge/delete duplicates, delete stale, change titles/descriptions, touch app code |

Do not ask the user to confirm any of these constants. If the Supabase MCP isn't connected, stop with a one-line error.

## The score (how "ordine" is computed)

A single explainable score, highest = do first:

```
score = priority_rank*10 + type_boost*3 + age_factor
  priority_rank : Critical=4, High=3, Medium=2, Low=1, missing=0
  type_boost    : test plan with a failed step (regression)=3, bug=2, feature=1
  age_factor    : LEAST(age_in_days / 30, 3)   -- old work bubbles up, capped so it never beats priority
```

Priority dominates; a failed-test regression outranks a same-priority bug, which outranks a same-priority feature;
age is a gentle tiebreaker so nothing rots forever. **Blocked** items (Focus card `is_blocked`, or title/description
containing "blocat"/"blocked") are pulled into a separate list — they can't progress, so they don't belong in "do next".

## Step 1 — Read the whole backlog, ranked (one query)

Run this against `mcp__supabase-mcp-server__execute_sql` (project `ntjzghsbrzkvpkniotaj`). It ranks bugs + features +
unfinished test plans across every project in one shot:

```sql
WITH items AS (
  SELECT 'bug'::text AS kind, b.id, b.title, b.priority, b.status, b.project_id, b.created_at, b.updated_at
  FROM tt_bugs b
  WHERE NOT b.is_archived AND b.status IN ('Open','In Progress')
  UNION ALL
  SELECT 'feature', f.id, f.title, f.priority, f.status, f.project_id, f.created_at, f.updated_at
  FROM tt_features f
  WHERE NOT f.is_archived AND f.status IN ('Propus','Planificat','În Focus')
  UNION ALL
  SELECT CASE WHEN x.failed > 0 THEN 'test-failed' ELSE 'test' END,
         x.id, x.title, x.priority, 'În Lucru', x.project_id, x.created_at, x.updated_at
  FROM (
    SELECT tp.id, tp.title, tp.priority, tp.project_id, tp.created_at, tp.updated_at,
           count(ti.*) FILTER (WHERE ti.result = 'fail')    AS failed,
           count(ti.*) FILTER (WHERE ti.result = 'pending') AS pending
    FROM tt_test_plans tp
    LEFT JOIN tt_test_items ti ON ti.test_plan_id = tp.id
    WHERE NOT tp.is_archived
    GROUP BY tp.id
  ) x
  WHERE x.failed > 0 OR x.pending > 0
)
SELECT i.kind, i.id, i.title, i.priority, i.status, p.name AS project,
       EXTRACT(DAY FROM NOW() - i.updated_at)::int AS age_days,
       round(
         (CASE i.priority WHEN 'Critical' THEN 4 WHEN 'High' THEN 3 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 1 ELSE 0 END) * 10
       + (CASE i.kind WHEN 'test-failed' THEN 3 WHEN 'bug' THEN 2 WHEN 'feature' THEN 1 ELSE 1 END) * 3
       + LEAST(EXTRACT(DAY FROM NOW() - i.created_at) / 30.0, 3)
       , 1) AS score
FROM items i
LEFT JOIN tt_projects p ON p.id = i.project_id
ORDER BY score DESC, i.created_at ASC;
```

If it returns nothing: report "Nimic activ de făcut pe niciun proiect. 🎉" and stop.

## Step 2 — Find the clutter (four small queries)

```sql
-- a) Missing priority (active bugs/features)
SELECT 'bug' AS kind, id, title, project_id FROM tt_bugs
  WHERE NOT is_archived AND status IN ('Open','In Progress') AND (priority IS NULL OR priority = '')
UNION ALL
SELECT 'feature', id, title, project_id FROM tt_features
  WHERE NOT is_archived AND status IN ('Propus','Planificat','În Focus') AND (priority IS NULL OR priority = '');

-- a2) Missing effort (active bugs/features/tests) — count for the report; backfilled on "da"
SELECT 'bug' AS kind, count(*) FROM tt_bugs
  WHERE NOT is_archived AND status IN ('Open','In Progress') AND effort IS NULL
UNION ALL SELECT 'feature', count(*) FROM tt_features
  WHERE NOT is_archived AND status IN ('Propus','Planificat','În Focus') AND effort IS NULL
UNION ALL SELECT 'test', count(*) FROM tt_test_plans
  WHERE NOT is_archived AND effort IS NULL;

-- b) Done not archived, older than 30 days (candidates to archive)
SELECT 'bug' AS kind, id, title, updated_at FROM tt_bugs
  WHERE NOT is_archived AND status = 'Fixed'  AND updated_at < NOW() - INTERVAL '30 days'
UNION ALL
SELECT 'feature', id, title, updated_at FROM tt_features
  WHERE NOT is_archived AND status = 'Gata'   AND updated_at < NOW() - INTERVAL '30 days'
UNION ALL
SELECT 'test', tp.id, tp.title, tp.updated_at FROM tt_test_plans tp
  WHERE NOT tp.is_archived AND tp.updated_at < NOW() - INTERVAL '30 days'
    AND NOT EXISTS (SELECT 1 FROM tt_test_items ti WHERE ti.test_plan_id = tp.id AND ti.result IN ('fail','pending'))
    AND EXISTS     (SELECT 1 FROM tt_test_items ti WHERE ti.test_plan_id = tp.id);

-- c) Stale: active items untouched for 60+ days
SELECT 'bug' AS kind, id, title, EXTRACT(DAY FROM NOW()-updated_at)::int AS age FROM tt_bugs
  WHERE NOT is_archived AND status IN ('Open','In Progress') AND updated_at < NOW() - INTERVAL '60 days'
UNION ALL
SELECT 'feature', id, title, EXTRACT(DAY FROM NOW()-updated_at)::int FROM tt_features
  WHERE NOT is_archived AND status IN ('Propus','Planificat','În Focus') AND updated_at < NOW() - INTERVAL '60 days';

-- d) Possible duplicates: active items in the same project sharing a normalized title
WITH norm AS (
  SELECT 'bug' AS kind, id, project_id, lower(regexp_replace(trim(title), '\s+', ' ', 'g')) AS t FROM tt_bugs
    WHERE NOT is_archived AND status IN ('Open','In Progress')
  UNION ALL
  SELECT 'feature', id, project_id, lower(regexp_replace(trim(title), '\s+', ' ', 'g')) FROM tt_features
    WHERE NOT is_archived AND status IN ('Propus','Planificat','În Focus')
)
SELECT project_id, t, array_agg(kind || ':' || id ORDER BY id) AS items, count(*) AS n
FROM norm GROUP BY project_id, t HAVING count(*) > 1;
```

(Query d catches exact-after-normalization duplicates without needing the `pg_trgm` extension. If the team later
enables `pg_trgm`, a `similarity()` self-join can catch fuzzy near-duplicates too — optional, not required.)

## Step 3 — Present the proposal, then STOP

Print a compact Romanian report. Keep the global top to ~15 lines; summarize the rest per project.

```
/triage — <YYYY-MM-DD> — toate proiectele

Top de făcut (global):
   1. [Betora(BetRO)] [Critical] [bug]     #228  lipsa nume echipa            (score 43)
   2. [Culcush]       [High]     [test✗]   #71   regresie checkout            (score 39)
   ... (max ~15)

Pe proiect:  Betora(BetRO): N · Culcush: M · Padel Team: K · …   (counts of active items)

Blocate (nu pot avansa): <count>
   - [proj] [pri] #id  titlu  — motiv (din is_blocked / „blocat")

Curățenie:
   • Fără prioritate: K        → propun Medium
   • Fără efort: E             → propun backfill (medium; high la UI/UX)
   • Done de arhivat (>30z): A → propun arhivare
   • Stale (>60z): S          → DOAR raport (decizi tu)
   • Posibile duplicate: D    → DOAR raport (decizi tu): #x ~ #y …

Aplic curățenia sigură (prioritate Medium + efort backfill unde lipsesc + arhivare done vechi)? da / nu
```

Then **stop and wait**. The user invoked triage to SEE the order first; never apply writes before an explicit "da".
(Exception: `--digest` mode, below, is read-only and stops here without the apply prompt.)

## Stamp provenance (tt_triage_marks)

Both flows record **who last ordered each active item** into `tt_triage_marks` (PK `(source_type, source_id)`), so the
Focus board can badge each card with who ordered it. It's a single self-contained upsert over the same active set as
Step 1 — only the `<BY>` literal changes: `routine` in `--digest`, `triage` on a manual apply.

```sql
INSERT INTO tt_triage_marks (source_type, source_id, triaged_by, triaged_at)
SELECT 'bug', b.id::text, '<BY>', now() FROM tt_bugs b
  WHERE NOT b.is_archived AND b.status IN ('Open','In Progress')
UNION ALL
SELECT 'feature', f.id::text, '<BY>', now() FROM tt_features f
  WHERE NOT f.is_archived AND f.status IN ('Propus','Planificat','În Focus')
UNION ALL
SELECT 'test', tp.id::text, '<BY>', now() FROM tt_test_plans tp
  WHERE NOT tp.is_archived
    AND EXISTS (SELECT 1 FROM tt_test_items ti WHERE ti.test_plan_id = tp.id AND ti.result IN ('fail','pending'))
ON CONFLICT (source_type, source_id)
DO UPDATE SET triaged_by = EXCLUDED.triaged_by, triaged_at = EXCLUDED.triaged_at;
```

This is the **only** write `--digest` performs (provenance, not priority/archive). On a manual run it happens on "da",
alongside the cleanup, with `<BY>` = `triage`. The `tt_triage_marks` table holds only the latest stamp per item.

## Step 4 — Apply on "da" (safe writes only)

If the user confirms, apply exactly three kinds of write, each reported with the row count touched:

```sql
-- Default priority where missing
UPDATE tt_bugs     SET priority='Medium', updated_at=NOW()
  WHERE NOT is_archived AND status IN ('Open','In Progress') AND (priority IS NULL OR priority='');
UPDATE tt_features SET priority='Medium', updated_at=NOW()
  WHERE NOT is_archived AND status IN ('Propus','Planificat','În Focus') AND (priority IS NULL OR priority='');

-- Backfill effort where missing: UI/UX-smelling items must look good on mobile+desktop → 'high', else 'medium'.
-- Only touches effort IS NULL; never overwrites a level a resolving/writing skill already set.
UPDATE tt_bugs SET effort = CASE WHEN (title || ' ' || COALESCE(description,'')) ~* '(\[ui\]|ui/ux| ux |design|layout|responsive|mobil|ecran|buton|culoare|font|stil|vizual|icon)' THEN 'high' ELSE 'medium' END, updated_at=NOW()
  WHERE NOT is_archived AND status IN ('Open','In Progress') AND effort IS NULL;
UPDATE tt_features SET effort = CASE WHEN type='Design' OR (title || ' ' || COALESCE(description,'')) ~* '(\[ui\]|ui/ux| ux |design|layout|responsive|mobil|ecran|buton|culoare|font|stil|vizual|icon)' THEN 'high' ELSE 'medium' END, updated_at=NOW()
  WHERE NOT is_archived AND status IN ('Propus','Planificat','În Focus') AND effort IS NULL;
UPDATE tt_test_plans SET effort = CASE WHEN (title || ' ' || COALESCE(description,'')) ~* '(\[ui\]|ui/ux| ux |design|layout|responsive|mobil|ecran|buton|culoare|font|stil|vizual)' THEN 'high' ELSE 'medium' END, updated_at=NOW()
  WHERE NOT is_archived AND effort IS NULL;

-- Archive old done items (the exact ids from Step 2b — pass them explicitly so nothing else is touched)
UPDATE tt_bugs        SET is_archived=true, updated_at=NOW() WHERE id = ANY(<bug_ids_2b>);
UPDATE tt_features    SET is_archived=true, updated_at=NOW() WHERE id = ANY(<feature_ids_2b>);
UPDATE tt_test_plans  SET is_archived=true, updated_at=NOW() WHERE id = ANY(<test_ids_2b>);
```

Then run the **Stamp provenance** upsert with `<BY>` = `triage` — this claims every active item for this manual run, so
their Focus cards show the "ordonat de /triage" badge. Always run it on "da", even if there was no priority/archive
cleanup to apply.

Setting priorities is what visibly reorders the Focus board — `cardsByColumn` sorts active columns by priority, so a
bug bumped from missing→Medium (or the user later bumping it to Critical) rises immediately. There is no `order_index`
to set; don't try.

**Duplicates and stale are report-only.** Merging or closing them is a human judgement call (one of two "duplicates"
may have unique screenshots or a different platform), so triage never deletes or archives them automatically. If the
user explicitly says "arhivează și stale" / "închide duplicatul #x", do that one targeted write — but only on explicit
instruction, never as part of the default apply.

Print a one-line confirmation of what changed (`Prioritate setată: K · Efort backfill: E · Arhivate: A`), then stop. The user looks at the
Focus board for the live result.

## `--digest` mode (read-only, for the daily routine)

When invoked as `/triage --digest` (or the prompt says "digest"/"ce e de făcut azi"/"rezumat zilnic"):
- Run Step 1 (ranking) + the Blocate list + this extra query for fresh, untriaged work:
  ```sql
  SELECT 'bug' AS kind, id, title, priority, project_id FROM tt_bugs
    WHERE NOT is_archived AND created_at > NOW() - INTERVAL '24 hours'
  UNION ALL
  SELECT 'feature', id, title, priority, project_id FROM tt_features
    WHERE NOT is_archived AND created_at > NOW() - INTERVAL '24 hours';
  ```
- Print: global **top ~10** + **"Noi în ultimele 24h"** + **Blocate**. NO clutter section, NO apply prompt.
- Then run the **Stamp provenance** upsert with `<BY>` = `routine`. This is the digest's ONLY write — it stamps who
  ordered each active item, and never changes priority or archives anything.
- This is what the scheduled daily routine runs. Keep it short — it's a morning glance, not a full audit.

## Mistakes to avoid

| Mistake | Why it hurts | Fix |
|---------|--------------|-----|
| Adding a `project_id` filter | triage is global; you'd hide most of the backlog | Never filter by project — read `tt_projects` only for names |
| Applying writes before "da" | The user wanted to see the order first | Always Step 3 → wait → Step 4 |
| Auto-merging/deleting duplicates or stale | Destructive; a "duplicate" may carry unique evidence | Report-only; act only on explicit per-item instruction |
| Archiving recent done items | Hides work the team just finished and still wants visible in Gata | Only archive done older than 30 days (Step 2b set) |
| Touching titles/descriptions/`reported_by`/`created_at` | Those are tester/UI-owned | Only ever write `priority`, `is_archived`, `updated_at` |
| Trying to set Focus order via `order_index` | The board sorts by priority, not order_index, for these cards | Adjust priority instead |
| Editing app code to "fix" a ranked item | Out of scope; that's the resolving-* skills | triage organizes the tracker only |
| Lowercase status strings (`open`, `fixed`) | DB uses titlecase; filters won't match | Use exact `Open`/`In Progress`/`Fixed`/`Propus`/`Gata` |
| Running priority/archive writes in `--digest` mode | The digest only stamps provenance, never reprioritizes | `--digest` writes ONLY the `tt_triage_marks` stamp; never priority/archive |

## When to self-abort

Stop and report one sentence when: the Supabase MCP is disconnected; Step 1 returns zero active items (say so — nothing
to order); or a write errors — including the `tt_triage_marks` stamp (report which table failed and that nothing further
was applied).
