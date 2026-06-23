---
name: writing-tester-test-plans
description: Use when the user asks to create, generate, draft, or write a test plan covering everything that was implemented or fixed in the current chat session — for non-technical QA testers who don't read code. Inspects git diff and the conversation to identify user-visible changes on the BetRO app, then writes a plain-Romanian step-by-step plan as rows in the BetRO Supabase tables tt_test_plans / tt_test_items (the team-tracker app reads them). Once the tester marks each step pass/fail/blocked through team-tracker, the plan flows straight into /resolving-failed-test-plans. Triggers on "fă plan pentru tester", "creează plan de testare", "generează plan QA", "scrie un plan de testare simplu", "plan de testare pentru ce am implementat", "write test plan", "draft tester plan", "make a QA plan", "create a tester-friendly plan".
---

# Writing Tester Test Plans

Turn the work done in the current chat session into a clean, simple, step-by-step test plan that a QA tester with no programming background can execute on the real BetRO app. Save it as rows in the BetRO Supabase database so the team-tracker app can render it for the tester and so the sister skill `/resolving-failed-test-plans` can sweep up the failures afterwards.

> **Sibling skill — pick the right one.** This skill writes plans for a **human** tester (`test_type = 'human'`, shown under team-tracker's "Real user testing" toggle). Its sibling `writing-ai-test-plans` writes plans for the **AI runner** (`test_type = 'ai'`, "AI testing" toggle, executed by `/auto-running-test-plans`). If the user wants a plan that the AI auto-runs rather than a human, use `writing-ai-test-plans` instead. Everything below — step style, language, rules — is identical between the two; only `test_type` and who runs the plan differ.

## Why this skill exists

After Claude implements a feature or ships a fix to BetRO, the user needs a tester to confirm it works on the actual app. The tester is **not a programmer** — they don't read diffs, they don't know what an `endpoint` or a `service` is. They open team-tracker (a separate React app), see the plan as a checklist, and mark each step from a `pass` / `fail` / `blocked` dropdown.

This skill bridges two worlds:
- **Implementation side**: real code changes, commits, files touched in BetRO.
- **Tester side**: screens, buttons, text labels, expected outcomes — viewed through team-tracker's UI.

The closed loop is:

1. Claude does work on BetRO → invoke this skill → plan rows inserted in `tt_test_plans` + `tt_test_items`.
2. Tester opens team-tracker, sees the new plan, runs steps on the BetRO app/device, flips each step's `result` to `pass`/`fail`/`blocked` and writes notes.
3. User invokes `/resolving-failed-test-plans` → failed steps get fixed and re-verified.
4. Fully green plans get archived (`is_archived = TRUE`).

## Constants

| Item | Value |
|------|-------|
| Source root of the project being tested | the current working directory — **resolved in Step 0** |
| team-tracker app (renders plans for the tester; do NOT edit) | `C:/Users/lakie/Desktop/team-tracker` |
| Supabase project id (holds tt_* tables) | `ntjzghsbrzkvpkniotaj` |
| Tables | `public.tt_test_plans`, `public.tt_test_items`, `public.tt_projects` |
| `tt_projects` known rows | `1=BetRO/betro`, `2=Team Tracker/team_tracker`, `3=Popicu/popicu`, `4=Telegram Tips/telegram_tips`, `5=Social/social`, `6=Padel/padel`, `7=Culcush/culcush` |
| Default language | Romanian (the tester is Romanian-speaking) |
| **`test_type` to write** | **always `'human'`** for this skill (routes the plan to the "Real user testing" toggle and a human tester, not the AI runner) |
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
  test_type    TEXT NOT NULL DEFAULT 'human',   -- 'human' | 'ai'  → THIS SKILL ALWAYS WRITES 'human'
  is_archived  BOOLEAN DEFAULT FALSE,
  created_by   TEXT,
  project_id   BIGINT REFERENCES tt_projects(id),  -- MUST be 1 for BetRO plans; NULL plans are invisible in team-tracker
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
)

tt_test_items (
  id              BIGSERIAL PRIMARY KEY,
  test_plan_id    BIGINT NOT NULL REFERENCES tt_test_plans(id) ON DELETE CASCADE,
  order_index     INTEGER NOT NULL DEFAULT 0,
  description     TEXT NOT NULL,            -- step text the tester sees and acts on
  expected_result TEXT DEFAULT '',          -- "Te aștepți să vezi..."
  result          TEXT NOT NULL DEFAULT 'pending',  -- pass | fail | blocked | pending
  notes           TEXT DEFAULT '',
  tested_by       TEXT,
  tested_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
)
```

`result` values are **singular**: `pass`, `fail`, `blocked`, `pending`. Never write `passed` / `failed`.

`order_index` is 0-based and is how team-tracker displays steps in order. Use contiguous integers.

`tt_test_items.description` is the equivalent of the old markdown checkbox line — the tester action. `expected_result` is the "Te aștepți să vezi" line. They are two separate fields, not one merged blob.

## Step 0 — Resolve which project this plan is for

The user works across multiple apps (BetRO, Culcush, Popicu, Team Tracker, Telegram Tips, Padel, Social) — all stored in the same team-tracker Supabase under different `tt_projects.id` values. Detect the project from the current working directory before doing anything else.

Run:
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

Substitute `<dirname>` with the basename output. Examples:
- `cwd = C:\Users\lakie\Desktop\BETRO` → dirname `BETRO` → matches slug `betro` → `id = 1`
- `cwd = C:\Users\lakie\Desktop\team-tracker` → dirname `team-tracker` → matches slug `team_tracker` (via underscore/hyphen normalization) → `id = 2`
- `cwd = C:\Users\lakie\Desktop\culcush` → dirname `culcush` → matches slug `culcush` → `id = 7`

Capture the returned `id` as `<project_id>` and the cwd path as `<source_root>`. Use both throughout this skill — `<project_id>` goes into the INSERT below, `<source_root>` is what you read git/diffs from.

If no row matches, abort with:
> "Nu am putut identifica proiectul din folderul curent ('<dirname>'). Folderul trebuie sa aiba acelasi nume cu slug-ul din tt_projects. Verifica, sau spune-mi explicit pe ce proiect sa scriu planul."

## Step 1 — Gather what changed

Run these in parallel before writing anything:

1. `Bash`: `git -C "<source_root>" status --porcelain=v1` — uncommitted edits.
2. `Bash`: `git -C "<source_root>" log --oneline -30 --since="2 days ago"` — recently committed work.
3. `Bash`: `git -C "<source_root>" diff --stat HEAD` — at-a-glance file list.
4. `Bash`: `git -C "<source_root>" diff HEAD -- "*.ts" "*.tsx" "*.sql" "supabase/functions/**"` — actual change content for the file types that drive user-visible behavior. Adjust the path globs to whatever languages the current project uses (`.svelte`, `.vue`, `.py`, `.go`, etc. — check `<source_root>/package.json` or equivalent for the stack).

If the user pointed at a specific commit, PR, or branch ("fă plan pentru fix-ul de ieri", "for the BET-70 work"), narrow the diff to that scope. Otherwise default to "everything not yet on the remote main branch" — `git log origin/master..HEAD` plus uncommitted changes.

Also re-read the most recent ~30 turns of the conversation to recover **intent**. The diff tells you *what* changed; the conversation tells you *why* and *what the user said it should do*. Both matter for writing the test steps.

If git returns nothing changed and the conversation has no substantive implementation work, abort with: "Nu am găsit nicio modificare în chat-ul curent. Spune-mi explicit ce să acopere planul."

## Step 2 — Classify the changes from a tester's eyes

Walk through the diff and bucket every change. Anything that does not fit a bucket is **not testable by a human tester** and should be ignored for this plan (build configs, dependency bumps, internal refactors with no behavior change, comment changes, etc.).

| Bucket | What it is | What the tester does |
|--------|------------|----------------------|
| `flow-new` | A new user-facing flow (new tab, new screen, new feature). | Walk the flow start-to-finish. |
| `flow-changed` | An existing flow whose behavior, layout, or wording changed. | Walk the flow and compare against the described change. |
| `visible-fix` | A bug fix with an observable symptom (button didn't work, list was empty, label was wrong, crash). | Reproduce the old symptom, confirm it no longer happens. |
| `validation` | Input validation, error messages, required fields. | Try invalid inputs, confirm the right error appears. |
| `realtime-cross-account` | RLS / realtime / comments / leaderboard updates that involve more than one user account. | Use 2 accounts (phone + Chrome localhost, or 2 devices) — see *Two-account scenarios* below. |
| `permissions` | Role-based or feature-gated access (free vs premium, admin vs user). | Sign in with each affected role/tier and confirm visible/hidden features. |
| `cross-cutting` | Changes that touch many screens (theme, layout, header). | Spot-check a few representative screens. |

For each bucket, identify the **specific entities** the tester will interact with: tab names, button labels, form field names, screen titles. Pull these from the diff (TSX templates, translation files `src/utils/core/translations/ro.ts`) — not your memory of the app.

If you find yourself writing a test step without a concrete UI element to point at, the change is probably backend-only and should not be in this plan.

### Two-account scenarios

For `realtime-cross-account` items, the step must spell out:
- which account opens the screen first (account A) and stays on it;
- which account performs the triggering action (account B);
- the expected delay window (e.g. "în maxim 5 secunde");
- the visible signal of success (count updates, new row appears, badge increments).

If the tester only has a single device, the second account can run in Chrome localhost on a laptop. Add this option in the prerequisites of the plan.

## Step 3 — Insert the plan into Supabase

Compose one `INSERT INTO tt_test_plans ... RETURNING id` followed by one bulk `INSERT INTO tt_test_items (...) VALUES ...` for all steps. Wrap both in a single SQL `WITH` chain (or two sequential `execute_sql` calls — the first returns the plan id, the second uses it). Atomicity is not strictly required — if items insertion fails, you delete the plan row.

### Plan row

| Column | What to put |
|--------|-------------|
| `title` | One short sentence prefixed by the most relevant BET/ticket id if you know it. Example: `RETEST: Comentarii Social — live cross-account (BET-70)`. Keep under 120 chars. |
| `description` | 2–3 plain-Romanian sentences telling the tester what changed and why. No jargon. This is the "Ce am modificat" block. |
| `area` | One of: `AI`, `Bilete`, `Cote`, `Clasament`, `Notificari`, `Social`, `Cont`, `Plata`, `General`. Pick the one that best matches the dominant change. New areas allowed if none fit. |
| `priority` | `Low` / `Medium` / `High`. `High` for security/data fixes or release blockers; `Medium` is the default; `Low` for cosmetic polish. |
| `effort` | How much reasoning a careful run needs: `low\|medium\|high\|max\|ultracode` (mirrors Claude Code effort; shown as a badge on the Focus card). UI-heavy / multi-screen / responsive plan → **at least `high`** (must look right on mobile AND desktop). A single simple check → `low`/`medium`. |
| `is_archived` | `FALSE`. |
| `created_by` | `'Claude Code'` (or whatever the user wrote in their request, like `'PM'`). |
| `project_id` | `<project_id>` resolved in **Step 0** from the cwd. **MANDATORY** — team-tracker scopes its view by selected project tab (`projectScopedPlans` in `TestingView.tsx`) and hides any row with `project_id IS NULL`. Plans without it exist in the DB but are invisible to the tester. |

### Item rows (one row per tester step)

For every test step:

| Column | What to put |
|--------|-------------|
| `test_plan_id` | The id returned by the plan insert. |
| `order_index` | 0-based contiguous integer; preserve the order you want the tester to follow. |
| `description` | The action the tester performs. Quote UI text verbatim. ONE observable thing per step (see rules below). |
| `expected_result` | The "Te aștepți să vezi" line. Concrete, observable, in Romanian. |
| `result` | `'pending'` (default). |
| `notes` | Empty string. The tester fills this when they mark fail/blocked. |

### Step composition rules — non-negotiable

These are what separate a plan a tester can run from one they can't.

1. **One observable thing per row.** "Apasă butonul X **și** verifică textul Y" is two rows. Splitting them lets the tester mark exactly where it broke.
2. **Quote UI text verbatim.** If the button says "Înrolează copil", write that — not "the enroll button". Pull the text from the TSX templates or `ro.ts` in the diff.
3. **No backend words.** Banned in `description`/`expected_result`: `endpoint`, `API`, `controller`, `service`, `repository`, `migration`, `DTO`, `query`, `JWT`, `token`, `cookie`, `webhook`, `SSR`, `RLS`, `RPC`. Replace with what the tester sees: "după ce te loghezi", "apasă pe Plătește", "așteaptă să se încarce lista".
4. **Every step has a non-empty `expected_result`.** No exceptions. A step without an expected outcome cannot be marked pass/fail honestly.
5. **Romanian by default**, English only if the user said so. Use "tu" form (informal), not "dvs.".
6. **Scenarios cover all roles/tiers affected**, separately. If the change affects free and premium differently, write separate steps for each. Don't merge them.
7. **Reproduce-then-verify for bug fixes.** For `visible-fix` buckets, the first step is "încearcă să faci X" (the thing that used to break) and the expected outcome is the new correct behavior.
8. **Concrete data over placeholders.** Use real test values: `email: test.user@betora.ro`, `parolă: Test1234!`. If you don't know the real test creds, surface that in the plan's `description` prerequisites paragraph; don't sprinkle `<placeholder>` in step rows.
9. **Plan length cap.** Aim for 5–15 minutes of tester time, which usually means 5–12 items. If the changes are large, split into multiple plans (insert multiple `tt_test_plans` rows) — one per feature area. Larger plans get abandoned by testers.
10. **First and last items are housekeeping.** First item = navigate to the relevant screen + confirm starting state. Last item = "verificare finală" — app not broken, no English leakage, no white screen.

### Worked example — INSERT shape

```sql
WITH new_plan AS (
  INSERT INTO tt_test_plans (title, description, area, priority, test_type, effort, created_by, project_id)
  VALUES (
    'RETEST: Sub-text categorii Pronostic AI in romana (BET-139/140/141)',
    'Am corectat textele de sub butoanele Cota 2 / Echilibrat / Surprize din tab-ul Pronostic AI: nu mai apar cuvinte englezesti (bet builder, single, combo, upside, Over 2.5, GG). Trebuie sa apara doar romana.',
    'AI',
    'High',
    'human',      -- this skill writes human plans (Real user testing toggle); use writing-ai-test-plans for 'ai'
    'high',       -- effort to run this plan well; UI text across multiple screens → at least 'high' (mobile + desktop)
    'Claude Code',
    <project_id>  -- resolved in Step 0 from cwd (e.g. 1 for BetRO, 7 for Culcush). Without this the plan is invisible in team-tracker.
  )
  RETURNING id
)
INSERT INTO tt_test_items (test_plan_id, order_index, description, expected_result)
SELECT id, idx, description, expected_result FROM new_plan
CROSS JOIN (VALUES
  (0,
   'Deschide un meci viitor cu cote (ex: Premier League, Liga Romaniei) si apasa pe tab-ul "Pronostic AI".',
   'Vezi randul de butoane: General / Recomandare AI / Sigur / Echilibrat / Cota 2 / Surprize / Valoare.'),
  (1,
   'Apasa pe butonul "Cota 2".',
   'Sub butoane apare textul: "Selectii in zona 1.80-2.20 + bilet construit optimizat." (NU "bet builder").'),
  (2,
   'Apasa pe butonul "Echilibrat".',
   'Sub butoane apare textul: "...Exemple: Peste 2.5, Ambele Marcheaza. AI poate propune un pariu simplu sau combinat..." (NU "Over 2.5, GG", NU "single sau combo").'),
  (3,
   'Apasa pe butonul "Surprize".',
   'Sub butoane apare textul: "...AI cauta valoare si explica riscul; recomanda pariu simplu sau combinat." (NU "upside", NU "single sau combo").'),
  (4,
   'Asteapta sa se incarce o analiza pe Cota 2 / Echilibrat / Surprize. Citeste textul de pe orice card "Pariu Simplu" si butonul "Explicatie".',
   'Textul este natural in romana. NU vezi: "BTTS", "Goals Over/Under", "Both Teams Score", "HT/FT", "Over 2.5", "Yes/No" stand-alone, sau ** raw (Markdown nerandat).'),
  (5,
   'Repeta pasul 4 pe un al doilea meci dintr-o liga diferita.',
   'Comportamentul este identic — niciun cuvant englez stand-alone in textul analizei.'),
  (6,
   'Verificare finala — uita-te scurt peste alte tab-uri (Cote, H2H, Echipe).',
   'Aplicatia nu s-a blocat, ecranele arata la fel ca inainte, fara text englezesc nou aparut.')
) AS steps(idx, description, expected_result);
```

This pattern (CTE `new_plan` → bulk `INSERT ... SELECT FROM VALUES`) inserts the plan and all its items in one round-trip and survives row count changes. Adapt the rows to the work you're documenting.

## Step 4 — Report

After insertion, print a 3-line summary to the user:

```
Plan creat în Supabase (BetRO): tt_test_plans #<id>
Titlu: <title>
Pași: <N> | Area: <area> | Prioritate: <priority> | Efort: <effort>
Trimite testerului link-ul din team-tracker. Dupa ce marcheaza pass/fail/blocked, ruleaza /resolving-failed-test-plans.
```

Do not paste the full step list into the chat — the database row is the deliverable, the chat just confirms where it landed.

If the user wants a one-screen preview before you insert, you can show the first 2–3 step rows formatted as a table; but default to inserting straight and reporting the id.

## Mistakes to avoid

| Mistake | Why it hurts | Fix |
|---------|--------------|-----|
| Writing the plan as a markdown file under `testing-plans/` | The old skill did this; new pipeline reads from Supabase. team-tracker won't see a file. | Always INSERT into `tt_test_plans` / `tt_test_items`. |
| Status values `passed`/`failed` (plural) | Schema uses singular: `pass`/`fail`. Plural will never match downstream queries. | Items default to `pending`; only the tester writes `pass`/`fail`/`blocked`. |
| Merging step + expected into the `description` column | `expected_result` is a separate column; team-tracker shows them side by side. | Keep them in their own columns. |
| Writing test steps for backend-only changes | Tester can't observe them; they'll mark everything `blocked`. | Skip backend-only changes; cover them with automated tests. |
| Using developer terminology | Tester gets stuck on the first jargon word. | Read each row aloud pretending you've never coded. |
| One mega-step like "Test the whole Pronostic AI tab" | Tester can't mark partial progress or tell you where it broke. | Atomic steps — one observable thing each. |
| Pasting the entire diff into `description` | Useless noise for the tester. | The plan describes *behavior*. Reference areas, not files. |
| Forgetting prerequisites | Tester wastes the first 10 minutes hunting for test creds. | Put a "Pregătire" paragraph in the plan `description`: account, device, starting screen. |
| Skipping the final "verificare finală" item | Easy way to miss collateral damage (broken home screen after a deep fix). | Always include one safety-net item at the end. |
| Plans of 30+ items | Tester loses focus, skips items. | Split into multiple plans, one per feature area. Each is its own row in `tt_test_plans`. |
| Plan in English when the user speaks Romanian | Tester struggles, throws it away. | Default Romanian; switch only on explicit request. |
| `area` set to a free-form string like "Pronostic AI tab" | team-tracker filters by `area`; arbitrary strings break the filter chip UI. | Pick from: `AI`, `Bilete`, `Cote`, `Clasament`, `Notificari`, `Social`, `Cont`, `Plata`, `General`. New areas only if they describe a category that will recur. |
| Setting `is_archived = TRUE` on insert | Plan invisible to the tester. | Always insert with `is_archived = FALSE` (default). |
| Omitting `project_id` from the INSERT | Plan is created with `project_id = NULL` and team-tracker hides it from every project tab (it filters via `projectScopedPlans = plans.filter(p => p.project_id === selectedProject)`). The plan exists in the DB but the tester never sees it. | Always run Step 0 to resolve `<project_id>` from cwd, and include it in the INSERT. To recover orphan plans: `UPDATE tt_test_plans SET project_id = <resolved_id> WHERE id IN (...) AND project_id IS NULL;`. |
| Hardcoding `project_id = 1` because the previous example showed BetRO | Plan ends up under the wrong project tab in team-tracker — tester opens Culcush tab and never sees the BetRO-tagged plan you intended for them. | Always resolve from cwd in Step 0. `1` is just the BetRO example value; Culcush is `7`, Popicu is `3`, etc. |
| Inserting items without contiguous `order_index` | team-tracker may render out of order or skip. | Use 0, 1, 2, 3 ... contiguous. |
| Omitting `test_type` or writing `'ai'` here | Omitting defaults to `'human'` (fine for this skill); writing `'ai'` would route the plan to the AI runner instead of a human tester. | This (human) skill writes `test_type = 'human'`. Use `writing-ai-test-plans` for AI-run plans. |

## Integration with the rest of the pipeline

1. Plan inserted here, with all items at `result = 'pending'`.
2. Tester opens team-tracker, navigates to the new plan, runs the steps on the BetRO app (phone or Chrome localhost), and changes each item's `result` from `pending` to `pass` / `fail` / `blocked`, plus a free-text note when something is off.
3. When **every** item is non-pending, the plan is "complete" — `/resolving-failed-test-plans` will pick it up.
4. `/resolving-failed-test-plans` only processes plans where at least one item is `fail`. It then fixes BetRO source, re-verifies (Vite preview / SQL impersonation / MobAI), updates the item's `result` to `pass` with a `notes` audit trail, and archives the plan if all items end up `pass`. Plans with leftover `blocked` items stay in place for the user.

So the two skills together cover the loop: implement on BetRO → write plan rows → tester runs → resolve failures → archive.

## When to self-abort

Stop and tell the user when:
- The Supabase MCP server is disconnected (`execute_sql` errors out). Tell them to reconnect and rerun.
- The BetRO source root is missing.
- Git shows no changes **and** the conversation has no substantive implementation work — there's nothing to test. Output: "Nu am gasit nicio modificare in chat-ul curent. Spune-mi explicit ce sa acopere planul."
- Every change in the diff is backend-only / config-only / silent refactor with no user-visible effect — the plan would be empty. Output: "Modificarile din chat nu au efect vizibil pentru tester — sunt acoperite de testele automate. Vrei un plan tehnic in loc?"
