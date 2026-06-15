---
name: resolving-tt-bugs
description: Use when the user asks to fix, resolve, process, or sweep open bugs from team-tracker — or invokes "/resolving-tt-bugs". Bugs live in Supabase table `tt_bugs`, scoped per-project via `project_id`. Resolves the current project from the cwd, discovers every `Open` and `In Progress` bug for that project, dispatches subagents to investigate each one, designs a fix, implements it under the project's source root, verifies via Vite preview (or SQL impersonation for RLS / database bugs), then sets `status='Fixed'` on success. Native-only bugs (push, biometrics, Apple Sign-In native sheet, Capacitor plugins) are left `Open` with a clear note for human follow-up. Triggers on "rezolvă bug-urile", "fix bugs", "process bugs", "sweep tt_bugs", "rezolvă toate bug-urile", "fix all open bugs", "rezolvă probleme din proiect", "fa cate un fix pentru fiecare bug", "fix open tt_bugs", "sweep bugs from team-tracker".
---

# Resolving tt_bugs

End-to-end sweep over team-tracker bugs (stored in the BetRO Supabase database, table `tt_bugs`, not markdown). Find the ones with `status='Open'` or `'In Progress'` for the current project, fix them on that project's codebase with specialized subagents, verify via the most reliable channel for the bug type, and flip the row to `Fixed` when proof is in hand. Bugs that can't be verified by this skill (native shell, credentials, product decisions) stay `Open` with a note so the user can finish them.

## Why this skill exists

The user runs a separate React app called **team-tracker** (sibling of the project repos on the Desktop) that owns the bug tracker UI. Bugs and their metadata live in the team-tracker Supabase (project ref `ntjzghsbrzkvpkniotaj`) in table `tt_bugs` — `tt_` prefix marks them as team-tracker's. Each bug has `status ∈ {Open, In Progress, Fixed, Closed}` and is tagged with `project_id` so the UI can scope per app.

**Multi-project scope:** team-tracker tracks bugs for multiple apps (Betora/BetRO, Team Tracker, Telegram Tips, Culcush, Padel Team, the Betora landing page, and more get added over time), each tagged via `tt_bugs.project_id` → `tt_projects.id`. The live `tt_projects` table is the only source of truth for project ids — they are non-contiguous; never assume an id without the Step 0 query. **This skill resolves the current project from the working directory in Step 0** and only processes bugs for that project. Never touch rows where `project_id != <resolved>` — their code lives in a different repository this invocation cannot reach.

Manually walking through bug rows in the main thread blows the context window, loses parallelism, and produces inconsistent verification quality. This skill industrializes the loop:

1. Query the DB once, list all open bugs for the current project.
2. Delegate investigation, fix design, and root-cause tracing to subagents — main thread keeps a clean orchestration view.
3. Verify via the channel that matches the bug: **Vite preview for UI-visible work, SQL impersonation for RLS / database work**. Native-only behavior is not in scope — leave such bugs `Open` with a clear reason.
4. Update `status='Fixed'` only when verification produced concrete evidence.

## Constants

| Item | Value |
|------|-------|
| Current project source root (where fixes land) | **resolved in Step 0** — the current working directory |
| team-tracker app (UI that owns the bugs) | `C:/Users/lakie/Desktop/team-tracker` (do NOT modify unless directly relevant to the bug) |
| Supabase project id (holds tt_* tables) | `ntjzghsbrzkvpkniotaj` |
| `project_id` filter | **resolved in Step 0** from cwd — **always** include `WHERE project_id = <project_id>` in queries against `tt_bugs` |
| `tt_projects` rows (snapshot 2026-06-10; live table is the source of truth) | `1=Betora(BetRO)/betro`, `2=Team Tracker/team_tracker`, `4=Telegram Tips/telegram_tips`, `7=Culcush/culcush`, `10=pagina prezentare betora`, `11=website`, `12=Padel Team/padel_team`, `15=gradinita amos` — ids are non-contiguous; never guess, always run the Step 0 query |
| Migrations dir | `<source_root>/supabase/migrations/` (if the project uses Supabase) |
| Dev preview launch name | per project; look in `<source_root>/.claude/launch.json` (BetRO: `vite-dev` on port 3000; other projects may differ) |
| Native-only verification | not supported — bugs that require native shell (push notifications, Apple Sign-In iOS sheet, biometrics, Capacitor plugins, file picker, share sheet) must stay `Open` with reason for a human tester. |
| Max retry cycles per bug | 3 |
| Valid `status` values in DB | `Open`, `In Progress`, `Fixed`, `Closed` (UI uses first three; `Closed` is legacy / archived bugs) |
| Valid `priority` values | `Critical`, `High`, `Medium`, `Low` |

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

Capture the returned `id` as `<project_id>` and the cwd as `<source_root>`. Use both throughout this skill — `<project_id>` in every `tt_bugs` query, `<source_root>` in every file/Glob/Grep path, every `git -C` invocation, every subagent prompt.

If no row matches, abort: "Nu am putut identifica proiectul din folderul curent ('<dirname>'). Folderul ar trebui sa aiba numele slug-ului din tt_projects. Verifica, sau spune-mi explicit pe ce proiect sa rezolv bug-urile."

If the resolved project lacks the tooling this skill assumes (Vite preview, Supabase migrations, etc.), inspect `<source_root>` and adapt: when the verification channel a bug needs isn't available for the current project, leave the bug `Open` with reason "Skill cannot verify this bug type on project <slug>; needs human tester" rather than guessing.

## Step 1 — Bootstrap

Run these in parallel before anything else:

1. Confirm Supabase MCP is reachable (a tiny `list_tables` or trivial `execute_sql` ping if unsure). If it errors with "server disconnected", abort with: "Supabase MCP not connected — reconnect and rerun."
2. Confirm `<source_root>` (resolved in Step 0) exists (`Glob` on `<source_root>/package.json` or other root marker). If missing, abort with the same one-liner pattern.
3. Confirm preview MCP is reachable: `mcp__Claude_Preview__preview_list`. If the project's dev server isn't running, `mcp__Claude_Preview__preview_start name=<dev_server_name>` (read from `<source_root>/.claude/launch.json`). Capture the `serverId` for the rest of the run.

Then run the classification SQL (Step 2). Create a `TodoWrite` list with one entry per bug as soon as you have the result. The list is your dashboard for the rest of the run — keep it current.

## Step 2 — Classify and prioritize open bugs

Issue this single query to `mcp__supabase-mcp-server__execute_sql` (project_id `ntjzghsbrzkvpkniotaj`):

```sql
SELECT
  id, title, description, priority, status,
  reported_by, tester_name, platform,
  image_urls,
  created_at, updated_at,
  CASE priority
    WHEN 'Critical' THEN 1
    WHEN 'High'     THEN 2
    WHEN 'Medium'   THEN 3
    WHEN 'Low'      THEN 4
    ELSE 5
  END AS priority_rank
FROM tt_bugs
WHERE project_id = <project_id>   -- resolved in Step 0 from cwd
  AND status IN ('Open', 'In Progress')
ORDER BY priority_rank ASC, created_at ASC;
```

If the result is empty, stop and report: "Nu sunt bug-uri Open/In Progress pentru proiectul <slug>. Nimic de rezolvat."

Print a compact table to the user — id, priority, title (truncated to 80 chars), platform — so they see the scope. Two lines: the table, then "Starting work on N bugs in priority order" and proceed. Do not stop for confirmation; the user invoked the skill explicitly.

The `description` field on each row is the canonical brief — it usually already contains evidence, suspected root cause, files involved, and acceptance criteria (this is how the `writing-tester-test-plans`-style automation populates them). **Mine the description carefully before dispatching subagents — half the investigation is often already done for you.**

The `image_urls` JSONB column may contain signed screenshots URLs from `bug-screenshots` Supabase storage; pass any such URLs verbatim into subagent prompts so they can WebFetch them for visual context.

## Step 3 — Process each bug

Iterate sequentially by `priority_rank ASC, created_at ASC` — bugs often touch overlapping code, and a Critical/High fix may invalidate the assumptions of a Medium one. **Do parallelize subagents within a single bug** when their work is independent.

Set the row to `In Progress` before starting (so the team-tracker UI shows live state):

```sql
UPDATE tt_bugs
SET status = 'In Progress', updated_at = NOW()
WHERE id = <bug_id> AND status = 'Open'
RETURNING id, status;
```

### 3a. Investigation — dispatch in parallel

Send these two subagents in the **same message**:

- **`feature-dev:code-explorer`** — "Trace the code path involved in this bug in the `<project_name>` repo at `<source_root>`. Bug title: `<title>`. Bug description (canonical brief): `<verbatim description>`. Reported by: `<reported_by>`. Platform: `<platform>`. Map the relevant files under `<source_root>` (look in `src/`, `supabase/functions/`, `supabase/migrations/`, or whatever subdirs the project uses). Report under 350 words: which files are implicated, what runs when the bug triggers, what likely broke, and the smallest reproducer (URL + sequence of actions, or SQL + role + payload). **For RLS / database bugs, do NOT trust migration grep alone — verify `pg_policy` and `pg_class.relrowsecurity` live via SQL before claiming a table has no RLS.**"
- **`Explore`** — "Find any recent changes around `<feature area inferred from title/description>` in the `<project_name>` repo at `<source_root>`. Search git log for the last 30 days and grep for symbols / file paths mentioned in the bug description. Under 150 words: changed files, suspect commits with hash + date + short subject."

The `Explore` agent finds the surface area; the `code-explorer` agent traces semantics. Both share the bug context. The italicized clause exists because a previous run took a code-explorer's "table has no RLS" claim at face value and shipped a half-fix; the table did have RLS, defined in an unrelated migration.

If `image_urls` is non-empty, include the URLs in the prompt and ask the explorer to WebFetch each one for visual context before reporting.

### 3b. Design the fix — dispatch one subagent (or do it inline if obvious)

Once 3a returns, if the fix path is non-trivial, dispatch **`feature-dev:code-architect`**:

> "Based on this investigation: `<paste explorer + code-explorer outputs>`. Design the smallest fix that resolves this bug. Files involved: `<list>`. Original bug brief: `<paste tt_bugs.description>`. Report under 350 words with: 1) Root cause in one sentence, 2) Files to change with line ranges, 3) Exact code/text changes (not pseudo — final SQL bodies, final edited TS lines), 4) Whether this risks regressing related behavior, 5) Verification strategy (preview, SQL impersonation, or device — pick exactly one and motivate it from the bug content)."

If the architect reports that the root cause is **unknown**, **requires credentials**, **requires a product decision**, **requires infrastructure access**, or **the verification channel is native-only**: leave the bug `Open` (Step 3e: blocked path) with a one-line reason. **Do not attempt the fix.**

When the path is obvious (e.g. a string replacement in a translation file, a single regex extension, a missing null-guard), skip the architect dispatch and proceed straight to 3c. Save the architect for designs that span migrations + multiple files, or for changes whose blast radius is unclear.

### 3c. Apply the fix — main thread

Apply the fix yourself with `Edit` / `Write` / `mcp__supabase-mcp-server__apply_migration`. Do not delegate edits unless the change spans more than 5 files.

After editing, run any obviously relevant local checks:
- Migration applied → re-query `pg_policy` / helper function definitions to confirm the new state in DB.
- Frontend TypeScript touched → `npx tsc --noEmit 2>&1 | grep -E "<touched-file-substring>"` (only the affected file) — if the project has many pre-existing TS errors, grep narrows the noise.
- Lint guards relevant to the area touched (`npm run lint:no-emoji`, `npm run lint:no-indigo`, `npm run lint:btn-drift`, etc., per the project's CLAUDE.md).

If a check goes red, loop once back to 3b with the new error before falling through to "blocked."

### 3d. Verify — pick the right channel for this bug

Pick the verification channel based on the bug content. **Only two channels are supported by this skill:**

1. **Vite preview (`mcp__Claude_Preview__*`)** — first choice for any bug describing UI behavior (buttons, cards, AI analysis output, navigation, theming, copy/translations). The web build the preview serves is the same React/Vue/Svelte code that ships to users. Use `preview_start` with the launch name from `<source_root>/.claude/launch.json`, then drive with `preview_click` (CSS / text-based selectors), `preview_fill` (form inputs), `preview_snapshot` (read the accessibility tree to verify visible text), `preview_inspect` (CSS property assertions), `preview_screenshot` (proof), `preview_console_logs level: error` (catch runtime regressions). Never use `preview_eval` to perform clicks — it bypasses event handlers and gives false positives; reserve `preview_eval` for navigation, scrolling, and pure inspection.

2. **SQL impersonation** — first choice for any bug that depends on RLS, realtime broadcast, per-user database visibility, edge function behavior, or backend query result. Inside a single transaction, `SET LOCAL ROLE authenticated` and `SET LOCAL "request.jwt.claims" = '{"sub":"<user-uuid>","role":"authenticated"}'`, then run the SELECT/INSERT/UPDATE that the policy gates, then `ROLLBACK`. This is exactly what Supabase Realtime does per subscriber when it decides whether to broadcast a row change — it is the most faithful simulation of cross-account behavior achievable without a real second device. Use it for bugs that explicitly mention "RLS", "permissions", "alt cont", "other user", "policy".

**Native-only bugs are NOT verifiable by this skill.** If the bug describes behavior that lives in the native shell (push notifications, Apple Sign-In iOS sheet, Face ID, biometrics, Capacitor plugins, share sheet, file picker, OS-level deep links), keep `status='Open'` and add a note via the blocked path in 3e. The user follow-up is a manual run on a phone.

For each verification, capture concrete evidence: a console log snippet, a `body.innerText` slice, an `INSERT ... RETURNING` row, a screenshot file path. The evidence is what you paste into the bug's `description` (appended) at 3e.

If verification fails after up to 3 retry cycles, take the blocked path. Do not enter an infinite retry loop.

### 3e. Mark the bug Fixed (or leave it Open with reason)

On verification success, UPDATE the bug:

```sql
UPDATE tt_bugs
SET
  status = 'Fixed',
  description = description || E'\n\n--- Resolved <YYYY-MM-DD> (Claude Code automation) ---\n<one-paragraph fix summary including: root cause in one sentence, files/migrations touched with relative paths, verification channel used, a verbatim slice of the evidence>',
  updated_at = NOW()
WHERE id = <bug_id>
RETURNING id, status, updated_at;
```

On verification failure / blocked path (rolls back the In Progress flip if you want a clean trail, OR just appends a note and leaves it Open):

```sql
UPDATE tt_bugs
SET
  status = 'Open',
  description = description || E'\n\n--- Blocked <YYYY-MM-DD> (Claude Code automation) ---\n<one-sentence reason: needs credentials / product decision / infrastructure / native shell / cannot reproduce>\nWhat I tried: <one-paragraph summary of investigation>',
  updated_at = NOW()
WHERE id = <bug_id>
RETURNING id, status;
```

Do not touch other bugs in the same UPDATE. Do not modify `priority`, `reported_by`, `tester_name`, `platform`, `image_urls`, `project_id`, or `created_at` — those are owned by the tester/UI.

## Step 4 — Final report

After every bug is processed, print a single compact summary in the main thread:

```
tt_bugs sweep — <YYYY-MM-DD> — project <slug> (id <project_id>)

Fixed (N):
  - #<id> [<priority>] <title>  →  <one-line what changed>
  - ...

Left Open / Blocked (M):
  - #<id> [<priority>] <title>  →  <one-line reason>
  - ...

Skipped (status already Fixed/Closed): K
```

That's the deliverable. No epilogue, no offer to "do anything else" — the user will look at team-tracker UI to see live state and decide on the blocked list.

## Subagent dispatch reference

Always brief the subagent like a colleague walking in cold. Include: bug title verbatim, full description verbatim (the canonical brief — usually with evidence and acceptance criteria), where to look (paths under `<source_root>/` — the project resolved in Step 0), and the response length limit. The subagent has zero memory of this conversation.

Launch independent investigations as multiple `Agent` tool calls in **one message** so they run concurrently. Wait for both before dispatching the architect step.

## Verification channel quick-reference

| Bug type | Verify via | Why |
|----------|------------|-----|
| UI text, layout, theming, AI output, navigation, copy | Vite preview + `preview_snapshot`/`preview_inspect` | Same code as ships, fast HMR, no device flakiness |
| RLS / realtime / cross-account visibility | SQL impersonation via `SET LOCAL request.jwt.claims` | Exact replica of Supabase Realtime per-subscriber RLS check |
| Edge function / API response | Direct call via `execute_sql` (for SQL-backed) or fetch from preview console | Deterministic, isolated |
| Migration correctness / DDL change | `apply_migration` then re-query `information_schema`, `pg_policy`, etc. | Live state is authoritative |
| Push notification, biometrics, share sheet, native Apple Sign-In sheet, Face ID, file picker | **NOT supported** — leave `Open` with reason | Requires native shell; this skill does not drive real devices |

## Mistakes to avoid

| Mistake | Why it hurts | Fix |
|---------|--------------|-----|
| Treating tt_bugs as markdown | Skill operates on DB rows. There are no files to edit. | Always go through SQL. |
| Status mismatch: `Fixed` vs `fixed` / `Open` vs `open` | The DB uses titlecase. Lowercase will never match in UI filters. | Hardcode the exact strings `Open`, `In Progress`, `Fixed`. |
| Forgetting `project_id = <project_id>` in queries | You'd start fixing bugs that belong to a different repository you can't access. | Always include the filter (Step 0 resolves it). |
| Trusting a code-explorer "no RLS" claim without verifying `pg_policy` and `relrowsecurity` | Migration grep misses policies created in unrelated migrations. | After any RLS-related fix, query `pg_policy` directly to confirm the live state. |
| Trying to verify a native-only bug in preview | The native shell (push, biometrics, OAuth sheets) is not in the browser DOM; you'll get a misleading false fail. | Detect native-only keywords (push, FCM, biometric, Face ID, Apple Sign-In native, share sheet, Capacitor plugin) early and take the blocked path with the right reason. |
| Using `preview_eval` to perform clicks | Bypasses React event handlers; gives false positives. | Use `preview_click` with a stable selector; reserve `preview_eval` for navigation and read-only inspection. |
| Marking a bug `Fixed` based on a typecheck only | TS compile success doesn't prove the user-visible behavior is fixed. | Always run preview/SQL verification; evidence in hand before `status='Fixed'`. |
| Looping forever on a stubborn bug | Wastes time, won't converge. | 3 retry cycles max, then blocked path. |
| Parallelizing across bugs | Bugs often touch overlapping code; the preview is single-tenant. | Sequential across bugs, parallel within a bug (3a). |
| Re-running searches the subagent already did | Burns the context window for no signal. | Trust the subagent's report; only re-verify a specific assertion when you have concrete reason to doubt. |
| Editing the team-tracker app's source code while fixing bugs for another project | The bugs are owned by team-tracker UI; the project resolved in Step 0 is where fixes belong. | Fix code under `<source_root>`; never modify `C:/Users/lakie/Desktop/team-tracker/src` unless the user explicitly asked, or the bug's `project_id = 2`. |
| Running the skill on bugs for a different project than the cwd | Subagents investigate the wrong codebase, fixes land in the wrong repo. | Step 0 resolves `<project_id>` from cwd and Step 2's SQL filter keeps work scoped. If the user wants a different project, ask them to `cd` into that project first. |
| Modifying `priority`, `image_urls`, `reported_by`, or `created_at` | Those are tester/UI-owned. | Only ever touch `status`, `description` (append-only), and `updated_at`. |

## When the skill should self-abort

Stop immediately and report to the user when any of these happen:
- The Supabase MCP server is disconnected (or `execute_sql` errors out repeatedly).
- The resolved `<source_root>` is missing or unreadable.
- Step 0 cannot resolve the cwd to a `tt_projects` row.
- The classification query returns zero `Open`/`In Progress` rows for this project. (Empty work queue. Say so and stop — there is nothing to fix.)
- The first bug's investigation subagent crashes with a tool-permission error you cannot work around.

In each case, output a single sentence describing what blocked you and what the user needs to do.
