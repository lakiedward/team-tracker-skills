# Daily planning contract

Read this reference before querying or writing delivery-planning data.

## Data ownership

- `tt_delivery_profiles`: human-owned outcome, definition of done, deadline, owner, and future weekly capacity.
- `tt_delivery_plans`: approved immutable daily snapshots, except `status` when superseded.
- `tt_delivery_plan_items`: only the approved queue for one workday. Manual override columns remain human-owned.
- `tt_work_log_items`: high-confidence Pontaj links used to improve velocity.
- `tt_todos.origin`: `manual` or `deadline_skill`.
- `tt_todos.planning_key`: stable UUID for idempotent generated gaps.
- `tt_project_velocity`: fast RLS-invoker snapshot of rolling 90-day velocity.

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
```

Selection:

1. project row with `method IN ('direct', 'weekly')`;
2. otherwise personal row with `method = 'personal_fallback'`;
3. otherwise insufficient history.

The view exposes a usable P25 only after at least 4 sampled weeks and 10 features. Snapshot the selected row. Never hardcode a previous rate. `raw_items_per_hour` is informational only.

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

After counting the complete catalog, expand descriptions for all active rows and only relevant completed or archived evidence. Never load an unfiltered cross-project archive. Treat `tt_bugs.image_urls`, `tt_features.image_urls`, and `tt_test_items.image_paths` as private Storage paths. Generate short-lived signed URLs only for selected or seriously considered candidates and inspect every selected attachment.

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
- `B` = urgency buffer: 20% when `D > 15`, 10% when `6 <= D <= 15`, otherwise 0%;
- `P` = buffered daily hours = `G × (1 - B)`;
- `Q` = required daily pace = `R / D`.

Then:

- today's target = `min(G, max(P, Q))`;
- gross remaining capacity = `D × G`;
- overload/day = `max(0, Q - G)`;
- overload/week = overload/day × 5.

Feasibility:

- `on_track`: `Q <= P`;
- `at_risk`: `P < Q <= G`;
- `infeasible`: `Q > G`, deadline passed with work remaining, a mandatory dependency cannot fit, or a locked override makes delivery impossible;
- `incomplete`: codebase coverage is insufficient to make a reliable determination.

Use high estimates for capacity and show low/high totals. These calculations evaluate the deadline; they do not create a dated release roadmap.

## Daily snapshot shape

Merge the selected velocity row with:

```json
{
  "planning_mode": "daily_execution",
  "planning_date": "2026-07-27",
  "gross_daily_hours": 5,
  "target_hours": 5,
  "selected_hours": 4.75,
  "selected_count": 4,
  "candidate_count": 78,
  "candidate_counts": {
    "bug": 26,
    "feature": 6,
    "test_plan": 15,
    "todo": 0,
    "codebase_gap": 2
  },
  "selected_counts": {
    "bug": 3,
    "feature": 0,
    "test_plan": 0,
    "todo": 0,
    "codebase_gap": 0
  },
  "working_days_left": 26,
  "required_daily_hours": 10.63,
  "overload_hours_per_day": 5.63
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
- repository labels, HEAD SHAs, and dirty flags;
- complete tracker source counts;
- sorted daily selected stable keys, source ids, daily estimates, completion criteria, and dependencies;
- attachment storage paths for selected sources, never signed URLs;
- selected generated To-Do keys;
- preserved overrides.

Do not include prose, local paths, scan timestamps, unselected candidate ordering, or other presentation-only values.

## Copy-ready execution prompt

Do not persist a prompt blob on `tt_delivery_plan_items`. Productivitate builds it on demand from:

- the plan's brief, definition of done, deadline, summary, and repo snapshot;
- the selected plan item's action title, complete description snapshot, estimate, dependencies, and `scope_reason`;
- the current source title, status, priority, and full tracker description;
- private attachment storage paths resolved to new signed URLs at read time.

For an attachment-bearing source, the prompt must include both the stable Storage path and the temporary URL, say that every image must be inspected before editing, and explain how to regenerate an expired signed URL. For test plans, retain the owning test step in each attachment label.

`scope_reason` is the compact execution contract. It must contain why the item is selected now, an observable completion criterion, verified starting paths/symbols from the codebase, and the required tests or build checks. A copied prompt must still be actionable when the source has no attachments.

The final prompt instruction must update the owning tracker source only after the completion criterion and verification pass: bugs to `Fixed`, features and To-Dos to `Gata`, and test-plan results per executed step. If the tracker write fails, the execution is not fully complete and the exact error must be reported.

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
  scope_reason
)
VALUES
  (
    <new_plan_id>,
    '<stable_key>',
    '<bug_feature_test_plan_or_todo>',
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
    '<why_now_completion_criterion_code_starting_points_and_verification>'
  );

COMMIT;
```

On error, roll back the whole project. Never supersede the old plan outside this transaction.

## Focus integration

Focus derives **Plan azi** from the current plan:

1. require `planning_mode = daily_execution`;
2. require `planning_date` equal to today's Bucharest workday;
3. map sources to Focus card keys:
   - `bug:<id>`;
   - `feature:<id>`;
   - `todo:<id>`;
   - `test:<id>` for `source_type = test_plan`.

Do not change source statuses or create focus overlay rows merely to make a daily item visible. The approved plan-item membership is the queue filter.

## Pontaj linkage

After inserting a work log, link only explicit or unmistakable session items:

```sql
INSERT INTO public.tt_work_log_items (
  work_log_id,
  source_type,
  source_id,
  link_method,
  confidence
)
VALUES (<work_log_id>, '<source_type>', <source_id>, '<explicit_or_session_context>', 'high')
ON CONFLICT DO NOTHING;
```

The trigger rejects missing and cross-project sources. If no item clears high confidence, create no link and ask no extra question.
