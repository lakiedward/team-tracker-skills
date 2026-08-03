# Daily planning contract

Read this reference before querying or writing delivery-planning data.

## Data ownership

- `tt_delivery_profiles`: human-owned outcome, definition of done, deadline, owner, and future weekly capacity.
- `tt_delivery_plans`: approved immutable daily snapshots, except `status` when superseded.
- `tt_delivery_plan_items`: only the approved committed and reserve queues for one workday. `queue_role` is independent from phase and deadline necessity; manual override columns remain human-owned.
- `tt_work_log_items`: high-confidence Pontaj links used to improve velocity.
- `tt_delivery_calibration`: rolling item-level P50/P75 and correction factors, separated by source type.
- `tt_todos.origin`: `manual` or `deadline_skill`.
- `tt_todos.planning_key`: stable UUID for idempotent generated gaps.
- `tt_project_velocity`: fast RLS-invoker snapshot of rolling 90-day velocity.
- `tt_ui_surfaces`: inventory plus manual UI authority. Audit writers must not update `manual_*` fields. `spec_approved_at` and `manual_verdict` are the two human gates; `verified_at` is derived by a trigger and must never be written by hand.
- `tt_ui_surface_criteria`: the per-section definition of done. One row per verifiable expectation, `required` rows must each be proven by a passing `tt_test_items` step through `criterion_id`.
- `tt_section_pipeline`: read-only view that derives `next_action` per active surface. It is the only lifecycle input this skill needs; never recompute the lifecycle from the individual columns.
- `tt_ui_audits` and `tt_ui_audit_items`: versioned AI/browser evidence and fingerprints.
- `tt_ui_findings`: current objective/suggested issues, manual disposition and optional promoted Bug/Feature/To-Do link.

Never store source-code contents, credentials, environment variables, expiring signed URLs, or raw execution prompts. Tracker descriptions and attachment storage paths remain on their owning source rows; Productivitate resolves them only when the user copies a prompt.

## Read configured scope

```sql
SELECT
  project.id,
  project.name,
  project.slug,
  profile.brief,
  profile.definition_of_done,
  profile.deadline,
  profile.owner_member_id,
  member.name AS owner_name,
  profile.weekly_capacity_hours,
  profile.planning_enabled,
  profile.updated_at
FROM public.tt_projects project
LEFT JOIN public.tt_delivery_profiles profile ON profile.project_id = project.id
LEFT JOIN public.tt_members member ON member.id = profile.owner_member_id
WHERE project.is_archived = false
  AND (
    '<optional_slug>' = ''
    OR lower(project.slug) = lower('<optional_slug>')
  )
ORDER BY project.sort_order, project.name;
```

An enabled profile is valid only when brief and definition are non-empty and deadline, owner, and positive weekly capacity are present.

## Read velocity

```sql
SELECT *
FROM public.tt_project_velocity
WHERE project_id = <project_id> OR scope = 'personal'
ORDER BY scope;

SELECT *
FROM public.tt_delivery_calibration
WHERE project_id = <project_id> OR scope = 'personal'
ORDER BY source_type, scope;
```

Select calibration separately for `bug`, `feature`, `test_plan`, and `todo`:

1. project `direct`;
2. project `provisional`;
3. personal `direct`;
4. personal `provisional`;
5. insufficient item history.

`provisional` means 2–9 completed linked items. Its
`applied_correction_factor` is clamped to `0.50–1.50`; use that field and never
the lower raw `observed_correction_factor`. `direct` begins at 10 items and uses
the wider `0.25–2.00` clamp. `p50_hours_per_item` and `p75_hours_per_item`
contain allocated hours, so one multi-item Pontaj row is never counted in full
for each item.

For a feature with insufficient type calibration, use `tt_project_velocity`:
project direct/weekly, then personal fallback. That view exposes a usable P25
only after at least 4 sampled weeks and 10 features. Do not use this
feature-sized fallback for bugs, tests, or To-Dos. Snapshot every selected row.
Never hardcode a previous rate. `raw_items_per_hour` is informational only.

## Read every tracker source

Read a lightweight project-scoped catalog without status or archive filters. Paginate rather than truncate.

```sql
SELECT id, title, status, priority, effort, focus_task_id, is_archived,
       image_urls, updated_at
FROM public.tt_features
WHERE project_id = <project_id>
ORDER BY id;

SELECT id, title, status, priority, effort, focus_task_id, is_archived,
       image_urls, updated_at
FROM public.tt_bugs
WHERE project_id = <project_id>
ORDER BY id;

SELECT id, title, status, priority, effort, focus_task_id, is_archived,
       origin, planning_key, updated_at
FROM public.tt_todos
WHERE project_id = <project_id>
ORDER BY id;

SELECT
  plan.id,
  plan.title,
  plan.description,
  plan.priority,
  plan.effort,
  plan.test_type,
  plan.is_archived,
  plan.updated_at,
  jsonb_agg(
    jsonb_build_object(
      'id', item.id,
      'description', item.description,
      'result', item.result,
      'image_paths', item.image_paths,
      'order_index', item.order_index
    )
    ORDER BY item.order_index
  ) FILTER (WHERE item.id IS NOT NULL) AS items
FROM public.tt_test_plans plan
LEFT JOIN public.tt_test_items item ON item.test_plan_id = plan.id
WHERE plan.project_id = <project_id>
GROUP BY plan.id
ORDER BY plan.id;
```

After counting the complete catalog, expand descriptions for all active rows and only relevant completed or archived evidence. Never load an unfiltered cross-project archive. Treat `tt_bugs.image_urls`, `tt_features.image_urls`, and `tt_test_items.image_paths` as private Storage paths. Generate short-lived signed URLs only for selected or seriously considered candidates and inspect every selected attachment. Buckets `ui-review-evidence`, `bug-screenshots`, `feature-screenshots` and `test-screenshots` are admin-only, so sign with the `service_role` key from `SUPABASE_SERVICE_ROLE_KEY`; the `anon` key is rejected. A missing variable is a stop condition — report it instead of skipping the attachment silently.

## Read current UI Coverage

```sql
SELECT *
FROM public.tt_ui_surfaces
WHERE project_id = <project_id>
ORDER BY kind, stable_key;

SELECT *
FROM public.tt_ui_audits
WHERE project_id = <project_id>
ORDER BY version DESC;

SELECT item.*
FROM public.tt_ui_audit_items item
JOIN public.tt_ui_audits audit ON audit.id = item.audit_id
WHERE audit.project_id = <project_id>
  AND audit.status = 'current';

SELECT *
FROM public.tt_ui_findings
WHERE project_id = <project_id>
ORDER BY detected_in_latest DESC, last_detected_at DESC;
```

## Read the section delivery pipeline

```sql
SELECT *
FROM public.tt_section_pipeline
WHERE project_id = <project_id>
ORDER BY required_for_launch DESC, kind, label;

SELECT criterion.*
FROM public.tt_ui_surface_criteria criterion
JOIN public.tt_ui_surfaces surface ON surface.id = criterion.surface_id
WHERE surface.project_id = <project_id>
ORDER BY criterion.surface_id, criterion.order_index;
```

`next_action` is authoritative. Map it straight to the queued action:

- `needs_spec` — no criteria, or the spec is not approved. Propose writing the
  criteria from `code_refs`; the human approves them in Productivitate.
- `build` — spec approved, no verdict pending. Build or continue the section.
- `blocked_on_you` — the surface is awaiting a verdict, or an approval went stale
  because `inventory_fingerprint` no longer matches `verdict_fingerprint`. Report
  it, do not queue work and do not consume planned hours.
- `needs_work` — the human rejected it. Resolve exactly what `manual_note` and
  the current objective findings describe.
- `needs_tests` — design approved but `criteria_uncovered > 0` or
  `blocking_findings > 0`. Generate one test step per criterion and run it.
- `ready_for_production` — merge, deploy, verify, then mark `shipped_at`.
- `shipped` — excluded from the candidate pool.

Launch scope is `required_for_launch = true` across every `kind`. A section can be
required while its page is not, and the reverse. The pipeline covers only what the
user can see; the project `definition_of_done` remains the authority for
everything else (emails, migrations, RLS, SEO, performance, monitoring). Both must
be green before a release.

`tt_ui_surfaces` allows only `page -> section|state`, so a section owns no child
surfaces. Its states are expressed as `kind = 'state'` criteria, never as extra
surfaces.

Stale when:

- no current audit item exists for an active page;
- `tt_ui_surfaces.inventory_fingerprint` differs from
  `tt_ui_audit_items.surface_fingerprint`;
- the current audit summary lists the surface key in `stale_surface_keys`.

Launch-ready for a required page only when the manual verdict is `liked` or
`acceptable`, the audit is fresh, no current objective Critical/High finding
exists on the page or child, and a native page has
`manual_device_verified_at`.

Candidate rules:

- promoted finding: load the linked standard Bug/Feature/To-Do and deduplicate;
- proposed/dismissed/unpromoted finding: risk only, never candidate;
- manual `needs_work`/`redesign` with a concrete manual note: may propose one
  generated To-Do with canonical key `ui:<surface_stable_key>`;
- subjective suggestion alone: never launch blocker or candidate.

Generate signed URLs only for UI evidence attached to a selected candidate.
Sign through the Storage REST API for bucket `ui-review-evidence` with a
one-hour expiry, using the `service_role` key from the
`SUPABASE_SERVICE_ROLE_KEY` environment variable. Never store the signed URL in
a delivery plan.

## Read current daily queue and overrides

```sql
SELECT *
FROM public.tt_delivery_plans
WHERE project_id = <project_id>
ORDER BY version DESC;

SELECT item.*
FROM public.tt_delivery_plan_items item
JOIN public.tt_delivery_plans plan ON plan.id = item.plan_id
WHERE plan.project_id = <project_id>
ORDER BY plan.version DESC, item.sequence;
```

A current daily plan has:

```sql
status = 'current'
AND velocity_snapshot->>'planning_mode' = 'daily_execution'
```

Use `velocity_snapshot->>'planning_date'` as its workday. Compare stable keys for the diff. Carry locked values for a stable key, but never let a stale locked date silently move an item away from the newly approved workday; show the conflict before approval.

## Daily calculations

Run `scripts/daily-budget.mjs`. Its output is the calculation contract.

Let:

- `W` = manually assigned weekly hours;
- `D` = working days from the planning date through the deadline;
- `R` = aggregate remaining high hours;
- `G` = gross daily hours = `W / 5`;
- `C0` = base committed hours = `G - 1`, or `G` when `G <= 1`;
- `Q` = required daily pace = `R / D`.

Then:

- committed target `C = min(G, max(C0, Q))`;
- effective buffer hours = `G - C`;
- reserve target after packing committed work = `G - committed_hours_low`;
- gross remaining capacity = `D × G`;
- overload/day = `max(0, Q - G)`;
- overload/week = overload/day × 5.

Feasibility:

- `on_track`: `Q <= C0`;
- `at_risk`: `C0 < Q <= G`;
- `infeasible`: `Q > G`, deadline passed with work remaining, a mandatory dependency cannot fit, or a locked override makes delivery impossible;
- `incomplete`: codebase coverage is insufficient to make a reliable determination.

Use high estimates for capacity and show low/high totals. These calculations evaluate the deadline; they do not create a dated release roadmap.

## Daily snapshot shape

Merge the selected velocity row with:

```json
{
  "planning_contract_version": 2,
  "planning_mode": "daily_execution",
  "planning_date": "2026-07-27",
  "gross_daily_hours": 5,
  "base_committed_hours": 4,
  "committed_target_hours": 4,
  "target_hours": 4,
  "selected_hours": 4,
  "selected_count": 1,
  "committed_hours_low": 2.5,
  "committed_hours_high": 4,
  "committed_count": 1,
  "committed_gap_hours": 0,
  "reserve_target_hours": 2.5,
  "reserve_hours_low": 1.5,
  "reserve_hours_high": 2.5,
  "reserve_count": 2,
  "reserve_gap_hours": 0,
  "queue_hours_total_high": 6.5,
  "candidate_count": 78,
  "candidate_counts": {
    "bug": 26,
    "feature": 6,
    "test_plan": 15,
    "todo": 0,
    "codebase_gap": 2
  },
  "selected_counts": {
    "bug": 1,
    "feature": 0,
    "test_plan": 0,
    "todo": 0,
    "codebase_gap": 0
  },
  "reserve_counts": {
    "bug": 1,
    "feature": 1,
    "test_plan": 0,
    "todo": 0,
    "codebase_gap": 0
  },
  "source_calibration": {
    "bug": {
      "scope": "project",
      "method": "provisional",
      "sample_items": 5,
      "p50_hours_per_item": 0.375,
      "p75_hours_per_item": 0.5,
      "observed_correction_factor": 0.25,
      "applied_correction_factor": 0.5
    }
  },
  "working_days_left": 26,
  "required_daily_hours": 10.63,
  "overload_hours_per_day": 5.63,
  "release_readiness": {
    "schema_version": 1,
    "summary": {
      "total": 4,
      "met": 1,
      "partial": 1,
      "blocked": 1,
      "unknown": 1
    },
    "outcomes": [
      {
        "key": "checkout-production-ready",
        "title": "Checkout funcțional în producție",
        "status": "partial",
        "required": true,
        "evidence": ["Build-ul trece"],
        "blockers": ["Fluxul 3DS nu este verificat"],
        "source_keys": ["bug:42"]
      }
    ],
    "diff": {
      "improved": [],
      "regressed": [],
      "new": ["checkout-production-ready"],
      "removed": [],
      "unchanged": []
    }
  }
}
```

Numbers are examples only. Recalculate them on every run.

## Proposal hash

Compute SHA-256 over canonical JSON with sorted keys containing:

- project id;
- profile values and `updated_at`;
- previous current plan id/version;
- planning date and daily-budget output;
- selected velocity snapshot;
- selected per-source calibration rows;
- repository labels, HEAD SHAs, and dirty flags;
- complete tracker source counts;
- sorted daily selected stable keys, source ids, daily estimates, completion criteria, and dependencies;
- queue roles and launch-outcome keys for every selected item;
- the freshly rebuilt release-readiness outcomes and their diff;
- attachment storage paths for selected sources, never signed URLs;
- current UI audit id/version, included surface fingerprints, manual verdicts,
  promoted source links, and selected UI evidence Storage paths;
- selected generated To-Do keys;
- preserved overrides.

Do not include prose, local paths, scan timestamps, unselected candidate ordering, or other presentation-only values.

## Copy-ready execution prompt

Do not persist a prompt blob on `tt_delivery_plan_items`. Productivitate builds it on demand from:

- the plan's brief, definition of done, deadline, summary, and repo snapshot;
- the selected plan item's action title, complete description snapshot, estimate, dependencies, and `scope_reason`;
- the current source title, status, priority, and full tracker description;
- private attachment storage paths resolved to new signed URLs at read time.
- for UI-backed work: page/section labels, surface stable key, manual verdict and
  note, current audit fingerprint, objective findings, private UI evidence
  paths resolved to fresh signed URLs, and exact browser scenarios.

For an attachment-bearing source, the prompt must include both the stable Storage path and the temporary URL, say that every image must be inspected before editing, and explain how to regenerate an expired signed URL. For test plans, retain the owning test step in each attachment label.

A `ui_surface` prompt carries the ordered criteria as its definition of done, marks
which are required, and states that the section is closed by its pipeline rather
than by a status write: the agent implements, re-audits, submits for review, and
generates one test step per criterion. The human answers Gate 1; `verified_at`
follows from the passing steps.

The prompt must state `queue_role`. A reserve prompt says to start only after committed work is complete or documented as blocked, inspect the planning day's Pontaj before starting, and stop when actual logged work reaches `gross_daily_hours`.

`scope_reason` is the compact execution contract. It must contain why the item is selected now, an observable completion criterion, verified starting paths/symbols from the codebase, `verification_mode=browser|non_browser`, and the required tests or build checks. For browser mode, record the exact scenario plus relevant viewports/devices. A copied prompt must still be actionable when the source has no attachments.

Classify user-visible UI, responsive behavior, navigation, forms, auth, payments, browser state, and end-to-end web flows as `browser`; uncertainty defaults to `browser`. After implementation, browser-required work moves to Focus `În testare`. A failed, unavailable, or undocumented browser test leaves it there and forbids `Fixed`/`Gata`. Browser evidence must state the tested URL/scenario, viewports/devices, steps, observed result, and console-error state.

The final prompt instruction must update the owning tracker source only after the completion criterion and every required verification pass: bugs to `Fixed`, features and To-Dos to `Gata`, and test-plan results per executed step. If the tracker write fails, the execution is not fully complete and the exact error must be reported.

## Transactional daily apply

Use one transaction per approved project. Substitute only displayed and approved values. Escape text safely.

```sql
BEGIN;

SELECT *
FROM public.tt_delivery_profiles
WHERE project_id = <project_id>
FOR UPDATE;

SELECT *
FROM public.tt_delivery_plans
WHERE project_id = <project_id> AND status = 'current'
FOR UPDATE;

-- Idempotent retry guard. If present, ROLLBACK and report already applied.
SELECT id, version, status
FROM public.tt_delivery_plans
WHERE project_id = <project_id>
  AND proposal_hash = '<sha256>';

-- Repeat only for approved codebase gaps selected today.
-- Never set status during an upsert: preserve human progress.
INSERT INTO public.tt_todos (
  title,
  description,
  status,
  priority,
  project_id,
  assigned_to,
  origin,
  planning_key
)
VALUES (
  '<title>',
  '<description>',
  'De făcut',
  '<priority>',
  <project_id>,
  '<owner_name>',
  'deadline_skill',
  '<stable_uuid>'
)
ON CONFLICT (project_id, planning_key)
  WHERE origin = 'deadline_skill' AND planning_key IS NOT NULL
DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  priority = EXCLUDED.priority,
  assigned_to = EXCLUDED.assigned_to,
  updated_at = now()
WHERE tt_todos.origin = 'deadline_skill'
RETURNING id, planning_key;

UPDATE public.tt_delivery_plans
SET status = 'superseded', updated_at = now()
WHERE project_id = <project_id> AND status = 'current';

INSERT INTO public.tt_delivery_plans (
  project_id,
  version,
  status,
  proposal_hash,
  feasibility,
  brief_snapshot,
  definition_of_done_snapshot,
  deadline_snapshot,
  owner_member_id,
  owner_name_snapshot,
  weekly_capacity_hours,
  buffer_percent,
  total_estimated_hours,
  remaining_estimated_hours,
  available_hours,
  velocity_features_per_hour,
  velocity_hours_per_feature,
  velocity_method,
  velocity_confidence,
  velocity_snapshot,
  analysis_coverage,
  repo_state,
  risks,
  assumptions,
  alternatives,
  summary
)
VALUES (
  <project_id>,
  <previous_version_plus_one>,
  'current',
  '<sha256>',
  '<on_track_at_risk_infeasible_or_incomplete>',
  '<brief>',
  '<definition_of_done>',
  '<deadline>',
  <owner_member_id>,
  '<owner_name>',
  <weekly_capacity_hours>,
  <daily_buffer_percent>,
  <aggregate_total_high_hours>,
  <aggregate_remaining_high_hours>,
  <gross_remaining_capacity>,
  <rate_or_null>,
  <hours_per_feature_or_null>,
  '<direct_weekly_personal_fallback_or_insufficient>',
  '<high_medium_or_low>',
  '<velocity_plus_daily_json>'::jsonb,
  '<full_tracker_only_or_incomplete>',
  '<repo_state_without_paths>'::jsonb,
  '<risks_json>'::jsonb,
  '<assumptions_json>'::jsonb,
  '<deadline_alternatives_json>'::jsonb,
  '<daily_summary>'
)
RETURNING id, version;

-- Insert ONLY the approved queue for planning_date.
INSERT INTO public.tt_delivery_plan_items (
  plan_id,
  stable_key,
  source_type,
  source_id,
  title_snapshot,
  description_snapshot,
  phase,
  sequence,
  planned_due_date,
  estimate_hours_low,
  estimate_hours_high,
  confidence,
  dependencies,
  required_for_deadline,
  queue_role,
  launch_outcome_keys,
  scope_reason
)
VALUES
  (
    <new_plan_id>,
    '<stable_key>',
    '<bug_feature_test_plan_todo_or_ui_surface>',
    <source_id>,
    '<daily_action_title>',
    '<source_description_snapshot>',
    '<daily_phase>',
    <sequence>,
    '<planning_date>',
    <today_low_hours>,
    <today_high_hours>,
    '<confidence>',
    ARRAY['<dependency_stable_key>']::text[],
    <required_for_deadline>,
    '<committed_or_reserve>',
    ARRAY['<launch_outcome_key>']::text[],
    '<why_now_completion_criterion_code_starting_points_and_verification>'
  );

COMMIT;
```

A `ui_surface` item uses `source_id = tt_ui_surfaces.id` and
`stable_key = 'ui_surface:' || surface.stable_key`. Inside the same transaction,
move the stage forward only where the queued action requires it:

```sql
-- Only for sections queued as build/needs_work work today.
UPDATE public.tt_ui_surfaces
SET delivery_stage = 'in_progress', updated_at = now()
WHERE id = ANY(ARRAY[<selected_surface_ids>]::bigint[])
  AND shipped_at IS NULL
  AND delivery_stage <> 'awaiting_review';
```

Never write `spec_approved_at`, `manual_verdict`, `verified_at` or `shipped_at`
from this skill. The first two are the human gates, the third is derived by a
trigger, and the fourth requires a verified deployment.

On error, roll back the whole project. Never supersede the old plan outside this transaction.

## Focus integration

Focus derives both daily queues from the current plan:

1. require `planning_mode = daily_execution`;
2. require `planning_date` equal to today's Bucharest workday;
3. default missing or null `queue_role` to `committed` for old plans;
4. map sources to Focus card keys:
   - `bug:<id>`;
   - `feature:<id>`;
   - `todo:<id>`;
   - `test:<id>` for `source_type = test_plan`;
   - `section:<id>` for `source_type = ui_surface`. A section has no Focus card and
     no status field; it opens in Productivitate under UI Coverage.

The existing board filters only `committed` rows under **Plan azi**. Render `reserve` rows in a visible ordered **Dacă termini mai devreme** section and exclude them from mandatory counts and progress. Do not change source statuses or create focus overlay rows merely to make a daily item visible.

## Pontaj linkage

After inserting a work log, link only explicit or unmistakable session items:

```sql
INSERT INTO public.tt_work_log_items (
  work_log_id,
  source_type,
  source_id,
  link_method,
  confidence,
  estimated_hours_snapshot
)
VALUES (
  <work_log_id>,
  '<source_type>',
  <source_id>,
  '<explicit_or_session_context>',
  'high',
  <latest_effective_estimate_or_null>
)
ON CONFLICT DO NOTHING;
```

Resolve `latest_effective_estimate_or_null` from the newest plan item for the
same project/source generated no later than the Pontaj insertion. Insert every
validated session item in one statement. Database triggers distribute the work
log's hours proportionally to these snapshots when all are available, otherwise
equally, and write `allocated_hours`. The trigger also reallocates when a link
or the Pontaj hours change.

The source-validation trigger rejects missing and cross-project sources. If no
item clears high confidence, create no link and ask no extra question.
