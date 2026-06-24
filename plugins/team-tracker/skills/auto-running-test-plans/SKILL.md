---
name: auto-running-test-plans
description: Use when the user asks Claude to act as the QA tester and run untouched testing plans automatically against the project's local dev server preview — or invokes "/auto-running-test-plans". Resolves the current project from the cwd, picks one non-archived plan from `tt_test_plans` / `tt_test_items` where ALL items are still `pending` (nobody has started it yet), starts the Vite (or equivalent) dev server via the preview MCP, drives each step using DOM-aware preview tools (snapshot, click, fill, eval, screenshot), writes result/notes per item, and archives the plan only if every item passes. Then picks the next untouched plan and repeats until the queue is empty. Triggers on "ruleaza planurile neatinse", "auto-test plans on preview", "robot tester", "fa singur testarea", "execute test plans on preview", "auto-execute pending plans", "run untouched test plans on preview".
---

# Auto-Running Test Plans (preview-based)

Claude becomes the QA tester. Pick a test plan that nobody has started yet (every item is still `pending`), drive the app step by step through the **Vite/dev-server preview MCP** (not on a real device), mark each item `pass` / `fail` / `blocked` in Supabase with evidence, and move to the next untouched plan. Stop when no untouched plan is left.

## Why this skill exists

The user writes a plan with `/writing-tester-test-plans` and wants to know "does it work right now?" without waiting for a human tester. This skill closes that gap: Claude executes the plan in the project's local dev preview through the `mcp__Claude_Preview__*` tools (DOM-aware, accessibility-tree based — no pixel measurements), captures screenshots as evidence, judges each step against its `expected_result`, and writes the verdict back to the database.

**Why preview, not a real device?** Preview is faster (no sync delay), more reliable (DOM-aware actuation), works for any web project regardless of platform (BetRO, Culcush, Padel, etc.), and the user already keeps a dev server running. Real-device testing is reserved for plans that explicitly need native behavior — those are marked `blocked` for human follow-up.

After this skill runs, `/resolving-failed-test-plans` can pick up any `fail` items and fix them. The two skills together turn the loop into a closed system: implement → write plan → auto-run → resolve failures → archive.

## Constants

| Item | Value |
|------|-------|
| Current project source root | **resolved in Step 0** — the current working directory |
| Supabase project id | `ntjzghsbrzkvpkniotaj` |
| Plan tables | `public.tt_test_plans`, `public.tt_test_items`, `public.tt_projects` |
| `project_id` filter | **resolved in Step 0** from cwd — **always** include `WHERE project_id = <project_id>` in `tt_test_plans` queries |
| **`test_type` filter** | **always `AND test_type = 'ai'`** in the untouched-plans query — this runner executes ONLY AI plans. `'human'` plans are for a human tester (team-tracker "Real user testing" toggle) and must never be auto-run. |
| `tt_projects` known rows | `1=BetRO/betro`, `2=Team Tracker/team_tracker`, `3=Popicu/popicu`, `4=Telegram Tips/telegram_tips`, `5=Social/social`, `6=Padel/padel`, `7=Culcush/culcush` |
| Preview launch config | `<source_root>/.claude/launch.json` — the name of the launch entry is the project's dev server name (BetRO: `vite-dev` on port 3000) |
| Preview MCP tools | `mcp__Claude_Preview__*` — `preview_start`, `preview_list`, `preview_snapshot`, `preview_click`, `preview_fill`, `preview_eval`, `preview_screenshot`, `preview_console_logs`, `preview_resize`, `preview_inspect` |
| Evidence dir | `<source_root>/.test-evidence/auto-run/<plan-id>/` |
| `tested_by` value | `'Claude Code (auto-run)'` |
| Result values (singular!) | `pass`, `fail`, `blocked`, `pending` |
| Max retries per item | 2 (then `blocked` with reason) |
| Mobile viewport for "phone-like" plans | `preview_resize preset=mobile` (375×812) — use only when the plan explicitly describes phone-only UI |

Do not ask the user to confirm these. If any prerequisite is missing, self-abort per the bottom section.

## Step 0 — Resolve current project

team-tracker tracks plans for multiple apps (BetRO, Culcush, Popicu, Padel, etc.), all sharing one Supabase. Detect which project this invocation is for from the cwd before anything else.

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
- `cwd = C:\Users\lakie\Desktop\BETRO` → `id = 1` (BetRO)
- `cwd = C:\Users\lakie\Desktop\culcush` → `id = 7` (Culcush)
- `cwd = C:\Users\lakie\Desktop\team-tracker` → `id = 2` (Team Tracker)

Capture the returned `id` as `<project_id>`, the cwd as `<source_root>`, and the slug as `<project_slug>`. Use them throughout.

If no row matches, abort: "Nu am putut identifica proiectul din folderul curent ('<dirname>')."

### Project capability check

This skill needs a runnable dev preview for the current project. Confirm `<source_root>/.claude/launch.json` exists. If missing, abort with: "Proiectul `<project_slug>` nu are `.claude/launch.json` configurat pentru preview MCP. Adauga o configuratie (vezi `mcp__Claude_Preview__preview_start` doc) sau foloseste alt skill."

## Step 1 — Bootstrap

Run these in parallel:

1. Confirm Supabase MCP reachable (small `execute_sql` ping). If disconnected, abort.
2. `mcp__Claude_Preview__preview_list` — see if a preview is already running for this project. If yes, reuse it (capture `serverId`). If no, `mcp__Claude_Preview__preview_start name=<dev_server_name>` (read the name from `<source_root>/.claude/launch.json`). Capture `serverId`.
3. Ensure `<source_root>/.test-evidence/auto-run/` exists for screenshot dumps (`Bash` with `mkdir -p` or PowerShell equivalent).

Then issue the "untouched plans" query (Step 2). Create a `TodoWrite` with one entry per untouched plan.

## Step 2 — Find untouched plans

A plan is **untouched** when every item is still `pending` **and** it is an AI plan (`test_type = 'ai'`). Human plans are never auto-run by this skill. Run:

```sql
SELECT
  p.id, p.title, p.area, p.priority, p.description,
  COUNT(i.id)                                                   AS total_items,
  SUM(CASE WHEN i.result = 'pending' THEN 1 ELSE 0 END)         AS pending_count
FROM tt_test_plans p
LEFT JOIN tt_test_items i ON i.test_plan_id = p.id
WHERE p.is_archived = FALSE
  AND p.project_id = <project_id>  -- resolved in Step 0 from cwd; only this project's untouched plans
  AND p.test_type = 'ai'           -- AI runner ONLY executes AI plans; human plans ('human') are run by a human tester
GROUP BY p.id, p.title, p.area, p.priority, p.description
HAVING COUNT(i.id) > 0
   AND COUNT(i.id) = SUM(CASE WHEN i.result = 'pending' THEN 1 ELSE 0 END)
ORDER BY
  CASE p.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 WHEN 'Low' THEN 2 ELSE 3 END,
  p.created_at ASC;
```

If the result is empty, stop with: "Nu am nici un plan AI neatins de rulat. Planurile AI active fie sunt deja partial bifate, fie nu exista. (Planurile 'Real user' sunt rulate manual de un tester, nu de mine.)"

Otherwise, print a compact table to the user (id, area, priority, total items) and start with the highest-priority oldest plan first.

## Step 3 — Pick the next plan and load its items

```sql
SELECT id, order_index, description, expected_result
FROM tt_test_items
WHERE test_plan_id = <plan_id>
ORDER BY order_index ASC;
```

Read the plan's `description` field too — it often contains "Pregatire" notes (which account to use, which screen to start on, whether 2 accounts are needed).

### Pre-flight bailouts (mark all items `blocked` then skip the plan)

Detect these patterns in the plan `description` OR in any item's `description`/`expected_result`:

- **Multi-account / cross-account**: "2 conturi", "al doilea cont", "al doilea device", "necesita Chrome localhost", "Cont A ... Cont B". Preview holds a single browser session — cannot run two-account scenarios. Block reason: `"Skill cannot run multi-account scenarios on a single preview — needs a human tester or a 2nd browser session."`
- **Native-only features**: "Continua cu Apple", "Sign in with Apple", "Face ID", "push notification", "FCM", "native sheet", "Capacitor plugin", "App Store", "Play Store". Preview cannot trigger these. Block reason: `"Skill cannot test native-only feature in preview — needs a real device."`
- **Multi-device / cross-device sync**: "alt device", "al doilea telefon", "device limit". Same as multi-account. Block reason: `"Skill cannot orchestrate cross-device behavior from a single preview."`

When any of these is detected, write `result = 'blocked'` with the reason for every item in the plan and skip to the next plan. Don't even try the first step.

For the rest, proceed item-by-item.

## Step 4 — Execute each item

For each item, in `order_index` order:

### 4a. Plan the action sequence

Re-read `description`. Identify:
- A target screen ("tab Pronostic AI", "biletul Arka Gdynia", "Setari → Cont")
- A discrete action ("apasa", "scrie in campul X", "deruleaza", "asteapta 60s")
- Any precondition (must be logged in, must be on a specific screen)

Re-read `expected_result`. Identify:
- The visible signal ("apare textul Y", "counter-ul devine X+1", "butonul devine activ")
- The forbidden signal ("NU vezi cuvantul Z", "nu apare mesaj de eroare")
- A negative ("aplicatia NU s-a blocat" — needs a snapshot sweep, not a single check)

Match these to actuator primitives:

| Description verb | How to execute via preview MCP |
|------------------|--------------------------------|
| "deschide aplicatia" | `preview_eval expression="window.location.href = 'http://localhost:<port>/'"` to reset, then `preview_snapshot` to confirm landing. (If the preview was started fresh in Step 1, the app loads automatically.) |
| "mergi la tab X" / "apasa pe butonul X" | First `preview_snapshot` to see what's in the DOM. Locate X by its `name`/`text` in the accessibility tree. Use `preview_click selector=...` with a stable CSS selector (prefer `data-testid`, otherwise role + accessible name, otherwise visible text contains). |
| "scrie in campul Y" | `preview_fill selector=<input-selector> value=<text>`. The selector should match an `<input>` or `<textarea>`. Romanian diacritics work directly. |
| "asteapta ... secunde" / "asteapta sa se incarce" | Brief Bash `sleep 2` or `preview_eval` polling expression (e.g. `await new Promise(r => setTimeout(r, 2000)); document.querySelector('.spinner') === null`). Cap blind sleeps at 15s; for longer waits, poll. |
| "deruleaza in jos" / "scroll" | `preview_eval expression="window.scrollBy({top: 600, behavior: 'instant'})"` or `preview_eval` to scroll a specific scrollable container. |
| "inchide aplicatia" / "back" | `preview_eval expression="window.history.back()"` for SPA back navigation. |
| "Verificare finala" / "non-regresie" | A sweep: navigate to 2-3 adjacent screens (`preview_click` on different tabs), `preview_snapshot` each to confirm no crash/empty DOM, optionally `preview_console_logs level=error` to detect runtime errors. |
| "verifica textul X apare" | `preview_snapshot` returns the accessibility tree; grep for text X in the tree. For CSS-rendered text not in the tree, use `preview_eval expression="document.body.innerText.includes('X')"`. |
| "verifica culoarea/dimensiunea" | `preview_inspect selector=<elem> property=color` (or `background-color`, `font-size`, etc.). |
| "simuleaza mobile/responsive" | `preview_resize preset=mobile` before the action; reset with `preset=desktop` after. |

**Reload after code changes (rare for auto-run)**: if you suspect HMR drift, `preview_eval expression="window.location.reload()"` and re-snapshot.

### 4b. Capture pre-state (only when the action is a state change)

For "counter becomes X+1", "form submits and item appears", "toggle flips" — capture a baseline so you can prove the diff.

```
mcp__Claude_Preview__preview_snapshot serverId=<id>
```

Save the accessibility-tree snapshot to a file under `<source_root>/.test-evidence/auto-run/<plan_id>/item_<order_index>_pre.txt`.

For most steps (single-screen visible check), skip the pre-snapshot — the post-snapshot alone is enough.

### 4c. Execute the actions

Run the action sequence using the tools from the table above. Prefer:
- **`preview_click` with a stable selector** when the target is a button/link/input.
- **`preview_eval`** ONLY for navigation, scrolling, history, and pure read-only inspection. Never use `preview_eval` to mutate UI state that the user would have done via clicks — that bypasses event handlers and gives false positives.

### 4d. Capture post-state and judge

After the action:

1. `preview_snapshot serverId=<id>` — get the accessibility tree.
2. Compare against `expected_result`:
   - Positive signal mention ("apare textul X"): grep the snapshot text for X. If absent, also try `preview_eval expression="document.body.innerText.includes('X')"` because CSS-rendered text may not appear in the a11y tree.
   - Negative signal ("NU vezi BTTS", "NU vezi cuvant englez"): scan the snapshot AND the innerText; flag any match.
   - State change ("counter becomes X+1"): diff pre vs post snapshot.
   - Style assertion ("butonul e negru", "marginea e 12px"): `preview_inspect` on the specific CSS property.
3. Visual confirmation (one screenshot per plan or per failed step, not per step): `preview_screenshot serverId=<id>` and save to `<source_root>/.test-evidence/auto-run/<plan_id>/item_<order_index>_post_<verdict>.jpg`.
4. Always check `preview_console_logs level=error lines=20` after a step that triggers app code — runtime exceptions don't always crash visibly but do indicate a real bug.

**Verdict rules:**
- **pass** — every positive signal in `expected_result` is observable AND no forbidden signal is observable AND no new error in console logs.
- **fail** — at least one positive signal is missing OR a forbidden signal is observable OR a new console error appears. Capture the bad evidence in the screenshot name and the item's `notes`.
- **blocked** — the action could not be executed (element not in DOM even after wait + scroll, preview hung, navigation timeout, server returned 5xx). Different from `fail`: `blocked` means "I couldn't even check"; `fail` means "I checked and the answer is no."

### 4e. Retry policy

If the verdict is `fail` due to a clearly transient cause (network spinner still visible, animation not finished, page mid-load), retry once: wait 3 seconds, re-snapshot, re-judge. Hard cap: 2 retries per item. After that, commit the last verdict and move on.

If the target element isn't in the DOM, try `preview_eval expression="window.scrollBy({top: 400})"` once each direction. Two scrolls, then commit `blocked` if still missing.

If the preview itself appears broken (snapshot returns empty / error boundary message / repeat console errors), `preview_eval expression="window.location.reload()"` once; if still broken after reload, mark current item `blocked` with reason `"Preview server unresponsive; needs manual restart."` and abort the run (Step 6 self-abort).

### 4f. Write the result to Supabase

```sql
UPDATE tt_test_items
SET
  result = '<pass|fail|blocked>',
  notes = E'Auto-run YYYY-MM-DD by Claude Code (auto-run, preview).\nEvidence: .test-evidence/auto-run/<plan_id>/item_<idx>_post_<verdict>.jpg\nObservation: <one-paragraph what you saw in the snapshot vs what was expected, including specific text quotes>',
  tested_by = 'Claude Code (auto-run)',
  tested_at = now(),
  updated_at = now()
WHERE id = <item_id>
RETURNING id, result, tested_at;
```

Update the `TodoWrite` entry to reflect the verdict (e.g. `Plan #78 item 3 → fail (Surprize sub-text still says "upside")`).

## Step 5 — After all items in a plan

Re-aggregate:

```sql
SELECT
  SUM(CASE WHEN result = 'pass'    THEN 1 ELSE 0 END) AS pass_count,
  SUM(CASE WHEN result = 'fail'    THEN 1 ELSE 0 END) AS fail_count,
  SUM(CASE WHEN result = 'blocked' THEN 1 ELSE 0 END) AS blocked_count
FROM tt_test_items WHERE test_plan_id = <plan_id>;
```

- **All pass, zero blocked** → archive the plan:
  ```sql
  UPDATE tt_test_plans SET is_archived = TRUE, updated_at = NOW() WHERE id = <plan_id>;
  ```
- **Any fail or blocked** → do NOT archive. The plan now has actionable feedback for `/resolving-failed-test-plans` to consume next.

Before moving on, reset the preview to a known state: `preview_eval expression="window.location.href = 'http://localhost:<port>/'"`. This avoids the next plan starting on a leftover modal or sub-route.

Move on to the next untouched plan from Step 2's list (the queue is fixed at start — do not re-query mid-run, because plans you just touched would be filtered out anyway).

## Step 6 — Final report

After the whole queue is processed:

```
Auto-run sweep — <YYYY-MM-DD> — project <project_slug>

Archived (N):
  - #<id>  <title>   (toate <K> items pass)
  - ...

Left with failures (M):
  - #<id>  <title>   (pass: <p>, fail: <f>, blocked: <b>)
        Primul fail: item <idx> — <one-line excerpt of the failure>
        Ruleaza /resolving-failed-test-plans pentru reparare.
  - ...

Skipped (multi-account / native / cross-device): K
  - #<id>  <title>  — <reason>
  - ...
```

That's the deliverable. Don't paste full evidence into the chat — the `.test-evidence/auto-run/<plan_id>/` directory holds the screenshots, the DB notes hold the observations.

## Selector strategy

Preview-based actuation lives or dies by selector quality. In order of preference:

1. **`[data-testid="..."]`** — explicit, stable, survives refactors. Use this if the project already uses test ids.
2. **Role + accessible name**: `button:has-text("Continua cu Google")`, `[role="tab"]:has-text("Pronostic AI")`. Playwright-style selectors are supported by `preview_click`.
3. **Visible text contains**: `button:has-text("Cota 2")` for buttons whose primary identifier is their label.
4. **CSS class**: `.auth-google-btn`, `.match-card`. Brittle to styling refactors — use only when nothing else fits.
5. **Tag + nth-of-type**: last resort, breaks easily.

If a selector resolves to multiple elements, prefer the one that is `aria-visible` and inside the main viewport. Use `preview_snapshot` to disambiguate before clicking.

## Common verification heuristics

For AI/translation plans (area `AI`):
- Sub-text under category buttons: visible immediately on tap. `preview_click` the filter button, then `preview_snapshot`, then grep the snapshot for forbidden English words: `BTTS`, `bet builder`, `single`, `combo`, `upside`, `Over 2.5` outside Romanian context, `Goals Over/Under`, `Both Teams Score`, `HT/FT` standalone, `Match Winner`, `Asian Handicap`, raw `**` markers.
- Card explanations: must trigger analysis generation first (`preview_click` on the card, then poll for spinner to clear: `preview_eval` for `document.querySelector('.ai-thinking') === null`, max 60s). Then `preview_snapshot` and grep.

For Social / cross-account plans (area `Social`): if `description` mentions multi-account behavior, mark all `blocked` in Step 3's bailout — preview is single-session.

For Bilete / Cote / Clasament plans: typically single-screen, fast verification. `preview_click` the relevant tab, `preview_snapshot`, check text.

For "Verificare finala" items: `preview_snapshot` from 2-3 adjacent tabs, confirm none show a blank screen or unhandled error in `preview_console_logs`. Pass unless visibly broken.

For visual/style plans ("butonul trebuie sa fie negru", "marginea 12px"): use `preview_inspect` on the specific CSS property — more reliable than reading screenshots.

For light-mode / dark-mode plans: `preview_resize colorScheme=light|dark` to flip the theme, then re-verify the assertions.

## Mistakes to avoid

| Mistake | Why it hurts | Fix |
|---------|--------------|-----|
| Using `preview_eval` to perform a click (e.g. `document.querySelector('button').click()`) | Bypasses React event handlers; gives false positives. Real user clicks go through synthetic events. | Always use `preview_click` for interactions. Reserve `preview_eval` for inspection and navigation. |
| Re-querying the untouched list mid-run | A plan you just marked might still show because items aren't all complete yet, but you'll process it twice. | Snapshot the queue once in Step 2; iterate that snapshot. |
| Running multi-account / native-only scenarios in preview | The plan was written for a tester with a real device or 2 accounts. Preview cannot replicate this; trying produces noise. | Detect the keywords in Step 3 and mark every item `blocked` with the right reason — don't try the first step. |
| Marking `pass` based on absence of error rather than presence of expected signal | Preview can render an empty DOM silently after a routing bug; you might pass everything because "no error message". | Every `pass` must cite a positive observable from the snapshot. |
| Confusing `fail` with `blocked` | Resolving skill downstream depends on this distinction. `blocked` = needs human / different tool; `fail` = code has a bug. | Use `blocked` only when the test could not run; otherwise `fail`. |
| Leaving the preview on a random route between plans | Subsequent plans assume the home route. | After each plan, `preview_eval` navigate to `/` so the next plan starts from a known state. |
| Forgetting to check `preview_console_logs` for runtime errors | A handler throws but UI doesn't show error; everything looks fine in snapshot but the feature is broken. | After every action that triggers app code, scan `preview_console_logs level=error`. |
| Writing essays in `notes` | The notes column is searchable; multi-paragraph waffle dilutes the signal. | One short paragraph: action attempted, observed text quote, verdict reason, evidence filename. |
| Archiving a plan with any blocked item | The plan is not fully validated; user expects to see it. | Archive only when zero blocked AND zero fail AND zero pending. |
| Stale preview after a code change | Some edits don't HMR cleanly — you assert against old code. | If you just landed a code change in the same session, `preview_eval expression="window.location.reload()"` before the first item. |
| Using brittle nth-child selectors | Breaks on layout changes; gives flaky `blocked` results. | Prefer `data-testid` > role+name > text > class. Document the selector you used in `notes` on `blocked` items so future runs improve. |
| Ignoring `preview_resize` for mobile-specific plans | The plan describes phone-only UI (responsive layout, swipe gestures); checking on desktop misses the mobile-specific element. | When the plan title or description mentions "mobile" / "phone" / "iPhone" / "Android", `preview_resize preset=mobile` first. |

## When to self-abort

Stop immediately and tell the user when:
- Supabase MCP server is disconnected.
- `mcp__Claude_Preview__preview_start` fails repeatedly (cannot launch dev server). Tell the user to start it manually or check `.claude/launch.json`.
- The resolved `<source_root>` is missing or unreadable.
- Step 0 cannot resolve the cwd to a `tt_projects` row.
- The current project does not have a `.claude/launch.json` (no preview configuration).
- 3 items in a row land `blocked` due to preview-infrastructure errors (not test failures) — this is a tooling problem, not a test problem.
- The untouched-plans query returns zero rows (nothing to do — say so and stop).

In each case, output a single sentence describing what blocked you and what the user needs to do.

## Relationship to the other plan skills

- `/writing-ai-test-plans` creates the AI plan rows (`test_type = 'ai'`) that this skill runs.
- `/writing-tester-test-plans` creates human plan rows (`test_type = 'human'`) — those are NOT run by this skill; a human tester runs them.
- `/auto-running-test-plans` (this skill) takes **AI** plans where every item is still `pending` and executes them in the preview.
- `/resolving-failed-test-plans` takes plans (human OR AI) where at least one item is `fail` and tries to fix the underlying code, then re-verifies (also via preview).

The three together cover: write → auto-execute → fix-and-archive. Each one only does its narrow slice. None of them depend on a real device by default — when a step truly needs a device (native-only features), it is marked `blocked` for human follow-up.

---

## Orchestrator target mode (single item)

Această secțiune se activează **exclusiv** când invocarea primește toți cei trei parametri:
`TARGET_PROJECT_ID`, `TARGET_SOURCE_ROOT`, și `TARGET_ITEM_ID` (pasați de Dispecer).
Dacă oricare lipsește, skill-ul rulează flow-ul normal (alege planuri neatinse din coadă, neschimbat).

Aici `TARGET_ITEM_ID` este **`test_plan_id`-ul unui singur plan AI neatins** — rulezi exact ACEL plan
(toți pașii lui `pending`), în loc să iei primul din coadă.

**Acest skill NU editează cod în worktree.** Spre deosebire de bug/feature/failed-test-plans, el doar
**RULEAZĂ** un plan pe preview și scrie rezultatele per item în DB. De aceea Dispecerul îl marchează
`no_worktree:true`: nu i se creează worktree izolat și rezultatul lui **nu se merge-uiește** niciodată.
`TARGET_SOURCE_ROOT` este aici doar rădăcina proiectului pentru a citi `.claude/launch.json` și a scrie
evidența — nu modifici niciun fișier sursă acolo.

### Parametri primiți de la Dispecer

| Parametru | Tip | Descriere |
|---|---|---|
| `TARGET_PROJECT_ID` | number | `project_id` al proiectului; înlocuiește rezolvarea din Step 0 |
| `TARGET_SOURCE_ROOT` | string | Rădăcina proiectului (NU un worktree — nu se editează cod); pentru `.claude/launch.json` și dir-ul de evidență. Înlocuiește cwd-ul din Step 0. |
| `TARGET_ITEM_ID` | number | `id`-ul exact al **planului** (`tt_test_plans.id`) de rulat; înlocuiește căutarea în coadă din Step 2 |
| `TARGET_PREVIEW_SERVER_ID` | string | (opțional) `serverId`-ul unui preview deja pornit; dacă e dat, **nu porni și nu opri preview-ul** — lease-ul e deținut de Dispecer |

### Modificări față de flow-ul normal

**Sari peste Step 0** — folosești direct `<project_id>` = `TARGET_PROJECT_ID`,
`<source_root>` = `TARGET_SOURCE_ROOT`, `<project_slug>` derivat din proiect.

**Sari peste căutarea în coadă din Step 2** — nu mai cauți „primul plan AI neatins". Validezi că planul
țintă este chiar neatins (toate itemele `pending`, AI, ne-arhivat), filtrând pe un singur plan:

```sql
SELECT
  p.id, p.title, p.area, p.priority, p.description, p.test_type, p.is_archived,
  COUNT(i.id)                                                   AS total_items,
  SUM(CASE WHEN i.result = 'pending' THEN 1 ELSE 0 END)         AS pending_count
FROM tt_test_plans p
LEFT JOIN tt_test_items i ON i.test_plan_id = p.id
WHERE p.project_id = <TARGET_PROJECT_ID>
  AND p.id = <TARGET_ITEM_ID>
GROUP BY p.id, p.title, p.area, p.priority, p.description, p.test_type, p.is_archived;
```

Validează: `is_archived = false`, `test_type = 'ai'`, `total_items > 0`, și
`pending_count = total_items` (nimeni nu l-a început). Dacă oricare cade
→ întoarce imediat JSON cu `outcome="blocked"`,
`question="Planul #<id> nu există / nu e AI / e arhivat / a fost deja început (nu mai e neatins)."`.

**Step 3 (încărcare iteme + pre-flight bailouts), Step 4 (execută fiecare item pe preview), Step 5
(re-agregare + eventual arhivare) sunt identice** cu flow-ul normal — rulezi planul pas cu pas pe preview,
scrii `result`/`notes` per item cu evidență, exact ca în sweep.

**Item write-back rămâne al tău:** scrii `tt_test_items.result` (`pass`/`fail`/`blocked`) cu notă + evidență
(Step 4f) și, dacă toți pașii trec, poți arhiva planul (Step 5) — la fel ca în sweep. Acest skill nu produce
un diff de cod, deci nu există merge pe care Dispecerul să-l facă; rezultatul lui informează doar runda
următoare (pașii `fail` apar pentru `/resolving-failed-test-plans`).

**Preview (lease):** dacă `TARGET_PREVIEW_SERVER_ID` este dat, **refolosește-l direct** — nu chema
`preview_start`/`preview_stop`; lease-ul e al Dispecerului. Dacă lipsește, pornește preview-ul normal
(Step 1 pct. 2) — ești în modul standalone.

**Nu printa raportul Step 6** (tabelul de sweep). În loc de raport, **întoarce un JSON structurat ca ULTIM
mesaj** (vezi mai jos).

### Output structurat — ultimul mesaj

Întoarce **exact** acest JSON ca ultimul mesaj (fără text în afara blocului JSON):

```json
{
  "item_id": <TARGET_ITEM_ID>,
  "outcome": "done|blocked",
  "verify_channel": "preview",
  "test_recommendation": "none",
  "effort": "low",
  "summary": "<un paragraf: câți pași pass/fail/blocked, ce s-a observat, dacă planul a fost arhivat>",
  "question": "<dacă outcome=blocked: de ce nu s-a putut rula planul; altfel câmpul lipsește sau e șir gol>",
  "no_worktree": true
}
```

Valori valide:
- `outcome`: `"done"` când planul a fost rulat până la capăt (rezultatele sunt scrise în DB — indiferent dacă
  toți pașii au trecut sau unii au picat; „done" înseamnă **rularea s-a terminat**, nu „toate pass").
  `"blocked"` doar când planul nu a putut fi rulat deloc (planul țintă nu e neatins/AI/ne-arhivat per
  validarea de mai sus, sau toate itemele au căzut în pre-flight bailout: multi-cont / native / cross-device,
  sau preview-ul a fost ne-responsiv). Notă: planurile folosesc `"done"` (nu `"fixed"`).
- `verify_channel`: **întotdeauna `"preview"`** — acest skill rulează exclusiv pe preview, iar **rularea efectivă
  a planului pe preview ESTE verificarea** (driverul DOM execută real pașii: snapshot/click/fill/eval/screenshot).
  Spre deosebire de skill-urile care editează cod, aici nu există „verificare prin grep/tsc/raționament" — un
  `outcome="done"` înseamnă că planul chiar a rulat pe preview, deci Dispecerul îl stampilează corect `verified:true`
  (rularea e verificarea, D1). Dacă preview-ul n-a putut fi rulat deloc, `outcome="blocked"` (nu inventa un „done").
- `test_recommendation`: **întotdeauna `"none"`** — testele nu nasc alte teste.
- `effort`: **întotdeauna `"low"`** — e rulare, nu implementare; nu se schimbă cod.
- `summary`: rezumatul compactat al rulării (counts pass/fail/blocked + observație + dacă s-a arhivat).
- `question`: prezent și non-gol **doar** când `outcome="blocked"`.
- `no_worktree`: **întotdeauna `true`** — semnalează Dispecerului că NU s-a creat worktree și că rezultatul
  acestui item nu se merge-uiește (nu există diff de cod). Dispecerul sare peste merge pentru itemele
  `no_worktree`.

**Câmpurile `worktree` și `branch`:** acest skill **nu folosește worktree** — lasă-le mereu goale sau omite-le.
Câmpul `needs_preview` poate fi setat `true` (rularea folosește preview), dar pentru că `no_worktree:true`
Dispecerul nu serializează un stage de verificare separat pentru el — verificarea ESTE rularea însăși.
