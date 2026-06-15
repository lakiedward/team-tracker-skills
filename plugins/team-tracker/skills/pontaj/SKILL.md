---
name: pontaj
description: Use when the user wants to log (pontaj / pontat) their own work hours on the team-tracker dashboard — or invokes "/pontaj". On the FIRST run it asks which team member you are (picked from the live tt_members list) and remembers the choice on this machine, so it never asks again; an explicit name in the invocation or the TT_MEMBER env var overrides. Resolves the current project from the working directory, summarizes what was worked on in the CURRENT chat session (git diff + the conversation), computes the hours automatically from the chat session's active duration (rounded to 0.5h, idle gaps excluded) unless you state the hours explicitly, and inserts ONE row into the Supabase table tt_work_logs (member = remembered identity, project_id from cwd) which the team-tracker "Pontaj" page renders. Triggers on "ponteaza", "ponteaza-ma", "pontaj", "pontează ce am lucrat", "ponteaza orele", "pontaj pe proiectul asta", "trece-mi orele", "log my hours", "log my time", "clock my work", "add a worklog", "ponteaza azi", "ponteaza X ore". Use it even when the user only says "ponteaza" with no other detail — that is the whole point of this skill.
---

# Pontaj

Turn the work done in the **current chat session** into one time-log entry for **the person running it** and write it to the team-tracker Supabase database, so it shows up on the "Pontaj" page. One run = one `tt_work_logs` row: who (resolved from `TT_MEMBER`), which project (resolved from the working directory), what category, what was done, how many hours, on what date.

## Why this skill exists

A team member jumps between several apps in the same day and wants a frictionless way to record their hours without opening team-tracker and filling the form by hand. Running `/pontaj` (or just saying "ponteaza ce am lucrat") should: figure out who they are, figure out which project this folder belongs to, write a short honest summary of what was worked on in this session, work out the hours from how long the chat actually ran, and insert the row directly. The **only** question it ever asks is on the very first run — "which team member are you?" — and it remembers the answer from then on. After that it's fully unattended. The one thing it can't measure is effort vs. wall-clock, so the chat duration is taken as *active* time (idle gaps clamped) and an explicit number in the invocation always overrides it.

The Pontaj page in team-tracker reads `tt_work_logs` and groups by member / project / category to answer "cine, cât și la ce a lucrat". So the row this skill writes has to use the **exact** member name and a category from the page's fixed list, or it lands in the wrong bucket / a stray "Other".

## Constants

| Item | Value |
|------|-------|
| Member name to log under | **resolved + remembered** — see Step 0b. First run picks from the live `tt_members` list and stores the choice via `scripts/member.mjs`; later runs read it back. An explicit name in the invocation or the `TT_MEMBER` env var overrides. Never default to a hardcoded name. |
| Member store (remembers who you are) | `~/.claude/team-tracker-member.json`, managed by `scripts/member.mjs` (`get` / `set "Name"`). Per-user, per-machine. |
| Project source root (what we summarize) | the current working directory — **resolved in Step 0** |
| Supabase project id (holds tt_* tables) | `ntjzghsbrzkvpkniotaj` |
| Table | `public.tt_work_logs` |
| Supabase MCP tool | a connected Supabase MCP pointed at project ref `ntjzghsbrzkvpkniotaj` (e.g. `mcp__supabase-mcp-server__execute_sql`, or whatever Supabase MCP server name is connected in this client). |
| `project_id` to write | **resolved in Step 0** from the cwd — never hardcoded; a `NULL` project_id is invisible on the Pontaj page's per-project view |
| Allowed `category` values | `Development`, `Testing`, `Content`, `Design`, `Research`, `Meeting`, `Other` — pick exactly one |
| `hours` source | **auto** — computed from the chat transcript by `scripts/chat_hours.mjs` (active engagement time, rounded to 0.5h). An explicit number in the invocation (`ponteaza 3 ore`) overrides it. |
| `hours` constraint | numeric, must satisfy `> 0 AND <= 24` (DB CHECK rejects anything else); the script already floors at 0.5 and caps at 24 |
| `work_date` | a `date`; defaults to today (`CURRENT_DATE`) |
| Default language for the description | Romanian |

This skill runs **fully unattended** after the first run — it asks nothing and inserts directly. It only stops for input on the very first run (Step 0b — "which member are you?", remembered afterwards) or when the transcript can't be read at all (Step 3 fallback).

## tt_work_logs — schema you write to

```
tt_work_logs (
  id          BIGSERIAL PRIMARY KEY,
  member      TEXT    NOT NULL,                         -- the runner's name, from TT_MEMBER
  project_id  BIGINT  REFERENCES tt_projects(id) ON DELETE SET NULL,  -- resolved from cwd; NULL = invisible per-project
  category    TEXT    NOT NULL,                         -- one of the 7 allowed values above
  description TEXT    NOT NULL DEFAULT '',              -- short Romanian summary of what was worked on
  hours       NUMERIC NOT NULL CHECK (hours > 0 AND hours <= 24),
  work_date   DATE    NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

`member` is a free TEXT column (not a FK), so casing matters for grouping — always write the name **exactly** as it appears on the Pontaj page (e.g. `Edy`, not `edy`/`EDY`), or a casing variant splits one person's hours into a phantom second person. RLS is on with the standard permissive policy, so the anon MCP connection can insert.

## Step 0 — Resolve which project this pontaj is for

Team members work across several app repos, all stored in the same team-tracker Supabase under different `tt_projects.id`. Detect the project from the cwd before anything else — the row's `project_id` depends on it.

```bash
basename "$(pwd)"
```

Then resolve to a row in `tt_projects` via the Supabase MCP:

```sql
SELECT id, name, slug FROM tt_projects
WHERE LOWER(slug) = LOWER('<dirname>')
   OR LOWER(REPLACE(slug, '_', '-')) = LOWER('<dirname>')
   OR LOWER(REPLACE(slug, '_', '')) = LOWER(REPLACE('<dirname>', '-', ''))
   OR LOWER(name) = LOWER(REPLACE('<dirname>', '-', ' '))
LIMIT 1;
```

Substitute `<dirname>` with the basename output. Examples (the live list drifts — never hardcode an id, always resolve): folder `team-tracker` → slug `team_tracker` (underscore/hyphen normalization); folder `BETRO` → slug `betro`; folder `culcush` → slug `culcush`. The match is on the folder name, so it works the same on any machine/OS regardless of where the repos live.

Capture the returned `id` as `<project_id>`, the `name` as `<project_name>`, and the cwd as `<source_root>`.

If no row matches, abort:
> "Nu am putut identifica proiectul din folderul curent ('<dirname>'). Folderul ar trebui sa aiba numele slug-ului din tt_projects. Spune-mi explicit pe ce proiect sa pontez sau muta-te in folderul corect."

## Step 0b — Resolve who to log as (member)

The member name is **per-person** and must never be guessed. The principle: **ask at most once, ever** — on the first run pick the member from the live list and remember it; every run after reads the remembered value silently. Resolve in this order, stopping at the first that yields a name:

1. **Explicit override in the invocation** — if the user named someone ("ponteaza pe numele lui Popa"), use that name verbatim **for this run only** (do NOT overwrite the remembered identity).
2. **The `TT_MEMBER` environment variable** (for power users who prefer to set it themselves):
   ```bash
   printf '%s' "$TT_MEMBER"          # bash
   ```
   ```powershell
   $env:TT_MEMBER                     # PowerShell
   ```
   If set and non-empty, use it verbatim (exact casing) as `<member>`.
3. **The remembered choice on this machine** — run:
   ```bash
   node "<skill_dir>/scripts/member.mjs" get
   ```
   If it prints a non-empty name, that's `<member>`. Done — ask nothing.
4. **First-run setup (nothing remembered yet) — this is the ONLY time the skill asks who you are.** Fetch the live member list, let the user pick, then persist it:
   1. Query the Supabase MCP for the roster:
      ```sql
      SELECT name FROM tt_members ORDER BY name;
      ```
   2. Ask once, presenting the names as a numbered list:
      > "E prima dată — care ești dintre membri?
      > 1. <name>
      > 2. <name>
      > …
      > Răspunde cu numărul sau numele."
   3. Map the answer to one of the listed names (exact casing from `tt_members`). If the user gives a name not in the list, confirm the spelling before storing (the Pontaj page groups by exact string).
   4. Persist it so the skill never asks again:
      ```bash
      node "<skill_dir>/scripts/member.mjs" set "<chosen name>"
      ```
   5. Use `<chosen name>` as `<member>` for this run.

The remembered name must match exactly what the Pontaj page groups on (`tt_members.name`) — picking from the queried list guarantees that. The store lives at `~/.claude/team-tracker-member.json`. To change identity later: run once with an explicit name, or `node "<skill_dir>/scripts/member.mjs" set "NewName"`, or delete that file to be asked again.

## Step 1 — Gather what was worked on (current session only)

The scope is **this chat session** — not the whole day, not since the last pontaj. Two sources, used together:

1. **The conversation** is the primary signal. Re-read the recent turns of this session to recover *what we actually did and why* — the features added, bugs fixed, things investigated. You were (usually) the one who did the work, so you know it; just be honest and concrete.
2. **Git, as corroboration** of which files moved. Run in parallel:
   - `git -C "<source_root>" status --porcelain=v1` — uncommitted edits made this session.
   - `git -C "<source_root>" diff --stat HEAD` — at-a-glance file list of uncommitted work.
   - `git -C "<source_root>" log --oneline -15` — recent commits, to spot any you made during this session (match them against what the conversation says you did).

Use git to ground the summary in real files, but don't log work that wasn't part of this session just because it shows in `git log`. If the session did work that isn't committed yet (only in the working tree), that still counts — it was worked on.

If there is genuinely nothing to log — the conversation has no implementation/investigation work **and** git shows no changes — don't invent something. Ask:
> "Nu vad nimic lucrat in sesiunea asta (fara modificari in git, fara munca in chat). Ce sa pontez? Spune-mi pe scurt si cate ore."

## Step 2 — Build the entry (member, category, description, work_date)

- **member** = `<member>` resolved in Step 0b (from `TT_MEMBER`, an explicit override, or the one-time ask). Never a hardcoded name.
- **category** — pick the single best fit from the allowed list based on the dominant work this session:

  | If the session was mostly… | category |
  |---|---|
  | writing code, building features, fixing bugs, refactoring, DB/migrations, wiring | `Development` |
  | writing/running tests, QA, test plans, manual verification | `Testing` |
  | copy, translations, text, data entry, docs content | `Content` |
  | UI/visual work, styling, layout, design polish | `Design` |
  | investigating, reading code, exploring options, planning approach (no code shipped) | `Research` |
  | a call/discussion/planning session | `Meeting` |
  | none of the above | `Other` |

  Default to `Development` when in doubt — it's the most common. If the user named a category in the invocation ("ponteaza 3 ore testing"), use that (mapped to the closest allowed value).
- **description** — a short, honest Romanian summary of what was worked on this session: 1–3 sentences (≤ ~300 chars). Concrete: name the features/pages/fixes in plain terms. Light technical wording is fine (this is the person's own log, not a tester plan) — but skip file-by-file dumps and raw diffs. If the user gave their own note ("ponteaza 2 ore: am pregatit demo-ul"), use their text as the description.
  - Good: `"Adăugat project switcher pe paginile Focus, Testing și Bug Reports; fix la butonul de delete screenshot la bug-uri (era doar pe hover)."`
  - Bad: `"work"` / `"diverse"` / a pasted git diff.
- **work_date** — today by default (`CURRENT_DATE`). If the user said a different day, honor it: `"ieri"` → today − 1 day; an explicit `YYYY-MM-DD` → that date. Pass the date as a literal `'YYYY-MM-DD'` (or use `CURRENT_DATE` for today).

## Step 3 — Determine the hours (auto, from the chat duration)

Do **not** ask. Work the hours out from how long this chat session actually ran. Two cases:

**A. The user stated hours in the invocation → use those, skip the script.** Recognize `/pontaj 4`, `ponteaza 3.5 ore`, `ponteaza-ma cu 2h`, `pontaj 1,5`, `pune 6 ore`. Normalize a comma decimal to a dot (`1,5` → `1.5`) and strip an `h`/`ore`/`hours` suffix. An explicit number always wins — the human knows their effort better than the clock.

**B. Otherwise, run the bundled script** to read the current session transcript's timestamps:

```bash
node "<skill_dir>/scripts/chat_hours.mjs" "<source_root>"
```

`<skill_dir>` is the folder this SKILL.md lives in (its `scripts/` subfolder holds `chat_hours.mjs`); `<source_root>` is the cwd from Step 0 (the script uses it to locate the right transcript dir, and falls back to `process.cwd()`). The script supports **both Claude Code** (`~/.claude/projects/`) and **Cursor** (`~/.cursor/projects/agent-transcripts/`) — it picks the newest transcript for the cwd and rounds to 0.5h. It prints one JSON line:

```json
{"transcript":"...","first":"...","last":"...","num_messages":119,
 "raw_hours":0.4,"active_hours":0.4,"idle_clamp_min":15,"round_to":0.5,"hours":0.5}
```

Use the **`hours`** field as-is. It is the *active engagement* time — the sum of gaps between messages with any gap over 15 min clamped out, so a chat left open or an overnight pause doesn't inflate it — rounded to the nearest 0.5h, floored at 0.5, capped at 24. No confirmation: the user chose fully auto.

Keep `raw_hours` and `active_hours` for the Step 5 report so the basis is visible (and if they differ a lot, that's the signal the chat had long idle gaps).

**Fallback (only on failure):** if the JSON has an `"error"` field (no transcript dir, fewer than 2 timestamps), the duration couldn't be measured — *then* ask once: `"Nu am putut citi durata chat-ului — câte ore să pontez?"` and validate `0 < hours <= 24`. Don't fall back to asking for any other reason; a successfully computed small number (e.g. 0.5h for a short chat) is correct, not an error.

## Step 4 — Insert the row (directly, no confirmation)

Once hours are known, insert immediately — the user chose direct insert, so there's no separate "OK?" prompt. **Escape single quotes** in `description` (and in `member`, if a name contains one) by doubling them (`'` → `''`) or the SQL breaks.

```sql
INSERT INTO tt_work_logs (member, project_id, category, description, hours, work_date)
VALUES (
  '<member>',          -- resolved in Step 0b; quotes doubled; never a hardcoded name
  <project_id>,        -- resolved in Step 0; never NULL
  '<category>',        -- one of the 7 allowed values
  '<description>',     -- quotes doubled
  <hours>,             -- 0 < hours <= 24
  CURRENT_DATE         -- or '<YYYY-MM-DD>' if the user gave a different day
)
RETURNING id, member, project_id, category, hours, work_date;
```

If the INSERT errors on the CHECK constraint, the hours were out of range — re-ask (Step 3) rather than retrying the same value. If it errors on a NULL `project_id`, Step 0 didn't resolve — go back and fix it; never insert a pontaj with no project.

## Step 5 — Report

Print the confirmation and the basis for the hours, nothing more:

```
Pontat ✓  tt_work_logs #<id> — <member> · <project_name> · <category> · <hours>h · <work_date>
<descrierea>
Ore: <hours>h — calculat din chat (~<active_hours>h activ din <raw_hours>h total)
```

The third line lets the user sanity-check the auto figure at a glance. When the hours came from an explicit number in the invocation instead of the script, say so: `Ore: <hours>h — specificat de tine`. If `raw_hours` is much larger than `active_hours`, add ` (au fost pauze lungi în chat)` so the gap is explained rather than surprising.

No "anything else?" epilogue — the row is the deliverable and the user can see it on the Pontaj page. If the figure is wrong, the user re-runs with an explicit number (`ponteaza 2 ore`) or fixes it on the Pontaj page.

## Mistakes to avoid

| Mistake | Why it hurts | Fix |
|---|---|---|
| Defaulting `member` to a hardcoded name | Logs the work under the wrong person — everyone's hours pile onto one name. | Resolve via Step 0b (remembered choice / `TT_MEMBER` / explicit); on the first run ask from the `tt_members` list and persist it. Never guess. |
| Re-asking who you are when a name is already remembered | The user set it up once; asking again is friction they explicitly rejected. | Always try `member.mjs get` first; only ask when it returns empty. |
| Overwriting the remembered identity on a one-off override | "ponteaza pe numele lui Popa" is for that run, not a permanent identity change. | An explicit invocation name is used for the run only; never `member.mjs set` it. |
| Hardcoding `project_id` (e.g. assuming team-tracker = 2) | The live `tt_projects` list drifts (ids get added/removed). A stale id files the pontaj under the wrong app or a deleted project. | Always resolve from cwd in Step 0. |
| Writing the name in the wrong casing (`edy` vs `Edy`) | `member` is free TEXT; the Pontaj page groups by exact string, so a casing variant splits one person's hours into a phantom second person. | Use the exact casing from `TT_MEMBER` / `tt_members`. |
| A free-form `category` like "coding" or "QA" | The page's category breakdown only knows the 7 fixed values; anything else falls outside the chips. | Map to one of `Development/Testing/Content/Design/Research/Meeting/Other`. |
| `hours = 0` or `> 24` | DB CHECK rejects the insert. | The script already floors at 0.5 and caps at 24; if you set hours by hand, validate. |
| Computing the chat duration by hand from timestamps | Finding the right transcript file and doing the date math (plus idle-gap clamping) is fiddly and easy to get wrong. | Always run `scripts/chat_hours.mjs` and read its `hours` field. |
| Using the raw first→last span as the hours | A chat left open over lunch or overnight would log 5h/18h of "work". | Use the script's `hours` (built on `active_hours`, idle gaps clamped), never `raw_hours`. |
| Not escaping `'` in the description | SQL syntax error; the insert fails. | Double single quotes (`'` → `''`). |
| Inserting with `project_id = NULL` | Row exists but is invisible on the per-project Pontaj view. | Step 0 must resolve a real id before Step 4. |
| Asking for confirmation / asking for hours when the script succeeded | The user chose fully-auto; any prompt is friction they explicitly rejected. | Only prompt on the first-run Step 0b identity pick or the Step 3 fallback. Otherwise insert silently. |
| Logging the whole day / since-last-pontaj instead of this session | Scope is the current chat session; pulling in unrelated commits double-counts. | Summarize only this session's work (conversation + this session's git changes). |
| Inventing work when nothing was done | A fake pontaj corrupts the hours data. | If there's no session work and no git change, ask the user what to log. |
| A vague description ("work", "diverse") | Useless on the Pontaj page; the person won't remember what it was. | Name the concrete features/fixes/pages in 1–3 sentences. |
| Editing project source while pontaj-ing | This skill only writes a DB row; it changes no code. | Never edit files — the deliverable is one `tt_work_logs` INSERT. |

## When to self-abort

Stop and tell the user (one sentence) when:
- The Supabase MCP isn't connected / `execute_sql` errors out → "Supabase MCP nu e conectat — reconecteaza-l si ruleaza din nou."
- Step 0 can't resolve the cwd to a `tt_projects` row (see the Step 0 abort message).
- It's the first run and the user won't pick a member, so no identity can be resolved (see the Step 0b first-run prompt).
- There's nothing to log and the user didn't say what to pontaj (see the Step 1 prompt).
