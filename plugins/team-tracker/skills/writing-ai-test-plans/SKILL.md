---
name: writing-ai-test-plans
description: Use when the user asks to create, generate, draft, or write a test plan that will be executed AUTOMATICALLY by an AI agent (not a human tester) — the AI-runner sibling of /writing-tester-test-plans. Inspects git diff and the conversation to identify user-visible changes, then writes a plain-Romanian step-by-step plan as rows in the Supabase tables tt_test_plans / tt_test_items with test_type = 'ai'. Plans written by this skill are picked up by /auto-running-test-plans (which drives the Vite preview), and failures flow into /resolving-failed-test-plans. Triggers on "fă plan pentru AI", "plan de testare AI", "creează plan AI", "scrie teste pentru AI", "plan pe care îl rulează AI-ul", "write AI test plan", "draft AI test plan", "make an AI-run test plan", "auto test plan".
---

# Writing AI Test Plans

Turn the work done in the current chat session into a clean, step-by-step test plan that the **AI runner** (`/auto-running-test-plans`) can execute on the project's Vite preview. Save it as rows in Supabase tagged `test_type = 'ai'` so the team-tracker "AI testing" toggle shows it and the AI runner picks it up.

This is the **sibling skill** of `writing-tester-test-plans`. They are nearly identical — same plain-Romanian, observable, jargon-free step style — and differ in exactly one thing: **who runs the plan**.

| Skill | `test_type` | Who runs it | team-tracker toggle |
|-------|-------------|-------------|---------------------|
| `writing-tester-test-plans` | `'human'` | a human QA tester | "Real user testing" |
| `writing-ai-test-plans` (this) | `'ai'` | `/auto-running-test-plans` (AI on the Vite preview) | "AI testing" |

If the user wants a plan for a **human** tester, use `writing-tester-test-plans` instead. Use **this** skill only when the plan is meant to be auto-run by the AI.

## Why this skill exists

After Claude implements a feature or ships a fix, the user wants it verified *without* waiting for a human. This skill writes a plan that the AI runner can execute end-to-end against the local dev preview, mark each step `pass`/`fail`/`blocked` with evidence, and archive when green. The closed loop is:

1. Claude does work → invoke this skill → plan rows inserted in `tt_test_plans` (with `test_type='ai'`) + `tt_test_items`.
2. User invokes `/auto-running-test-plans` → AI drives the Vite preview, flips each step's `result`.
3. User invokes `/resolving-failed-test-plans` → failed steps get fixed and re-verified.
4. Fully green plans get archived (`is_archived = TRUE`).

**Write-only.** This skill only *writes* the plan rows. It does not run anything — execution is `/auto-running-test-plans`' job.

## Constants

| Item | Value |
|------|-------|
| Source root of the project being tested | the current working directory — **resolved in Step 0** |
| team-tracker app (renders plans; do NOT edit) | `C:/Users/lakie/Desktop/team-tracker` |
| Supabase project id (holds tt_* tables) | `ntjzghsbrzkvpkniotaj` |
| Tables | `public.tt_test_plans`, `public.tt_test_items`, `public.tt_projects` |
| `tt_projects` known rows | `1=BetRO/betro`, `2=Team Tracker/team_tracker`, `3=Popicu/popicu`, `4=Telegram Tips/telegram_tips`, `5=Social/social`, `6=Padel/padel`, `7=Culcush/culcush` |
| **`test_type` to write** | **always `'ai'`** for this skill (the discriminator that routes the plan to the AI runner and the "AI testing" toggle) |
| Default language | Romanian (steps stay readable; the AI runner parses Romanian) |
| Default `created_by` | `"Claude Code"` |
| `project_id` to write | **resolved in Step 0** from the current working directory — never hardcoded; NULL is invisible in team-tracker |

If the user explicitly asks for English, switch the step text to English but keep all other defaults.

## tt_test_plans / tt_test_items — schema you write to

```
tt_test_plans (
  id           BIGSERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT DEFAULT '',
  area         TEXT DEFAULT 'General',
  priority     TEXT NOT NULL DEFAULT 'Medium',  -- one of: Low, Medium, High
  test_type    TEXT NOT NULL DEFAULT 'human',   -- 'human' | 'ai'  → THIS SKILL ALWAYS WRITES 'ai'
  is_archived  BOOLEAN DEFAULT FALSE,
  created_by   TEXT,
  project_id   BIGINT REFERENCES tt_projects(id),  -- MUST be set; NULL plans are invisible in team-tracker
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
)

tt_test_items (
  id              BIGSERIAL PRIMARY KEY,
  test_plan_id    BIGINT NOT NULL REFERENCES tt_test_plans(id) ON DELETE CASCADE,
  order_index     INTEGER NOT NULL DEFAULT 0,
  description     TEXT NOT NULL,            -- step text / action
  expected_result TEXT DEFAULT '',          -- the observable outcome
  result          TEXT NOT NULL DEFAULT 'pending',  -- pass | fail | blocked | pending
  notes           TEXT DEFAULT '',
  tested_by       TEXT,
  tested_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
)
```

`test_type` is checked: `CHECK (test_type IN ('human', 'ai'))`. Write **exactly** `'ai'` — not `'AI'`, not `'auto'`.

`result` values are **singular**: `pass`, `fail`, `blocked`, `pending`. Never write `passed` / `failed`.

`order_index` is 0-based and contiguous — how team-tracker and the AI runner order steps.

## Step 0 — Resolve which project this plan is for

The user works across multiple apps — all stored in the same team-tracker Supabase under different `tt_projects.id`. Detect the project from the current working directory before doing anything else.

```bash
basename "$(pwd)"
```

Then resolve to a row in `tt_projects` via `mcp__supabase-mcp-server__execute_sql`:
```sql
SELECT id, name, slug FROM tt_projects
WHERE LOWER(slug) = LOWER('<dirname>')
   OR LOWER(REPLACE(slug, '_', '-')) = LOWER('<dirname>')
   OR LOWER(REPLACE(slug, '_', '')) = LOWER(REPLACE('<dirname>', '-', ''))
   OR LOWER(name) = LOWER(REPLACE('<dirname>', '-', ' '))
LIMIT 1;
```

Examples:
- `cwd = C:\Users\lakie\Desktop\BETRO` → dirname `BETRO` → slug `betro` → `id = 1`
- `cwd = C:\Users\lakie\Desktop\team-tracker` → dirname `team-tracker` → slug `team_tracker` → `id = 2`
- `cwd = C:\Users\lakie\Desktop\culcush` → dirname `culcush` → slug `culcush` → `id = 7`

Capture the returned `id` as `<project_id>` and the cwd path as `<source_root>`.

If no row matches, abort:
> "Nu am putut identifica proiectul din folderul curent ('<dirname>'). Folderul trebuie sa aiba acelasi nume cu slug-ul din tt_projects. Verifica, sau spune-mi explicit pe ce proiect sa scriu planul."

## Step 1 — Gather what changed

Run these in parallel before writing anything:

1. `Bash`: `git -C "<source_root>" status --porcelain=v1` — uncommitted edits.
2. `Bash`: `git -C "<source_root>" log --oneline -30 --since="2 days ago"` — recently committed work.
3. `Bash`: `git -C "<source_root>" diff --stat HEAD` — at-a-glance file list.
4. `Bash`: `git -C "<source_root>" diff HEAD -- "*.ts" "*.tsx" "*.sql" "supabase/functions/**"` — actual change content. Adjust globs to the project's stack.

If the user pointed at a specific commit/PR/branch, narrow the diff to that scope. Otherwise default to "everything not yet on the remote main branch" plus uncommitted changes.

Also re-read the most recent ~30 turns of the conversation to recover **intent** — the diff says *what* changed, the conversation says *why* and *what it should do*.

If git returns nothing changed and the conversation has no substantive implementation work, abort: "Nu am găsit nicio modificare în chat-ul curent. Spune-mi explicit ce să acopere planul."

## Step 2 — Classify the changes (and keep them AI-runnable)

Walk the diff and bucket every change exactly as the tester skill does:

| Bucket | What it is | Step shape |
|--------|------------|------------|
| `flow-new` | A new user-facing flow (new tab, screen, feature). | Walk the flow start-to-finish. |
| `flow-changed` | An existing flow whose behavior/layout/wording changed. | Walk it, compare against the described change. |
| `visible-fix` | A bug fix with an observable symptom. | Reproduce the old symptom, confirm it's gone. |
| `validation` | Input validation, error messages, required fields. | Try invalid input, confirm the right error. |
| `permissions` | Role/tier-gated access. | Each role/tier as its own steps. |
| `cross-cutting` | Theme/layout/header touching many screens. | Spot-check representative screens. |

Pull the **concrete UI entities** (tab names, button labels, field names, screen titles) from the diff (TSX templates, translation files) — not from memory.

### Keep AI plans inside what the AI runner can actually do

The AI runner drives a **single Vite preview browser session**. It CANNOT do:
- multi-account / two-device / cross-account scenarios ("al doilea cont", "2 device-uri");
- native-only behavior (push notifications, Face ID/biometrics, Apple Sign-In native sheet, Capacitor plugins, share sheet, OS file picker, App/Play Store).

The runner marks such steps `blocked` and skips them — so they add no value to an AI plan. **Prefer single-session, preview-observable steps.** If a change can only be verified with two accounts or a native shell, write a `writing-tester-test-plans` (human) plan for it instead, or note it in the plan `description` as a manual follow-up. (This is the only substantive content difference from the human-tester skill — everything else about step style is identical.)

## Step 3 — Insert the plan into Supabase (test_type = 'ai')

One `INSERT INTO tt_test_plans ... RETURNING id`, then one bulk `INSERT INTO tt_test_items`. Use the CTE pattern below.

### Plan row

| Column | What to put |
|--------|-------------|
| `title` | One short sentence, prefixed with a ticket id if known. Keep under 120 chars. |
| `description` | 2–3 plain-Romanian sentences: what changed, why, and any "Pregătire" notes (which screen to start on). No jargon. |
| `area` | One of: `AI`, `Bilete`, `Cote`, `Clasament`, `Notificari`, `Social`, `Cont`, `Plata`, `General`. Pick the dominant change. |
| `priority` | `Low` / `Medium` / `High`. |
| `test_type` | **`'ai'`** — mandatory for this skill. |
| `effort` | How much reasoning a careful run needs: `low\|medium\|high\|xhigh\|max\|ultracode` (mirrors Claude Code effort; shown as a badge on the Focus card). UI-heavy / responsive / many-step plan → **at least `high`** (it must look right on mobile AND desktop). A simple copy/text check → `low`/`medium`. |
| `is_archived` | `FALSE`. |
| `created_by` | `'Claude Code'` (or what the user specified). |
| `project_id` | `<project_id>` resolved in Step 0. **MANDATORY** — NULL plans are invisible in team-tracker. |

### Item rows — same composition rules as the tester skill

1. **One observable thing per row.** Splitting lets the runner mark exactly where it broke.
2. **Quote UI text verbatim** (from the TSX/translations in the diff), so the runner can locate elements by their visible text.
3. **No backend words** in `description`/`expected_result` (`endpoint`, `API`, `service`, `migration`, `RLS`, `JWT`, `token`, `RPC`, etc.). Write what is *observable on screen*.
4. **Every step has a non-empty `expected_result`** — the runner judges pass/fail against it, so it must be a concrete, observable signal ("apare textul X", "NU vezi cuvantul Y", "counter-ul devine N+1").
5. **Romanian by default.**
6. **Each role/tier its own steps.**
7. **Reproduce-then-verify** for `visible-fix` buckets.
8. **Concrete data over placeholders** (real test creds in the `description` prerequisites; no `<placeholder>` in steps).
9. **5–12 items per plan.** Split large work into multiple `tt_test_plans` rows, one per area.
10. **First and last items are housekeeping** — first navigates to the screen + confirms starting state; last is a "verificare finală" non-regression sweep.

### Worked example — INSERT shape (note `test_type`)

```sql
WITH new_plan AS (
  INSERT INTO tt_test_plans (title, description, area, priority, test_type, effort, created_by, project_id)
  VALUES (
    'AI-RUN: Sub-text categorii Pronostic AI in romana',
    'Verifica automat ca textele de sub butoanele Cota 2 / Echilibrat / Surprize din tab-ul Pronostic AI nu mai contin cuvinte englezesti. Pregatire: porneste pe ecranul unui meci viitor cu cote.',
    'AI',
    'High',
    'ai',          -- THIS is what routes the plan to /auto-running-test-plans and the "AI testing" toggle
    'medium',      -- effort to run this plan well (low|medium|high|xhigh|max|ultracode); UI/UX-heavy → at least 'high'
    'Claude Code',
    <project_id>   -- resolved in Step 0 from cwd
  )
  RETURNING id
)
INSERT INTO tt_test_items (test_plan_id, order_index, description, expected_result)
SELECT id, idx, description, expected_result FROM new_plan
CROSS JOIN (VALUES
  (0,
   'Deschide un meci viitor cu cote si apasa pe tab-ul "Pronostic AI".',
   'Vezi randul de butoane: General / Recomandare AI / Sigur / Echilibrat / Cota 2 / Surprize / Valoare.'),
  (1,
   'Apasa pe butonul "Cota 2".',
   'Sub butoane apare textul romanesc, fara "bet builder".'),
  (2,
   'Apasa pe butonul "Echilibrat".',
   'Sub butoane apare text romanesc, fara "Over 2.5" / "GG" / "single sau combo".'),
  (3,
   'Verificare finala — uita-te scurt peste tab-urile Cote si H2H.',
   'Aplicatia nu s-a blocat, fara erori in consola, fara text englezesc nou.')
) AS steps(idx, description, expected_result);
```

Atomicity is not strictly required; if the item insert fails, delete the plan row.

## Step 4 — Report

```
Plan AI creat în Supabase: tt_test_plans #<id>  (test_type = 'ai')
Titlu: <title>
Pași: <N> | Area: <area> | Prioritate: <priority> | Efort: <effort> | Proiect: <project_slug>
Apare în team-tracker pe toggle-ul "AI testing". Ruleaza /auto-running-test-plans ca sa-l execute, apoi /resolving-failed-test-plans pentru fail-uri.
```

Do not paste the full step list into the chat — the DB row is the deliverable.

## Mistakes to avoid

| Mistake | Why it hurts | Fix |
|---------|--------------|-----|
| Omitting `test_type` (defaults to `'human'`) | The plan lands under "Real user testing", not "AI testing", and `/auto-running-test-plans` (which filters `test_type='ai'`) never picks it up. | Always write `test_type = 'ai'` in the INSERT. |
| Writing `'AI'` / `'auto'` instead of `'ai'` | The CHECK constraint rejects it (only `'human'`/`'ai'`) and the INSERT fails. | Use the exact lowercase literal `'ai'`. |
| Writing multi-account / native-only steps | The AI runner can only drive one preview session; it marks those `blocked`, adding noise. | Keep AI plans single-session & preview-observable; route device/2-account checks to a human (`writing-tester-test-plans`) plan. |
| Status values `passed`/`failed` (plural) | Schema uses singular. | Items default to `pending`; the runner writes `pass`/`fail`/`blocked`. |
| Merging step + expected into one column | `expected_result` is separate and is what the runner judges against. | Keep them in their own columns; every step needs a non-empty `expected_result`. |
| Omitting `project_id` | team-tracker hides `project_id IS NULL` rows. | Resolve in Step 0 and include it. |
| Using developer terminology | The plan also has to be human-readable in team-tracker. | Read each row pretending you've never coded. |
| Confusing this with the human skill | Wrong toggle, wrong runner. | Human tester → `writing-tester-test-plans`. AI runner → this skill. |

## Integration with the rest of the pipeline

1. Plan inserted here with `test_type='ai'`, all items `pending`.
2. `/auto-running-test-plans` (filters `test_type='ai'`) drives the preview and flips each item's `result`.
3. `/resolving-failed-test-plans` picks up any complete plan with a `fail` item (it handles BOTH `human` and `ai` plans), fixes the code, re-verifies, and archives if all pass.

## When to self-abort

- Supabase MCP disconnected (`execute_sql` errors). Tell the user to reconnect and rerun.
- The source root is missing.
- Git shows no changes **and** the conversation has no substantive implementation work: "Nu am gasit nicio modificare in chat-ul curent. Spune-mi explicit ce sa acopere planul."
- Every change is backend-only / config-only with no preview-observable effect: "Modificarile din chat nu au efect vizibil in preview — nu pot fi rulate de AI. Vrei un plan tehnic in loc?"
