---
name: resolving-tt-features
description: Use when the user asks to evaluate, triage, or implement proposed features/functionalities from team-tracker — or invokes "/resolving-tt-features". Features live in Supabase table tt_features, scoped per-project via project_id. Resolves the project from the cwd, discovers Propus/Planificat features, dispatches evaluator subagents per feature, presents recommendations (Implementează / Amână / Respinge), implements the approved ones, verifies via Vite preview or SQL, and sets status='Gata' on success. Native-only features (push, biometrics, Capacitor plugins) are deferred with a note. Triggers on "implementează funcționalitățile propuse", "triază propunerile", "evaluează propunerile", "vezi ce funcționalități merită", "triază features", "ce features merită implementate", "implementează feature-urile planificate", "rezolvă funcționalitățile propuse", "fa funcționalitățile din team-tracker", "sweep tt_features", "implement proposed features", "triage the feature backlog".
---

# Resolving tt_features

End-to-end sweep over team-tracker feature proposals (stored in the BetRO Supabase database, table `tt_features`, not markdown). Find the ones with `status='Propus'` (plus previously approved `'Planificat'`) for the current project, **evaluate each one and tell the user which are worth implementing and why**, then implement the approved ones on that project's codebase with specialized subagents, verify via the most reliable channel, and flip the row to `Gata` when proof is in hand. Features that don't deserve implementation yet stay `Propus` with the evaluation rationale appended so the user sees it in the team-tracker UI.

This is the feature-side sibling of `resolving-tt-bugs`: same project resolution, same verification channels, same DB discipline — but with an extra **triage step**, because a proposed feature (unlike a reported bug) is not automatically worth doing.

## Why this skill exists

The user runs a separate React app called **team-tracker** (sibling of the project repos on the Desktop) that owns the feature backlog UI. Feature proposals and their metadata live in the team-tracker Supabase (project ref `ntjzghsbrzkvpkniotaj`) in table `tt_features` — `tt_` prefix marks them as team-tracker's. Proposals come from teammates and from automated idea-scan routines, so quality varies: some are high-value quick wins, some duplicate existing functionality, some are too vague or too big to act on. Implementing everything blindly wastes days; the triage step exists so judgment happens before code.

**Multi-project scope:** team-tracker tracks features for multiple apps (Betora/BetRO, Team Tracker, Telegram Tips, Culcush, Padel Team, the Betora landing page, and more get added over time), each tagged via `tt_features.project_id` → `tt_projects.id`. The live `tt_projects` table is the only source of truth for project ids — they are non-contiguous and rows change; never assume an id without the Step 0 query. **This skill resolves the current project from the working directory in Step 0** and only processes features for that project. Never touch rows where `project_id != <resolved>` — their code lives in a different repository this invocation cannot reach.

## Constants

| Item | Value |
|------|-------|
| Current project source root (where implementations land) | **resolved in Step 0** — the current working directory |
| team-tracker app (UI that owns the features) | `C:/Users/lakie/Desktop/team-tracker` (do NOT modify unless the feature's `project_id = 2`) |
| Supabase project id (holds tt_* tables) | `ntjzghsbrzkvpkniotaj` |
| `project_id` filter | **resolved in Step 0** from cwd — **always** include `WHERE project_id = <project_id>` in queries against `tt_features` |
| `tt_projects` rows (snapshot 2026-06-10; live table is the source of truth) | `1=Betora(BetRO)/betro`, `2=Team Tracker/team_tracker`, `4=Telegram Tips/telegram_tips`, `7=Culcush/culcush`, `10=pagina prezentare betora`, `11=website`, `12=Padel Team/padel_team`, `15=gradinita amos` — ids are non-contiguous; never guess, always run the Step 0 query |
| Valid `status` values | `Propus`, `Planificat`, `În Focus`, `Gata` (exact strings, with diacritics) |
| Valid `type` values | `Funcție`, `Îmbunătățire`, `Idee`, `Design`, `Conținut`, `Altele` |
| Valid `priority` values | `Critical`, `High`, `Medium`, `Low` |
| Status semantics in this skill | `Propus` = awaiting triage · `Planificat` = approved, queued · `În Focus` = being implemented right now · `Gata` = implemented + verified |
| DB trigger to know about | `trg_sync_focus_on_feature_done`: setting `status='Gata'` auto-moves any linked `tt_focus_tasks` card to `deployed`. Do not duplicate that sync manually. |
| Migrations dir | `<source_root>/supabase/migrations/` (if the project uses Supabase) |
| Dev preview launch name | per project; look in `<source_root>/.claude/launch.json` (BetRO: `vite-dev` on port 3000; other projects may differ) |
| Native-only verification | not supported — features whose core behavior needs the native shell (push, biometrics, Apple Sign-In native sheet, Capacitor plugins, share sheet) get recommendation `Amână` with reason. |
| Max retry cycles per feature | 3 |
| Max implementation size per feature | ~15 files. Bigger than that → `Amână` with "needs human breakdown into smaller features". |

Do not ask the user to confirm any of these. If the Supabase MCP server is not connected or the resolved source root is missing, stop and tell the user with a one-line error.

## Step 0 — Resolve current project

The user works across multiple apps stored under `C:/Users/lakie/Desktop/`. Detect which one this invocation is for from the cwd, BEFORE any DB query, because the rest of the skill filters and operates by `<project_id>`. Skipping this step means evaluating and implementing features that belong to a different repository — the single worst failure mode of this skill.

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

Capture the returned `id` as `<project_id>` and the cwd as `<source_root>`. Use both throughout this skill — `<project_id>` in every `tt_features` query, `<source_root>` in every file/Glob/Grep path, every `git -C` invocation, every subagent prompt.

If no row matches, abort: "Nu am putut identifica proiectul din folderul curent ('<dirname>'). Folderul ar trebui sa aiba numele slug-ului din tt_projects. Verifica, sau spune-mi explicit pe ce proiect sa lucrez."

If the resolved project lacks the tooling this skill assumes (Vite preview, `.claude/launch.json`, Supabase migrations), inspect `<source_root>` and adapt: when the verification channel a feature needs isn't available for the current project, the triage verdict becomes `Amână` with reason "Skill cannot verify this feature type on project <slug>" (or the blocked path in 4d if discovered later) rather than guessing.

## Step 1 — Bootstrap

Run these in parallel before anything else:

1. Confirm Supabase MCP is reachable (a tiny `execute_sql` ping if unsure). If it errors with "server disconnected", abort with: "Supabase MCP not connected — reconnect and rerun."
2. Confirm `<source_root>` (resolved in Step 0) exists (`Glob` on `<source_root>/package.json` or other root marker). If missing, abort with the same one-liner pattern.
3. Read `<source_root>/CLAUDE.md` if present — implementations must follow the project's conventions (for BetRO: translations in both ro.ts and en.ts, SVG icons, canonical button styles, no code comments, lint guards; for UI work on Betora products invoke the `betora-design-language` skill before writing styles).
4. Confirm the preview MCP is reachable with a cheap `mcp__Claude_Preview__preview_list` call. Don't start the dev server yet — that can wait until Step 4 — but a dead preview MCP is better discovered now than after code has been written and verification dead-ends.

Then run the discovery SQL (Step 2). Create a `TodoWrite` list with one entry per feature as soon as you have the result. The list is your dashboard for the rest of the run — keep it current.

## Step 2 — Load proposed features

Issue this single query to `mcp__supabase-mcp-server__execute_sql` (project_id `ntjzghsbrzkvpkniotaj`):

```sql
SELECT
  id, title, description, type, priority, status,
  requested_by, image_urls, focus_task_id,
  created_at, updated_at,
  CASE priority
    WHEN 'Critical' THEN 1
    WHEN 'High'     THEN 2
    WHEN 'Medium'   THEN 3
    WHEN 'Low'      THEN 4
    ELSE 5
  END AS priority_rank
FROM tt_features
WHERE project_id = <project_id>   -- resolved in Step 0 from cwd
  AND is_archived = false
  AND status IN ('Propus', 'Planificat', 'În Focus')
ORDER BY priority_rank ASC, created_at ASC;
```

If the result is empty, stop and report: "Nu sunt funcționalități Propuse/Planificate pentru proiectul <slug>. Nimic de triat."

Split the rows into three buckets:
- **`Propus`** → goes through triage (Step 3).
- **`Planificat`** → already approved in a previous run or by the user in the UI; skips triage and goes straight to the implementation queue (Step 4).
- **`În Focus`** → human-owned by default (Focus board, possibly being worked right now) — **skip them**, with one exception: if the description's LAST appended block is an `--- Evaluat/Blocat <date> (Claude Code automation) ---` marker, the row was flipped by a previous skill run that crashed mid-implementation and never finished. Reclaim those orphans into the implementation queue; otherwise this skill's own status flips would strand features invisible to every future run.

The `description` field is the canonical brief — automated scan routines usually fill it with motivation, suspected implementation area, and acceptance criteria. **Mine it before dispatching evaluators — half the analysis is often already done.** The `image_urls` JSONB column may contain signed screenshot URLs; pass them verbatim into subagent prompts for WebFetch.

## Step 3 — Triage: evaluate every Propus feature

This is the step that distinguishes this skill from `resolving-tt-bugs`. A proposal is a hypothesis, not a work order.

### 3a. Dispatch evaluators in parallel

Evaluations are read-only and independent — launch **one `Explore` subagent per feature, all in a single message**, so they run concurrently. Each prompt must be self-contained:

> "Read-only evaluation of a proposed feature for the `<project_name>` repo at `<source_root>`. Do NOT write code. Feature title: `<title>`. Type: `<type>`. Priority: `<priority>`. Requested by: `<requested_by>`. Full description (canonical brief): `<verbatim description>`. <If image_urls non-empty: WebFetch these screenshots first: <urls>.>
> Investigate and report under 250 words:
> 1) **Already exists?** Search the codebase for existing implementations or close equivalents of this feature. Name files if found.
> 2) **Implementation surface** — which files/modules would change, rough count (S = 1–3 files, M = 4–8, L = 9–15, XL = >15).
> 3) **Feasibility** — can it be built and verified in a web preview / SQL? Or does its core behavior need the native shell (push, biometrics, Capacitor plugins) or external credentials/infrastructure? **If the feature touches database tables or RLS, do NOT trust migration grep alone — verify `pg_policy` and `pg_class.relrowsecurity` live via SQL before claiming a table's policy state.**
> 4) **Risk** — what existing behavior could it regress?
> 5) **Verdict suggestion** — one of: Implementează / Amână / Respinge, with one sentence of rationale."

### 3b. Compose recommendations — main thread

When all evaluators return, form your own verdict per feature (the evaluator suggests; you decide). Apply these rules:

- **Respinge** — already implemented (duplicate), or contradicts an existing product decision, or the description is too vague to define acceptance criteria.
- **Amână** — valuable but XL-sized (needs human breakdown), or needs a product/pricing decision, credentials, infrastructure, or native-only verification.
- **Implementează** — clear value, S/M/L surface, verifiable via preview or SQL, low regression risk. When in doubt between Implementează and Amână on an L-sized feature, weigh `priority`: Critical/High earns the benefit of the doubt, Low does not.

Print the recommendation table to the user — this is the deliverable the user explicitly asked this skill for, so make it readable:

```
Triaj tt_features — proiect <slug> (id <project_id>)

#<id> [<priority>/<type>] <title>
  → Recomandare: <Implementează|Amână|Respinge> — <one-line rationale> (efort: <S|M|L|XL>)
...
```

### 3c. Decision gate

Ask the user **once** via `AskUserQuestion`: "Ce implementez din triajul de mai sus?" with options: "Implementează recomandările (Recommended)" / "Implementează tot" / "Aleg eu" (then a multiSelect follow-up listing the features) / "Doar triajul — nu implementa nimic".

Skip the gate and proceed directly with the **Implementează** set only when the user pre-authorized it in their invocation ("fără să mă întrebi", "implementează direct ce merită") or the run is non-interactive (cron / loop / autonomous).

### 3d. Persist triage results

For every triaged feature, append the evaluation to `description` (append-only, never rewrite) and set the new status in one UPDATE per row:

- Approved for implementation → `status='Planificat'`:

```sql
UPDATE tt_features
SET
  status = 'Planificat',
  description = COALESCE(description, '') || E'\n\n--- Evaluat <YYYY-MM-DD> (Claude Code automation) ---\nRecomandare: Implementează — <rationale>. Efort estimat: <S|M|L>.',
  updated_at = NOW()
WHERE id = <feature_id> AND project_id = <project_id>
RETURNING id, status;
```

- `Amână` / `Respinge` → keep `status='Propus'`, append the same style of note with the recommendation and rationale so the user sees the reasoning in the team-tracker UI and can overrule it later.

If the description already contains an `--- Evaluat` block with the **same recommendation**, skip the append — repeated runs must not balloon descriptions.

## Step 4 — Implement approved features

Iterate the queue (approved `Implementează` set + pre-existing `Planificat` rows) **sequentially** by `priority_rank ASC, created_at ASC` — features touch overlapping code, and each implementation changes the ground truth for the next. **Do parallelize subagents within a single feature** when their work is independent.

Mark the row as live work before starting:

```sql
UPDATE tt_features
SET status = 'În Focus', updated_at = NOW()
WHERE id = <feature_id> AND project_id = <project_id> AND status = 'Planificat'
RETURNING id, status;
```

If `RETURNING` comes back empty, the row changed under you (a human moved it in the team-tracker UI between the decision gate and this feature's turn in the queue) — re-read the row and skip it instead of forcing the flip.

### 4a. Design — dispatch `feature-dev:code-architect`

Features are bigger than bug fixes; skipping design is how implementations sprawl. Dispatch the architect with: the feature title and verbatim description, the evaluator's report from Step 3a, `<source_root>`, and the project's conventions summary from its CLAUDE.md. For rows that skipped triage this run (pre-existing `Planificat`, reclaimed `În Focus`), substitute the `--- Evaluat ---` block from the row's description; if none exists, dispatch a fresh `Explore` evaluator (3a prompt) before the architect. Ask the architect for: 1) component/data-flow design that follows existing codebase patterns, 2) exact files to create/modify, 3) build sequence, 4) verification strategy (preview or SQL — pick one and motivate it), 5) under 400 words. If the feature touches tables or RLS, include the "do NOT trust migration grep alone — verify `pg_policy` and `pg_class.relrowsecurity` live via SQL" clause in the prompt.

Skip the architect only for genuinely trivial features (a copy change, one new field on an existing card) and go straight to 4b.

If the architect reports the feature needs a product decision, credentials, or infrastructure this skill can't reach: do NOT take the retryable blocked path — demote the row to `Propus` with an `--- Evaluat <date> (Claude Code automation) ---\nRecomandare: Amână — <reason>` note, matching the 3b semantics. Left `Planificat`, it would re-enter the implementation queue unattended on every future run and loop architect → blocked forever without ever re-engaging the user.

### 4b. Implement — main thread

Apply the changes yourself with `Edit` / `Write` / `mcp__supabase-mcp-server__apply_migration`. Delegate edits to a subagent only when the change spans more than 5 files — and then read the actual diff before trusting it.

Follow the project's CLAUDE.md to the letter. For BetRO that means: translations added to BOTH `ro.ts` and `en.ts`, SVG icons only, canonical `btnBase`/`btnActive` styles, no code comments, max 600 lines per file, light-theme overrides for hardcoded hex.

After editing, run the project's local checks: `npx tsc --noEmit` (scoped grep to touched files if the project has pre-existing noise), plus the lint guards the project defines (`npm run lint:all` for BetRO). Migration applied → re-query `pg_policy` / `information_schema` / helper function definitions to confirm the live DB state before verification — migration files on disk are not proof of what the database actually holds. A red check loops once back to 4a with the error before falling through to blocked.

### 4c. Verify — pick the right channel

Same two channels as `resolving-tt-bugs`, same discipline:

1. **Vite preview (`mcp__Claude_Preview__*`)** — first choice for anything user-visible. `preview_start` with the launch name from `<source_root>/.claude/launch.json`, then drive with `preview_click` / `preview_fill`, read state via `preview_snapshot` / `preview_inspect`, capture proof via `preview_screenshot`, and check `preview_console_logs level: error` for regressions. Never use `preview_eval` to perform clicks — it bypasses React event handlers and gives false positives.
2. **SQL impersonation** — first choice for RLS / per-user visibility / backend behavior: inside one transaction, `SET LOCAL ROLE authenticated` + `SET LOCAL "request.jwt.claims" = '{"sub":"<uuid>","role":"authenticated"}'`, run the gated statement, `ROLLBACK`.

Verify the feature's **acceptance criteria from the description**, not just that the code compiles. Capture concrete evidence: a snapshot slice showing the new UI, a screenshot path, a `RETURNING` row. If verification fails after 3 retry cycles, take the blocked path.

### 4d. Mark the feature Gata (or back to Planificat with reason)

On verified success:

```sql
UPDATE tt_features
SET
  status = 'Gata',
  description = COALESCE(description, '') || E'\n\n--- Implementat <YYYY-MM-DD> (Claude Code automation) ---\n<one-paragraph summary: what was built, files touched with relative paths, verification channel used, a verbatim slice of the evidence>',
  updated_at = NOW()
WHERE id = <feature_id> AND project_id = <project_id>
RETURNING id, status, updated_at;
```

(The DB trigger moves any linked Focus card to `deployed` automatically.)

On **retryable** failure (verification failed after 3 cycles, flaky tooling): revert to the queued state so a future run retries with fresh eyes:

```sql
UPDATE tt_features
SET
  status = 'Planificat',
  description = COALESCE(description, '') || E'\n\n--- Blocat <YYYY-MM-DD> (Claude Code automation) ---\n<one-sentence reason>\nCe am încercat: <one-paragraph summary>',
  updated_at = NOW()
WHERE id = <feature_id> AND project_id = <project_id>
RETURNING id, status;
```

On a **non-retryable** blocker (needs product decision, credentials, infrastructure, native-only verification): demote to `Propus` with an `Amână` note instead, per 4a — those need a human, not a retry.

Only ever touch `status`, `description` (append-only), and `updated_at`. Never modify `priority`, `type`, `requested_by`, `image_urls`, `focus_task_id`, `project_id`, `created_at`, or `is_archived` — those are owned by the team-tracker UI and its users. Never INSERT into `tt_focus_tasks` from this skill.

## Step 5 — Final report

After every feature is processed, print a single compact summary:

```
tt_features sweep — <YYYY-MM-DD> — proiect <slug> (id <project_id>)

Implementate (N):
  - #<id> [<priority>] <title>  →  <one-line what was built>
  - ...

Amânate / Respinse la triaj (M):
  - #<id> [<priority>] <title>  →  <Amână|Respinge>: <one-line reason>
  - ...

Blocate la implementare (K):
  - #<id> [<priority>] <title>  →  <one-line reason>
  - ...
```

Follow the summary with the testing recommendation (Step 6) — the last thing you print. Nothing else after it; the user sees live state in the team-tracker UI.

## Step 6 — Recommend follow-up testing (final output)

After the sweep summary, print ONE short recommendation: which test plan(s), if any, are worth writing for the features you just **implemented** (rows now `Gata`). Deferred/rejected proposals shipped no code, so they need no test. Reserve a **real human tester for the cases nothing else can exercise** — `/writing-tester-test-plans` (test_type `human`) is the expensive last resort; the default is `/writing-ai-test-plans` (test_type `ai`), which `/auto-running-test-plans` re-runs unattended.

The signal is the verification channel each implemented feature used in 4c:

| How the implemented feature was verified | Recommend | Why |
|---|---|---|
| Verified via **Vite preview** (any user-visible flow) or **SQL impersonation** (RLS, backend, cross-account) | **`/writing-ai-test-plans`** | The AI runner drives the same channel that proved the acceptance criteria — durable regression coverage at zero human cost. |
| Has a facet in the **native shell** (push, biometrics, Apple Sign-In native sheet, Capacitor plugin, camera, share sheet), or needs a **real second device**, real money/credentials, or a **subjective visual / animation / UX-feel** judgment | **`/writing-tester-test-plans`** for that facet | Outside the browser DOM and SQL — only a person on a real device confirms it. The "ultra nevoie" case. |
| A feature with both a normal web flow AND a native/subjective facet | **Ambele** — an AI plan for the web/DB part, a human plan only for the native/subjective part | Don't make a human re-test what the AI can run; don't pretend the AI reaches the native shell. |
| Nothing was implemented this sweep (all Amânat/Respins), or the change is copy-only / already covered by an existing plan | **Niciun test nou** — say so | Nothing shipped, or a duplicate plan would just add QA noise. |

**Default & tie-breaker:** the AI plan is the floor for any implemented feature with user-visible behavior reproducible in the browser or DB — even if you happened to verify it another way (tsc, a unit test, a one-off script). Escalate to a human tester only for a facet that genuinely can't be reached without a real device, real credentials, or a subjective judgment; recommend "niciun test nou" only when nothing shipped, or an existing plan already covers it.

Then print exactly this block, in Romanian, as the final output of the run:

```
Recomandare testare:
  → <AI | Uman | Ambele | Niciun test nou>
  Motiv: <o propoziție, legată de canalul de verificare de mai sus>
  De rulat: < /writing-ai-test-plans · /writing-tester-test-plans · ambele · — >
  Acoperă: <feature #id-uri / zonele pe care planul trebuie să le acopere>
```

No epilogue after this block.

## Mistakes to avoid

| Mistake | Why it hurts | Fix |
|---------|--------------|-----|
| Treating tt_features as markdown | Skill operates on DB rows. There are no files to edit. | Always go through SQL. |
| Status typos: `propus`, `In Focus` (no diacritic), `Done` | The DB and UI use exact Romanian strings. Wrong casing/diacritics silently break UI filters. | Hardcode `Propus`, `Planificat`, `În Focus`, `Gata`. |
| Forgetting `project_id = <project_id>` in queries | You'd triage and implement features that belong to a different repository you can't access. | Always include the filter (Step 0 resolves it). |
| Implementing without triage | Half the proposals are duplicates, too vague, or not worth the effort — that's why this skill exists. | Step 3 runs before any code is written, every time. |
| Skipping the "already exists?" check | Implementing a duplicate wastes hours and creates two competing code paths. | Every evaluator prompt asks it explicitly; trust but spot-check the claim. |
| Processing `În Focus` rows | A human may be actively working on them; you'd collide. | Step 2 excludes them by design. |
| Setting `is_archived = true` to "clean up" rejected features | Archiving is the user's call in the UI; a rejected proposal is still their data. | Rejected features stay `Propus` with the rationale appended. |
| Marking `Gata` on a typecheck only | Compile success doesn't prove the acceptance criteria are met. | Verify against the description's acceptance criteria via preview/SQL; evidence in hand first. |
| Re-appending the same evaluation on every run | Descriptions balloon and the UI becomes unreadable. | Skip the append when an `--- Evaluat` block with the same recommendation already exists. |
| Parallelizing across features in Step 4 | Features touch overlapping code; the preview is single-tenant. | Sequential across features, parallel within one (evaluators in 3a are the exception — read-only). |
| Editing team-tracker's source while implementing for another project | The features are owned by team-tracker UI; implementations belong in `<source_root>`. | Never modify `C:/Users/lakie/Desktop/team-tracker/src` unless `project_id = 2`. |
| Ignoring the project's CLAUDE.md conventions | The implementation gets rejected in review (missing translations, drifted button styles, lint failures). | Step 1 reads CLAUDE.md; Step 4b applies it; lint guards run before verification. |
| Manually syncing Focus cards after `Gata` | The `trg_sync_focus_on_feature_done` trigger already does it. | Just set `status='Gata'` and let the trigger work. |
| Trusting a "no RLS" / "no policy" claim from migration grep alone | Policies created in unrelated migrations are invisible to grep; a previous bug-sweep shipped a half-fix this way. | Verify `pg_policy` and `pg_class.relrowsecurity` live via SQL before relying on a table's policy state. |
| Aborting a run with rows still `În Focus` | Discovery treats human-less `În Focus` rows as orphans only via the description marker — a clean trail matters. | On any abort/self-abort, first revert every row this run flipped to `În Focus` back to `Planificat`. |

## When the skill should self-abort

Stop immediately and report to the user when any of these happen:
- The Supabase MCP server is disconnected (or `execute_sql` errors out repeatedly).
- The resolved `<source_root>` is missing or unreadable.
- Step 0 cannot resolve the cwd to a `tt_projects` row.
- The discovery query returns zero `Propus`/`Planificat` rows for this project. (Empty backlog. Say so and stop.)
- The first evaluator subagent crashes with a tool-permission error you cannot work around.

Before stopping, revert any rows this run flipped to `În Focus` back to `Planificat` so they aren't stranded. Then output a single sentence describing what blocked you and what the user needs to do.
