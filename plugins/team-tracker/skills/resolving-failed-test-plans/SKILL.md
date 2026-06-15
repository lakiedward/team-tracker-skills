---
name: resolving-failed-test-plans
description: Use when the user asks to fix, repair, resolve, process, or sweep failed steps from team-tracker testing plans — or invokes "/resolving-failed-test-plans". Plans live in Supabase tables (tt_test_plans / tt_test_items), scoped per-project via project_id. Resolves the current project from the cwd, discovers every complete, non-archived plan with failed steps for that project, dispatches subagents to investigate each failure, designs a fix, implements it under the project's source root, verifies via Vite preview (or SQL impersonation for RLS / database steps), then archives the plan if every step now passes. Native-only steps (push, biometrics, Apple Sign-In native sheet) are marked blocked for human follow-up. Triggers on "rezolvă planuri failed", "fix failed test plans", "process failed plans", "sweep team-tracker plans", "archive resolved test plans", "rezolvă pașii failed din planuri", "fix team tracker testing plans".
---

# Resolving Failed Test Plans

End-to-end sweep over team-tracker testing plans (which describe BetRO behavior and are stored in the BetRO Supabase database, not markdown files). Find the ones with failed steps, fix them on the BetRO codebase with specialized subagents, verify via the most reliable channel for that step, and archive what is fully green. Plans that turn out to be blocked stay where they are so the user can handle them manually.

## Why this skill exists

The user runs a separate React app called **team-tracker** (sibling of the project repos on the Desktop) that manages backlogs of test plans for *all* the user's apps. The plans and their steps live in the team-tracker Supabase (project ref `ntjzghsbrzkvpkniotaj`) in tables `tt_test_plans` and `tt_test_items` (the `tt_` prefix marks them as team-tracker's). Each step's `result` column gets updated to `pass`, `fail`, `blocked`, or `pending` after the tester runs through it.

**Multi-project scope:** team-tracker tracks plans for multiple apps — BetRO, Team Tracker, Popicu, Telegram Tips, Social, Padel, Culcush — each tagged via `tt_test_plans.project_id` → `tt_projects.id`. **This skill resolves the current project from the working directory in Step 0** and only processes plans for that project. Never touch rows where `project_id != <resolved>` — their code lives in a different repository this invocation cannot reach.

**Both plan types:** plans now carry a `test_type` of `'human'` (written by `/writing-tester-test-plans`, run by a human tester) or `'ai'` (written by `/writing-ai-test-plans`, run by `/auto-running-test-plans`). **This skill resolves BOTH** — it does NOT filter by `test_type`. A failed step is a failed step regardless of who ran it. The one rule that stays exactly as before: a plan is only processed when it is **complete** — every item is non-`pending` (`skip-incomplete` otherwise). `test_type` is read only to label each plan in the reports.

Working through these failures one by one in the main thread blows the context window and loses parallelism. This skill industrializes the loop:

1. Query the DB once, classify all candidate plans.
2. Delegate the heavy lifting (investigation, fix design, implementation) to subagents — main thread keeps a clean orchestration view.
3. Verify via the channel that matches the step: **Vite preview for UI-visible work, SQL impersonation for RLS / database work**. Native-only behavior (push notifications, Apple Sign-In iOS sheet, Capacitor plugins, biometrics) cannot be verified by this skill — mark such steps `blocked` with a clear reason instead.
4. Archive only when all steps pass; leave blocked plans alone so the user can finish them.

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
    WHEN fail_count > 0                                   THEN 'process'
    WHEN blocked_count > 0 AND fail_count = 0             THEN 'skip-blocked-only'
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
| `skip-blocked-only` | All non-`pass` items are `blocked`; no `fail`. | Drop with a one-line note in the final report. |
| `all-green-should-archive` | Every item `pass`, but plan still flagged `is_archived = FALSE`. | Add to a "quick archive" sub-queue — handled inline in Step 4 with a single UPDATE. No fix work needed. |
| `process` | Complete, non-archived, has at least one `fail` item. | Add to the main work queue. |

After classification, print a compact table to the user — id, test_type, title, fail/blocked counts, class — so they see the scope (and which plans are human vs AI). Two lines: the table, then "Starting work on N plans" and proceed. Do not stop for confirmation; the user invoked the skill explicitly.

For each `process` plan, fetch the item-level detail (description, expected_result, notes, result, tested_at) in one SQL call. The notes column is where the tester documented the failure — frequently it already contains the root-cause hypothesis and screenshots; mine it before dispatching subagents.

## Step 3 — Process each plan

Iterate the `process` queue **sequentially** — plans may touch overlapping code. **Do parallelize the subagent calls within a single plan** when they're independent.

For each plan, for each `fail` item:

### 3a. Investigation — dispatch in parallel

Send these two subagents in the **same message**:

- **`feature-dev:code-explorer`** — "Trace the code path involved in this failed step in the `<project_name>` repo at `<source_root>`. Plan title: `<title>`. Step description: `<verbatim>`. Expected result: `<verbatim>`. Tester notes (often contains root-cause hypothesis): `<verbatim>`. Map the relevant files under `<source_root>` (look in `src/`, `supabase/functions/`, `supabase/migrations/`, or whatever subdirs the project uses). Report under 350 words: which files, what runs, what likely broke, and the smallest reproducer. **For RLS / database steps, do NOT trust migration grep alone — verify `pg_policy` and `pg_class.relrowsecurity` live via SQL before claiming a table has no RLS.**"
- **`Explore`** — "Find any recent changes around `<feature area>` in the `<project_name>` repo at `<source_root>`. Search git log for the last 14 days and grep for symbols mentioned in the failed step. Under 150 words: changed files, suspect commits."

The `Explore` agent finds the surface area; the `code-explorer` agent traces semantics. Both share the failed step context. The italicized clause above exists because a previous run took a code-explorer's "tickets has no RLS" claim at face value and shipped a half-fix; the tickets table did have RLS, defined in an unrelated migration.

### 3b. Design the fix — dispatch one subagent (or do it inline if the path is obvious)

Once 3a returns, if the fix path is non-trivial, dispatch **`feature-dev:code-architect`**:

> "Based on this investigation: `<paste explorer + code-explorer outputs>`. Design the smallest fix that makes the failed step pass. Files involved: `<list>`. Report under 300 words with: 1) Root cause in one sentence, 2) Files to change with line ranges, 3) Exact code/text changes (not pseudo — final SQL bodies, final edited TS lines), 4) Whether this risks regressing other steps in the same plan, 5) Verification strategy (preview, SQL impersonation, or device)."

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

For each verification, capture concrete evidence: a console log snippet, a `body.innerText` slice, an `INSERT ... RETURNING` row, or a screenshot path. The evidence is what you paste into the item's `notes` column at 3e.

If verification fails after up to 3 retry cycles, classify the item as `blocked` with a reason and move on. Do not enter an infinite retry loop.

### 3e. Update the item in the database

On verification success, UPDATE the item:

```sql
UPDATE tt_test_items
SET
  result = 'pass',
  notes = notes || E'\n\n--- Resolved <YYYY-MM-DD> (Claude Code automation) ---\n<one-paragraph fix summary including: which files/migrations touched, the verification channel used, a verbatim slice of the evidence>',
  tested_by = 'Claude Code (automation)',
  tested_at = now(),
  updated_at = now()
WHERE id = <item_id>
RETURNING id, test_plan_id, result, tested_at;
```

On verification failure / blocked path:

```sql
UPDATE tt_test_items
SET
  result = 'blocked',
  notes = notes || E'\n\n--- Blocked <YYYY-MM-DD> (Claude Code automation) ---\n<one-sentence reason: needs credentials / product decision / infrastructure / cannot reproduce on single device without N>',
  tested_at = now(),
  updated_at = now()
WHERE id = <item_id>
RETURNING id, test_plan_id, result;
```

Do not edit any markdown file — the plan does not live in a file. Do not touch other items in the same plan.

## Step 4 — Archive or keep

After processing every `fail` item in a plan, re-aggregate:

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

- **At least one item is blocked → do not archive.** Leave the plan with the new mix. Mark its `TodoWrite` entry completed but tag the activeForm with "(blocked — left for user)" so the final summary surfaces it.

For the `all-green-should-archive` sub-queue from Step 2, run the same archive UPDATE — no investigation, no fix, no verification needed. These plans were missed by an earlier sweep or by a tester who marked everything green but did not flip the archive flag.

## Step 5 — Final report

After every plan is processed, print a single compact summary in the main thread:

```
Test plan sweep — <YYYY-MM-DD>

Archived (N):
  - #<id>  [<test_type>]  <title>  (fixed: K items)    [or "(all-green pickup)" for the sub-queue]
  - ...

Left blocked (M):
  - #<id>  [<test_type>]  <title>  (Q blocked: <one-line reason aggregated>)
  - ...

Skipped (incomplete, blocked-only, empty): K
```

That's the deliverable. No epilogue, no offer to "do anything else" — the user knows what to do with the blocked list.

## Subagent dispatch reference

Always brief the subagent like a colleague walking in cold. Include: failed step description verbatim, expected_result verbatim, tester notes verbatim (this often holds the root cause), where to look (paths under `<source_root>/` — the project resolved in Step 0), and the response length limit. The subagent has zero memory of this conversation.

Launch independent investigations as multiple `Agent` tool calls in **one message** so they run concurrently. Wait for both before dispatching the architect step.

## Verification channel quick-reference

| Step type | Verify via | Why |
|-----------|------------|-----|
| UI text, tabs, cards, AI analysis output | Vite preview + `preview_eval` reading `document.body.innerText` | Same React code, fast HMR, no device flakiness |
| RLS / realtime / cross-account visibility | SQL impersonation via `SET LOCAL request.jwt.claims` | Exact replica of Supabase Realtime per-subscriber RLS check |
| Edge function / API response | Direct call via `execute_sql` or fetch from preview | Deterministic, isolated |
| Push notification, biometrics, share sheet, native Apple Sign-In sheet, Face ID | **NOT supported** — mark `blocked` | Requires native shell; this skill does not drive real devices |
| "2 device-uri" / "al doilea cont" steps with a single device | SQL impersonation (read **and** write) | The only single-device replica that actually exercises the cross-user policy path |

## Mistakes to avoid

| Mistake | Why it hurts | Fix |
|---------|--------------|-----|
| Treating tt_test_plans as markdown | Skill used to be written for file-based plans; the source of truth is the DB. | Always go through SQL. |
| Status mismatch: `passed`/`failed` vs `pass`/`fail` | The DB uses singular forms. Plural strings will never match. | Hardcode the singular forms in your queries. |
| Trusting a code-explorer "no RLS" claim without verifying `pg_policy` and `relrowsecurity` | Migration grep misses policies created in unrelated migrations. | After any RLS-related fix, query `pg_policy` directly to confirm the live state. |
| Designing an INSERT policy that JOINs a table with its own RLS | The JOIN is evaluated in the subscriber's context and gets blocked. | Wrap the visibility check in a SECURITY DEFINER helper; have the policy call the helper. |
| Trying to verify a native-only behavior in preview | The native shell (push, biometrics, OAuth sheets) is not in the browser DOM; you'll get a misleading false fail. | Detect native-only keywords (push, FCM, biometric, Face ID, Apple Sign-In native, share sheet) early and mark the step `blocked` with the right reason instead. |
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
- The classification query returns zero `process` rows AND zero `all-green-should-archive` rows. (Empty work queue. Say so and stop.)
- The first plan's investigation subagent crashes with a tool-permission error you cannot work around.

In each case, output a single sentence describing what blocked you and what the user needs to do.
