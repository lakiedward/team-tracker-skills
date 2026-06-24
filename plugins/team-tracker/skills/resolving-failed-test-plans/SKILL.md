---
name: resolving-failed-test-plans
description: Use when the user asks to fix, resolve, process, or sweep failed OR blocked steps from team-tracker testing plans — or invokes "/resolving-failed-test-plans". Plans live in Supabase (tt_test_plans / tt_test_items), per-project via project_id; the skill resolves the project from the cwd. Failures get fixed under the project source root and verified via Vite preview or SQL impersonation. Blocked steps are not skipped: it diagnoses why the tester got stuck, finishes the test, and resolves any defect that surfaces; only un-completable blockers (native push/biometrics/Apple Sign-In sheet, credentials, product decisions) stay blocked for a human. Triggers on "rezolvă planuri failed/blocate", "rezolvă pașii blocați", "fix failed or blocked test plans", "unblock test plans", "sweep team-tracker plans", "fix team tracker testing plans".
---

# Resolving Failed Test Plans

End-to-end sweep over team-tracker testing plans (which describe app behavior and are stored in the team-tracker Supabase database, not markdown files). Find the ones with **failed or blocked** steps, fix them on the current project's codebase with specialized subagents, verify via the most reliable channel for that step, and archive what is fully green. **Blocked steps are not left alone:** the skill reads *why* the tester got stuck, drives the step to completion through the supported channels (the block usually means the tester couldn't run it, not that the code is broken), and — if finishing it exposes a real defect — resolves that defect like any failure. Only blockers the skill genuinely cannot clear (native shell, missing credentials, product decisions, a real second device) stay blocked so the user can handle them manually.

## Why this skill exists

The user runs a separate React app called **team-tracker** (sibling of the project repos on the Desktop) that manages backlogs of test plans for *all* the user's apps. The plans and their steps live in the team-tracker Supabase (project ref `ntjzghsbrzkvpkniotaj`) in tables `tt_test_plans` and `tt_test_items` (the `tt_` prefix marks them as team-tracker's). Each step's `result` column gets updated to `pass`, `fail`, `blocked`, or `pending` after the tester runs through it.

**Multi-project scope:** team-tracker tracks plans for multiple apps — BetRO, Team Tracker, Popicu, Telegram Tips, Social, Padel, Culcush — each tagged via `tt_test_plans.project_id` → `tt_projects.id`. **This skill resolves the current project from the working directory in Step 0** and only processes plans for that project. Never touch rows where `project_id != <resolved>` — their code lives in a different repository this invocation cannot reach.

**Both plan types:** plans now carry a `test_type` of `'human'` (written by `/writing-tester-test-plans`, run by a human tester) or `'ai'` (written by `/writing-ai-test-plans`, run by `/auto-running-test-plans`). **This skill resolves BOTH** — it does NOT filter by `test_type`. A failed step is a failed step regardless of who ran it. The one rule that stays exactly as before: a plan is only processed when it is **complete** — every item is non-`pending` (`skip-incomplete` otherwise). `test_type` is read only to label each plan in the reports.

**Failed and blocked are both in scope.** A `fail` means the behavior was exercised and was wrong. A `blocked` means the tester (a human, or the `/auto-running-test-plans` runner) *could not finish the step at all*, so its real outcome is still unknown — `blocked` is **not** a verdict that the code is broken. This skill now picks up both: it resolves failures as before, **and** for each blocked step it diagnoses the blocker, finishes the test, and resolves any defect that completion reveals. A step stays `blocked` at the end only when the skill genuinely cannot drive it (native shell, real credentials, product decision, a second physical device).

Working through these failures and blockers one by one in the main thread blows the context window and loses parallelism. This skill industrializes the loop:

1. Query the DB once, classify all candidate plans — anything with a failed **or blocked** step is in scope.
2. Delegate the heavy lifting (investigation, fix design, implementation) to subagents — main thread keeps a clean orchestration view. For blocked steps the investigation first answers *why the tester got stuck*.
3. Verify via the channel that matches the step: **Vite preview for UI-visible work, SQL impersonation for RLS / database work**. For a blocked step this run is its **first real execution** — a clean pass clears the block, a failure reveals a defect to fix. Native-only behavior (push notifications, Apple Sign-In iOS sheet, Capacitor plugins, biometrics) cannot be verified by this skill — mark such steps `blocked` with a clear reason instead.
4. Archive only when all steps pass; leave the residual blocked steps (the ones the skill couldn't clear) alone so the user can finish them.

## Constants

| Item | Value |
|------|-------|
| Current project source root (where fixes land) | **resolved in Step 0** — the current working directory |
| team-tracker app (UI that owns the plans) | `C:/Users/lakie/Desktop/team-tracker` (don't modify unless directly relevant) |
| Supabase project id (holds tt_* tables) | `ntjzghsbrzkvpkniotaj` |
| `project_id` filter | **resolved in Step 0** from cwd — **always** include `WHERE project_id = <project_id>` in queries against `tt_test_plans` |
| `tt_projects` known rows | `1=BetRO/betro`, `2=Team Tracker/team_tracker`, `3=Popicu/popicu`, `4=Telegram Tips/telegram_tips`, `5=Social/social`, `6=Padel/padel`, `7=Culcush/culcush` |
| Migrations dir | `<source_root>/supabase/migrations/` (if the project uses Supabase) |
| Dev preview launch name | per project; look in `<source_root>/.claude/launch.json` (BetRO: `vite-dev` on port 3000; other projects may differ) |
| Native-only verification | not supported — steps that require native shell (push notifications, Apple Sign-In iOS sheet, biometrics, Capacitor plugins) must be marked `blocked` for a human tester. |
| Max retry cycles per failed step | 3 |
| `result` values that exist in the DB | `pending`, `pass`, `fail`, `blocked` (singular, not `passed`/`failed`) |

Do not ask the user to confirm any of these. If the Supabase MCP server is not connected or the resolved source root is missing, stop and tell the user with a one-line error.

## Step 0 — Resolve current project

The user works across multiple apps stored under `C:/Users/lakie/Desktop/`. Detect which one this invocation is for from the cwd, BEFORE any DB query, because the rest of the skill filters and operates by `<project_id>`.

```bash
basename "$(pwd)"
```

Then resolve via `mcp__supabase-mcp-server__execute_sql`:
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
- `cwd = C:\Users\lakie\Desktop\culcush` → dirname `culcush` → slug `culcush` → `id = 7`
- `cwd = C:\Users\lakie\Desktop\team-tracker` → dirname `team-tracker` → slug `team_tracker` → `id = 2`

Capture the returned `id` as `<project_id>` and the cwd as `<source_root>`. Use both throughout this skill — `<project_id>` in every `tt_test_plans` query, `<source_root>` in every file/Glob/Grep path, every `git -C` invocation, every subagent prompt.

If no row matches, abort: "Nu am putut identifica proiectul din folderul curent ('<dirname>'). Folderul ar trebui sa aiba numele slug-ului din tt_projects. Verifica, sau spune-mi explicit pe ce proiect sa rezolv planurile."

If the resolved project is not BetRO, also check that the project has the tooling this skill assumes (Vite preview, Supabase migrations, Capacitor mobile, etc.) by inspecting `<source_root>`. If a verification channel a step needs isn't available for the current project, mark those steps `blocked` with reason "Skill cannot verify this step type on project <slug>; needs human tester" rather than guessing.

## Step 1 — Bootstrap

Run these in parallel before anything else:

1. Confirm Supabase MCP is reachable (issue a tiny `list_tables` or trivial `execute_sql` ping if unsure). If it errors with "server disconnected", abort with: "Supabase MCP not connected — reconnect and rerun."
2. Confirm `<source_root>` (resolved in Step 0) exists (`Glob` on `<source_root>/package.json` or other root marker). If missing, abort with the same one-liner pattern.
3. Confirm preview MCP is reachable: `mcp__Claude_Preview__preview_list`. If the project's dev server isn't running, `mcp__Claude_Preview__preview_start name=<dev_server_name>` (read from `<source_root>/.claude/launch.json`). Capture the `serverId` for the rest of the run.

Then run the classification SQL (Step 2). Create a `TodoWrite` list with one entry per `process`-class plan as soon as you have the result. The list is your dashboard for the rest of the run — keep it current.

## Step 2 — Classify each candidate plan

Issue this single query to `mcp__supabase-mcp-server__execute_sql` (project_id `ntjzghsbrzkvpkniotaj`):

```sql
WITH plan_stats AS (
  SELECT
    p.id, p.title, p.area, p.priority, p.test_type, p.created_by, p.created_at,
    COUNT(i.id)                                                   AS total_items,
    SUM(CASE WHEN i.result = 'pending' THEN 1 ELSE 0 END)         AS pending_count,
    SUM(CASE WHEN i.result = 'pass'    THEN 1 ELSE 0 END)         AS pass_count,
    SUM(CASE WHEN i.result = 'fail'    THEN 1 ELSE 0 END)         AS fail_count,
    SUM(CASE WHEN i.result = 'blocked' THEN 1 ELSE 0 END)         AS blocked_count
  FROM tt_test_plans p
  LEFT JOIN tt_test_items i ON i.test_plan_id = p.id
  WHERE p.is_archived = FALSE
    AND p.project_id = <project_id>  -- resolved in Step 0 from cwd; ensures we only touch the current project's plans
    -- NO test_type filter: this skill resolves BOTH 'human' and 'ai' plans. test_type is selected only for reporting.
  GROUP BY p.id, p.title, p.area, p.priority, p.test_type, p.created_by, p.created_at
)
SELECT
  id, title, area, priority, test_type, created_by, created_at,
  total_items, pending_count, pass_count, fail_count, blocked_count,
  CASE
    WHEN total_items = 0                                  THEN 'skip-empty'
    WHEN pending_count > 0                                THEN 'skip-incomplete'
    WHEN fail_count > 0 OR blocked_count > 0              THEN 'process'  -- failed AND blocked steps are both worked
    WHEN pass_count = total_items                         THEN 'all-green-should-archive'
    ELSE 'unknown'
  END AS class
FROM plan_stats
ORDER BY class, created_at DESC;
```

Map the result rows to classes:

| Class | Rule | Action |
|-------|------|--------|
| `skip-empty` | Plan with zero items. | Drop silently. |
| `skip-incomplete` | At least one `pending` item — tester not done. | Drop silently. The user wants only **complete** plans. |
| `all-green-should-archive` | Every item `pass`, but plan still flagged `is_archived = FALSE`. | Add to a "quick archive" sub-queue — handled inline in Step 4 with a single UPDATE. No fix work needed. |
| `process` | Complete, non-archived, has at least one `fail` **or `blocked`** item. | Add to the main work queue. Failed steps get fixed; blocked steps get diagnosed and finished (see Step 3). |

After classification, print a compact table to the user — id, test_type, title, fail/blocked counts, class — so they see the scope (and which plans are human vs AI). Two lines: the table, then "Starting work on N plans" and proceed. Do not stop for confirmation; the user invoked the skill explicitly.

For each `process` plan, fetch the item-level detail (description, expected_result, notes, result, tested_at) for **every `fail` and `blocked` item** in one SQL call. The notes column is where the tester documented what happened — for a `fail` it often holds the root-cause hypothesis and screenshots; for a `blocked` it holds *the reason they stopped* (the blocker). Mine it before dispatching subagents: the blocker reason decides whether the skill can finish the step or must leave it blocked.

## Step 3 — Process each plan

Iterate the `process` queue **sequentially** — plans may touch overlapping code. **Do parallelize the subagent calls within a single plan** when they're independent.

For each plan, for each `fail` **or `blocked`** item:

### 3·triage — Is this a `fail` or a `blocked`? (do this first)

- **`fail`** → the behavior was exercised and was wrong. Run 3a–3e exactly as before; this is the skill's original flow, unchanged.
- **`blocked`** → the tester could **not finish the step**, so its true outcome is unknown. First read the item `notes` — that is where they recorded *why* they stopped — and classify the blocker:

  | Blocker (from the notes / your read of the step) | Skill can clear it? | What to do |
  |---|---|---|
  | Tester didn't know how to reach a screen, which control to use, or what data to enter | **Yes** | Drive the step yourself via the matching channel (run 3a→3d). The verification run **is** the step's first real execution. |
  | Step depended on an earlier step that failed | **Usually** | Resolve that upstream `fail` first (it's another item in this same plan), then run this step. |
  | "Necesită al doilea cont" / "2 device-uri" / RLS / cross-account visibility | **Yes** | Finish it via **SQL impersonation** — the supported single-device replica of the cross-user path. |
  | Transient / "nu mergea atunci" / a precondition or seed data wasn't set up | **Yes** | Set up the precondition (seed via SQL), then run the step. |
  | Native shell: push/FCM, Face ID, biometrics, Apple Sign-In native sheet, share sheet, file picker, OS deep link | **No** | Keep `blocked`; refine the reason. The native shell isn't in the browser DOM. |
  | Needs real credentials, a paid third-party, a product decision, or infra access the skill lacks | **No** | Keep `blocked`; refine the reason. |

  If the blocker is **clearable**, run 3a–3d to *finish the test*, then let its real outcome decide the update (3e):
  - Behaves correctly when driven to completion → mark `pass` **with evidence**. Never flip a `blocked` to `pass` without actually running it.
  - Completion exposes a real defect → it is effectively a `fail`: design and apply a fix (3b–3c), re-verify (3d), then `pass`.
  - You genuinely cannot drive it with the supported channels → keep `blocked` (3e) with a one-line refined reason stating what a human or device must do next.

### 3a. Investigation — dispatch in parallel

Send these two subagents in the **same message**:

- **`feature-dev:code-explorer`** — "Trace the code path involved in this failed step in the `<project_name>` repo at `<source_root>`. Plan title: `<title>`. Step description: `<verbatim>`. Expected result: `<verbatim>`. Tester notes (often contains root-cause hypothesis): `<verbatim>`. Map the relevant files under `<source_root>` (look in `src/`, `supabase/functions/`, `supabase/migrations/`, or whatever subdirs the project uses). Report under 350 words: which files, what runs, what likely broke, and the smallest reproducer. **For RLS / database steps, do NOT trust migration grep alone — verify `pg_policy` and `pg_class.relrowsecurity` live via SQL before claiming a table has no RLS.**"
- **`Explore`** — "Find any recent changes around `<feature area>` in the `<project_name>` repo at `<source_root>`. Search git log for the last 14 days and grep for symbols mentioned in the failed step. Under 150 words: changed files, suspect commits."

The `Explore` agent finds the surface area; the `code-explorer` agent traces semantics. Both share the failed (or blocked) step context. **For a `blocked` item**, append to both prompts: *the tester could not finish this step; the blocker reason from their notes is `<verbatim>`; tell me how to complete the step and whether the underlying behavior actually works once it runs.* The italicized clause above exists because a previous run took a code-explorer's "tickets has no RLS" claim at face value and shipped a half-fix; the tickets table did have RLS, defined in an unrelated migration.

### 3b. Design the fix — dispatch one subagent (or do it inline if the path is obvious)

Once 3a returns, if the fix path is non-trivial, dispatch **`feature-dev:code-architect`**:

> "Based on this investigation: `<paste explorer + code-explorer outputs>`. Design the smallest fix that makes the step pass (for a blocked item, the defect that surfaced once the step was driven to completion). Files involved: `<list>`. Report under 300 words with: 1) Root cause in one sentence, 2) Files to change with line ranges, 3) Exact code/text changes (not pseudo — final SQL bodies, final edited TS lines), 4) Whether this risks regressing other steps in the same plan, 5) Verification strategy (preview, SQL impersonation, or device)."

If the architect reports that the root cause is **unknown**, **requires credentials**, **requires a product decision**, or **needs infrastructure access**: mark the item as `blocked` (Step 3e) with a one-line reason. **Do not attempt the fix.**

When the path is obvious (e.g. a string replacement in a translation file, or a normalizer regex extension), skip the architect dispatch and proceed straight to 3c. Save the architect for designs that span migrations + multiple files, or for changes whose blast radius is unclear.

### 3c. Apply the fix — main thread

Apply the fix yourself with `Edit` / `Write` / `mcp__supabase-mcp-server__apply_migration`. Do not delegate edits unless the change spans more than 5 files.

After editing, run any obviously relevant local checks:
- Migration applied → re-query `pg_policy` / helper function definitions to confirm the new state in DB.
- Frontend TypeScript touched → `npx tsc --noEmit 2>&1 | grep -E "<touched-file-substring>"` (only the affected file) — if the project has many pre-existing TS errors, grep narrows the noise.
- Lint guard, if relevant to the area touched (`npm run lint:no-emoji`, `npm run lint:no-indigo`, etc., per BetRO's CLAUDE.md).

If a check goes red, loop once back to 3b with the new error before falling through to "blocked."

### 3d. Verify — pick the right channel for this step

Pick the verification channel based on the step content. **Only two channels are supported by this skill:**

1. **Vite preview (`mcp__Claude_Preview__*`)** — first choice for any step that describes UI behavior (tabs, cards, buttons, text in screens, AI analysis output). The web build the preview serves is the same React/Vue/Svelte code that ships to users. Use `preview_start` with the launch name from `<source_root>/.claude/launch.json`, then drive with `preview_click` (CSS selectors / text-based selectors), `preview_fill` (form inputs), `preview_snapshot` (read the accessibility tree to verify visible text), `preview_inspect` (CSS property assertions), `preview_screenshot` (proof), `preview_console_logs level: error` (catch runtime regressions). Never use `preview_eval` to perform clicks — it bypasses event handlers and gives false positives; reserve `preview_eval` for navigation, scrolling, and pure inspection.

2. **SQL impersonation** — first choice for any step that depends on RLS, realtime broadcast, or per-user database visibility. Inside a single transaction, `SET LOCAL ROLE authenticated` and `SET LOCAL "request.jwt.claims" = '{"sub":"<user-uuid>","role":"authenticated"}'`, then run the SELECT/INSERT/UPDATE that the policy gates, then `ROLLBACK`. This is exactly what Supabase Realtime does per subscriber when it decides whether to broadcast a row change — it is the most faithful simulation of cross-account behavior achievable without a real second device. Use it for steps that explicitly say "necesita al doilea cont" / "2 device-uri" / RLS-related assertions.

**Native-only steps are NOT verifiable by this skill.** If a failed step describes behavior that lives in the native shell (push notifications, Apple Sign-In iOS sheet, Face ID, biometrics, Capacitor plugins, share sheet, file picker, OS-level deep links), mark it `blocked` with reason `"Needs real device; preview cannot reproduce native behavior."` instead of trying. The user follow-up for these is a manual run on a phone or a different skill.

**For a `blocked` item, this verification is the step's first real execution** — the tester never got a clean result, so its outcome is the source of truth. A clean pass clears the block (→ `pass` at 3e). A failure means there is a real defect: loop back to 3b–3c, fix it, then re-verify here. If the supported channels cannot drive the step at all (native shell, real credentials, product decision), it stays `blocked` (3e) with the refined reason from the 3·triage taxonomy — do not guess a `pass`.

For each verification, capture concrete evidence: a console log snippet, a `body.innerText` slice, an `INSERT ... RETURNING` row, or a screenshot path. The evidence is what you paste into the item's `notes` column at 3e.

If verification fails after up to 3 retry cycles, classify the item as `blocked` with a reason and move on. Do not enter an infinite retry loop.

### 3e. Update the item in the database

On verification success, UPDATE the item:

```sql
UPDATE tt_test_items
SET
  result = 'pass',
  notes = notes || E'\n\n--- Resolved <YYYY-MM-DD> (Claude Code automation) ---\n<one-paragraph summary including: whether this was a `fail` or a previously-`blocked` step — and if blocked, what the blocker was and how you unblocked/finished it; which files/migrations touched; the verification channel used; a verbatim slice of the evidence>',
  tested_by = 'Claude Code (automation)',
  tested_at = now(),
  updated_at = now()
WHERE id = <item_id>
RETURNING id, test_plan_id, result, tested_at;
```

On verification failure, or a blocker the skill genuinely cannot clear:

```sql
UPDATE tt_test_items
SET
  result = 'blocked',
  notes = notes || E'\n\n--- Blocked <YYYY-MM-DD> (Claude Code automation) ---\n<one-sentence refined reason: WHY the skill cannot finish it and what a human/device must do next — native shell / needs credentials / product decision / infrastructure / true second physical device>',
  tested_at = now(),
  updated_at = now()
WHERE id = <item_id>
RETURNING id, test_plan_id, result;
```

Do not edit any markdown file — the plan does not live in a file. Do not touch other items in the same plan.

## Step 4 — Archive or keep

After processing every `fail` and `blocked` item in a plan, re-aggregate:

```sql
SELECT
  SUM(CASE WHEN result = 'pass'    THEN 1 ELSE 0 END) AS pass,
  SUM(CASE WHEN result = 'fail'    THEN 1 ELSE 0 END) AS fail,
  SUM(CASE WHEN result = 'blocked' THEN 1 ELSE 0 END) AS blocked,
  SUM(CASE WHEN result = 'pending' THEN 1 ELSE 0 END) AS pending
FROM tt_test_items WHERE test_plan_id = <plan_id>;
```

- **All items pass, zero blocked, zero pending → archive.**
  ```sql
  UPDATE tt_test_plans
  SET is_archived = TRUE, updated_at = NOW()
  WHERE id = <plan_id>
    AND NOT EXISTS (SELECT 1 FROM tt_test_items WHERE test_plan_id = <plan_id> AND result != 'pass')
  RETURNING id, title, is_archived;
  ```

- **At least one item is still blocked → do not archive.** These are the residual blockers the skill could not clear (native shell, credentials, product decision, real second device) — every clearable block should already be `pass` by now. Leave the plan with the new mix. Mark its `TodoWrite` entry completed but tag the activeForm with "(blocked — left for user)" so the final summary surfaces it.

For the `all-green-should-archive` sub-queue from Step 2, run the same archive UPDATE — no investigation, no fix, no verification needed. These plans were missed by an earlier sweep or by a tester who marked everything green but did not flip the archive flag.

## Step 5 — Final report

After every plan is processed, print a single compact summary in the main thread:

```
Test plan sweep — <YYYY-MM-DD>

Archived (N):
  - #<id>  [<test_type>]  <title>  (resolved: F fails fixed, B blocks cleared)   [or "(all-green pickup)" for the sub-queue]
  - ...

Left blocked (M):
  - #<id>  [<test_type>]  <title>  (Q still blocked: <one-line refined reason aggregated>)
  - ...

Skipped (incomplete, empty): K
```

That's the sweep summary. Follow it with the testing recommendation (Step 6) — the last thing you print. No other epilogue; the user knows what to do with the blocked list.

## Step 6 — Recommend follow-up testing (final output)

After the sweep summary, print ONE short recommendation: which test plan(s), if any, are worth writing for the code you changed while resolving these plans, and for what's still blocked. Reserve a **real human tester for what nothing else can exercise** — `/writing-tester-test-plans` (test_type `human`) is the expensive last resort; the default is `/writing-ai-test-plans` (test_type `ai`), which `/auto-running-test-plans` re-runs unattended.

| What this sweep produced | Recommend | Why |
|---|---|---|
| Failed/blocked steps you **fixed + re-verified** via **Vite preview** or **SQL impersonation**, that the resolved plan can't auto-cover later (it was a `human` plan, or the fix touched behavior beyond the plan's steps) | **`/writing-ai-test-plans`** | An AI mirror lets `/auto-running-test-plans` guard the regression unattended next time, instead of waiting on a human re-run. |
| **Residual `blocked` steps you could not clear** — native shell (push, biometrics, Apple Sign-In sheet), a **real second device**, real credentials, or a **subjective visual / UX** check | **`/writing-tester-test-plans`** (or a manual device run) | Exactly the steps outside the browser DOM and SQL — only a person on a real device finishes them. The "ultra nevoie" case. |
| Both occurred this sweep | **Ambele** — an AI plan for the web/DB fixes, a human plan only for the residual native/subjective blockers | Don't make a human re-test what the AI can run; don't pretend the AI reaches the native shell. |
| Everything was an all-green pickup (just archived), or the fixes are already covered by the resolved `ai` plan | **Niciun test nou** — say so | The existing `ai` plan already re-runs those steps; a duplicate adds QA noise. |

**Default & tie-breaker:** the AI plan is the floor for any fix that changed user-visible behavior reproducible in the browser or DB and that the resolved plan won't auto-cover — even if you happened to verify it another way (tsc, a unit test, a one-off script). Escalate to a human tester only for a residual blocker that genuinely can't be reached without a real device, real credentials, or a subjective judgment; recommend "niciun test nou" only when it was an all-green pickup, or the resolved `ai` plan already covers it.

Then print exactly this block, in Romanian, as the final output of the run:

```
Recomandare testare:
  → <AI | Uman | Ambele | Niciun test nou>
  Motiv: <o propoziție, legată de canalul de verificare de mai sus>
  De rulat: < /writing-ai-test-plans · /writing-tester-test-plans · ambele · — >
  Acoperă: <plan #id-uri / pașii sau zonele pe care planul trebuie să le acopere>
```

No epilogue after this block.

## Subagent dispatch reference

Always brief the subagent like a colleague walking in cold. Include: the step description verbatim (whether it's `fail` or `blocked`), expected_result verbatim, tester notes verbatim (the root-cause hypothesis for a `fail`, the blocker reason for a `blocked`), where to look (paths under `<source_root>/` — the project resolved in Step 0), and the response length limit. The subagent has zero memory of this conversation.

Launch independent investigations as multiple `Agent` tool calls in **one message** so they run concurrently. Wait for both before dispatching the architect step.

## Verification channel quick-reference

| Step type | Verify via | Why |
|-----------|------------|-----|
| UI text, tabs, cards, AI analysis output | Vite preview + `preview_eval` reading `document.body.innerText` | Same React code, fast HMR, no device flakiness |
| RLS / realtime / cross-account visibility | SQL impersonation via `SET LOCAL request.jwt.claims` | Exact replica of Supabase Realtime per-subscriber RLS check |
| Edge function / API response | Direct call via `execute_sql` or fetch from preview | Deterministic, isolated |
| Push notification, biometrics, share sheet, native Apple Sign-In sheet, Face ID | **NOT supported** — mark `blocked` | Requires native shell; this skill does not drive real devices |
| "2 device-uri" / "al doilea cont" steps with a single device | SQL impersonation (read **and** write) | The only single-device replica that actually exercises the cross-user policy path |
| `blocked` step (tester got stuck — not a native/credential blocker) | Same channel as the step's behavior (preview or SQL impersonation); this run **is** the step's first real execution | A tester's `blocked` usually means *they* couldn't drive it, not that the code is broken — finish it before concluding |

## Mistakes to avoid

| Mistake | Why it hurts | Fix |
|---------|--------------|-----|
| Treating tt_test_plans as markdown | Skill used to be written for file-based plans; the source of truth is the DB. | Always go through SQL. |
| Status mismatch: `passed`/`failed` vs `pass`/`fail` | The DB uses singular forms. Plural strings will never match. | Hardcode the singular forms in your queries. |
| Trusting a code-explorer "no RLS" claim without verifying `pg_policy` and `relrowsecurity` | Migration grep misses policies created in unrelated migrations. | After any RLS-related fix, query `pg_policy` directly to confirm the live state. |
| Designing an INSERT policy that JOINs a table with its own RLS | The JOIN is evaluated in the subscriber's context and gets blocked. | Wrap the visibility check in a SECURITY DEFINER helper; have the policy call the helper. |
| Trying to verify a native-only behavior in preview | The native shell (push, biometrics, OAuth sheets) is not in the browser DOM; you'll get a misleading false fail. | Detect native-only keywords (push, FCM, biometric, Face ID, Apple Sign-In native, share sheet) early and mark the step `blocked` with the right reason instead. |
| Leaving a tester's `blocked` step untouched | Finishing those steps is the whole point of this update. A `blocked` from a human or the AI runner usually means *they* got stuck, not that the behavior is broken. | Read the notes for the blocker, then drive the step to completion via preview/SQL (3·triage) before concluding anything. |
| Flipping a `blocked` step to `pass` without running it | `blocked` means it was never cleanly executed; a rubber-stamp `pass` ships a plan that lies about state. | Actually complete the step and capture evidence first — same bar as a `fail`. |
| Burning retry cycles on a native / credential / product-decision blocker | Preview can't reach the native shell and you can't conjure credentials; the cycles are wasted. | Route via the 3·triage taxonomy: those blockers stay `blocked` with a refined reason, no retry loop. |
| Using `preview_eval` to perform clicks | Bypasses React event handlers; gives false positives. | Use `preview_click` with a stable selector; reserve `preview_eval` for navigation and read-only inspection. |
| Archiving a plan with any blocked item | The user explicitly wants blocked plans visible. | Archive only when zero blocked and zero pending. |
| Looping forever on a stubborn step | Wastes time, won't converge. | 3 retry cycles max, then mark blocked and move on. |
| Parallelizing across plans | Plans often touch overlapping code; the device is single-tenant. | Sequential across plans, parallel within a plan. |
| Re-running searches the subagent already did | Burns the context window for no signal. | Trust the subagent's report; only re-verify a specific assertion (RLS state, file path) when you have a concrete reason to doubt. |
| Editing a plan's items before verification succeeds | Creates plans that lie about state. | Update item rows only in Step 3e, after evidence is in hand. |
| Updating the team-tracker app's source code | The plans live in DB, owned by team-tracker; the project resolved in Step 0 is where fixes belong. | Fix code under `<source_root>`; never modify team-tracker source unless the user asks. |
| Running the skill on plans for a different project than the cwd | Subagents investigate the wrong codebase, fixes land in the wrong repo. | Step 0 resolves `<project_id>` from cwd and Step 2's SQL filter keeps work scoped. If the user wants a different project, ask them to `cd` into that project first. |

## When the skill should self-abort

Stop immediately and report to the user when any of these happen:
- The Supabase MCP server is disconnected (or `execute_sql` errors out repeatedly).
- The resolved `<source_root>` is missing or unreadable.
- Step 0 cannot resolve the cwd to a `tt_projects` row.
- The classification query returns zero `process` rows (no plan has a failed or blocked step) AND zero `all-green-should-archive` rows. (Empty work queue. Say so and stop.)
- The first plan's investigation subagent crashes with a tool-permission error you cannot work around.

In each case, output a single sentence describing what blocked you and what the user needs to do.

---

## Orchestrator target mode (single item)

Această secțiune se activează **exclusiv** când invocarea primește toți cei trei parametri:
`TARGET_PROJECT_ID`, `TARGET_SOURCE_ROOT`, și `TARGET_ITEM_ID` (pasați de Dispecer).
Dacă oricare lipsește, skill-ul rulează flow-ul normal de sweep de mai sus (neschimbat).

Aici `TARGET_ITEM_ID` este **`test_plan_id`-ul unui singur plan** — procesezi toate itemele `fail` și
`blocked` ale ACELUI plan, exact ca în sweep, dar pentru un singur plan în loc de toate.

### Parametri primiți de la Dispecer

| Parametru | Tip | Descriere |
|---|---|---|
| `TARGET_PROJECT_ID` | number | `project_id` al proiectului; înlocuiește rezolvarea din Step 0 |
| `TARGET_SOURCE_ROOT` | string | Calea absolută a repo-ului sursă **sau a worktree-ului** izolat; înlocuiește cwd-ul din Step 0. Acest skill MODIFICĂ cod (repară defecte), deci primește un worktree ca bug-urile/feature-urile — toate `Edit`/`Write`/`Glob`/`git` se fac în această cale. |
| `TARGET_ITEM_ID` | number | `id`-ul exact al **planului** (`tt_test_plans.id`) de procesat; înlocuiește clasificarea în masă din Step 2 |
| `TARGET_PREVIEW_SERVER_ID` | string | (opțional) `serverId`-ul unui preview deja pornit; dacă e dat, **nu porni și nu opri preview-ul** — lease-ul e deținut de Dispecer |

### Modificări față de flow-ul normal

**Sari peste Step 0** — nu mai detectezi proiectul din cwd. Folosești direct:
- `<project_id>` = `TARGET_PROJECT_ID`
- `<source_root>` = `TARGET_SOURCE_ROOT` (worktree-ul — toate fix-urile aterizează aici)

**Sari peste clasificarea în masă din Step 2** — nu mai rulezi query-ul peste toate planurile.
Rulezi aceeași clasificare dar **filtrată pe un singur plan** (adaugă `AND p.id = <TARGET_ITEM_ID>`):

```sql
WITH plan_stats AS (
  SELECT
    p.id, p.title, p.area, p.priority, p.test_type, p.created_by, p.created_at,
    COUNT(i.id)                                                   AS total_items,
    SUM(CASE WHEN i.result = 'pending' THEN 1 ELSE 0 END)         AS pending_count,
    SUM(CASE WHEN i.result = 'pass'    THEN 1 ELSE 0 END)         AS pass_count,
    SUM(CASE WHEN i.result = 'fail'    THEN 1 ELSE 0 END)         AS fail_count,
    SUM(CASE WHEN i.result = 'blocked' THEN 1 ELSE 0 END)         AS blocked_count
  FROM tt_test_plans p
  LEFT JOIN tt_test_items i ON i.test_plan_id = p.id
  WHERE p.is_archived = FALSE
    AND p.project_id = <TARGET_PROJECT_ID>
    AND p.id = <TARGET_ITEM_ID>
  GROUP BY p.id, p.title, p.area, p.priority, p.test_type, p.created_by, p.created_at
)
SELECT id, title, area, priority, test_type, created_by, created_at,
       total_items, pending_count, pass_count, fail_count, blocked_count
FROM plan_stats;
```

Dacă rândul nu există, e arhivat, are iteme `pending` (plan incomplet), sau nu are niciun `fail`/`blocked`
→ întoarce imediat JSON cu `outcome="blocked"`,
`question="Planul #<id> nu există / e incomplet / nu are pași failed sau blocked în DB."`.

**Step 3 (3·triage, 3a–3d) și Step 4 (re-agregare) sunt identice** cu flow-ul normal — procesezi toate
itemele `fail`/`blocked` ale planului cu aceeași calitate de investigație, același canal de verificare,
și aceeași logică de retry (max 3 cicluri). Toate edit-urile de cod se fac în `TARGET_SOURCE_ROOT` (worktree-ul).

**În target mode scrii itemele planului ca de obicei (Step 3e: `tt_test_items.result='pass'`/`'blocked'` cu
notă + evidență) — Dispecerul NU deține write-back-ul la nivel de item de test. DAR NU arhiva planul (Step 4)
și NU printa raportul Step 5; arhivarea/raportarea le gestionează Dispecerul după ce face merge la worktree.**

**Preview (dacă necesar):** dacă `TARGET_PREVIEW_SERVER_ID` este dat, **refolosește-l direct** — nu chema
`preview_start`/`preview_stop`; lease-ul e al Dispecerului și e serializat pe rundă. Dacă lipsește și un pas
cere verificare pe preview, pornește preview-ul normal (Step 1 pct. 3) — ești în modul standalone.

**Nu printa raportul Step 5/6** (tabelul de sweep + recomandarea). În loc de raport, **întoarce un JSON
structurat ca ULTIM mesaj** (vezi mai jos).

### Output structurat — ultimul mesaj

Întoarce **exact** acest JSON ca ultimul mesaj (fără text în afara blocului JSON):

```json
{
  "item_id": <TARGET_ITEM_ID>,
  "outcome": "done|blocked",
  "verify_channel": "preview|sql|none",
  "test_recommendation": "none",
  "effort": "<low|medium|high|xhigh|max|ultracode>",
  "summary": "<un paragraf: ce pași failed/blocked s-au rezolvat, ce fișiere/migrări s-au atins, canalul de verificare, o felie de dovadă>",
  "question": "<dacă outcome=blocked: întrebarea concretă pentru user — ce blocaj rezidual rămâne; altfel câmpul lipsește sau e șir gol>"
}
```

Valori valide:
- `outcome`: `"done"` când **toți** pașii `fail`/`blocked` ai planului au fost rezolvați și sunt acum `pass`
  (planul e gata de arhivat — dar arhivarea o face Dispecerul după merge); `"blocked"` dacă a rămas cel puțin
  un blocaj rezidual pe care skill-ul nu-l poate clarifica (native shell, credențiale, decizie de produs,
  al doilea device fizic) SAU dacă fix-ul cere o acțiune ireversibilă (vezi mai jos). Notă: planurile de test
  folosesc `"done"` (nu `"fixed"` care e specific bug-urilor).
- `verify_channel`: canalul folosit efectiv în 3d (`"preview"`, `"sql"`, sau `"none"` dacă n-a ajuns la verificare).
- `test_recommendation`: **întotdeauna `"none"`** — testele nu nasc alte teste. Nu recomanda planuri de test
  pentru un skill care rezolvă planuri de test.
- `effort`: nivelul de efort estimat pentru reparațiile făcute (din investigație), pe scala efortului.
- `summary`: rezumatul compactat (ce pași s-au reparat + fișiere/migrări + canal + dovadă), max 3 propoziții.
- `question`: prezent și non-gol **doar** când `outcome="blocked"` — întrebarea precisă pentru user.

**Reguli de incertitudine → park:** dacă un fix cere o acțiune **ireversibilă** (migrare DB / ștergere de
date / push la remote / trimitere în afara sistemului), sau e prea vag / are mai multe interpretări, sau
skill-ul și-a epuizat cele max 3 cicluri de retry, sau ai încredere mică — NU ghici și NU executa acțiunea
ireversibilă: întoarce `outcome="blocked"` cu o `question` clară.

**Câmpurile `worktree` și `branch`** (Milestone C, worktree-uri izolate): dacă promptul Dispecerului îți dă
o cale de worktree și un branch `orch/<id>` (și-ți cere explicit să le incluzi), emite-le **verbatim** în JSON
(`worktree="<calea>"`, `branch="orch/<id>"`). În modul standalone fără worktree (`TARGET_SOURCE_ROOT` = chiar
repo-ul), lasă-le goale sau omite-le. Promptul Dispecerului poate cere și un câmp boolean `needs_preview` —
setează-l `true` dacă verificarea cere preview UI (Dispecerul o serializează), altfel `false`.
