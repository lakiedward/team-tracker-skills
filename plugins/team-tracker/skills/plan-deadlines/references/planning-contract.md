# Planning contract

Read this reference before querying or writing delivery-planning data.

## Tables and ownership

- `tt_delivery_profiles`: human-owned project configuration. The Productivitate page is the normal writer.
- `tt_delivery_plans`: approved immutable planning snapshots, except `status` when superseded.
- `tt_delivery_plan_items`: approved source-item schedule. Manual override columns are human-owned.
- `tt_work_log_items`: high-confidence links from a Pontaj row to a tracker source.
- `tt_todos.origin`: `manual` or `deadline_skill`.
- `tt_todos.planning_key`: stable UUID for idempotent generated To-Dos.
- `tt_project_velocity`: `security_invoker` view over a rolling 90-day window.

Never store repository paths, source contents, credentials, environment variables, or raw prompts in these tables.

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

An enabled profile is valid only when the brief and definition are non-empty and deadline, owner, and positive weekly capacity are present.

## Read velocity and choose fallback

```sql
SELECT *
FROM public.tt_project_velocity
WHERE project_id = <project_id> OR scope = 'personal'
ORDER BY scope;
```

Selection:

1. use the project row when `method IN ('direct', 'weekly')`;
2. otherwise use the personal row when `method = 'personal_fallback'`;
3. otherwise report insufficient history.

The view already enforces the minimum 4 sampled weeks and 10 features before exposing a usable P25. Snapshot the exact row used. Do not hardcode a rate from a previous run.

`raw_items_per_hour` is informational only.

## Read the complete source backlog

First read a lightweight project-scoped catalog without a status or archive filter. Paginate rather than truncating when the client imposes a row limit. This catalog is the proof that every bug, feature, and To-Do was considered before scope selection.

```sql
SELECT id, title, status, priority, effort, focus_task_id, is_archived, updated_at
FROM public.tt_features
WHERE project_id = <project_id>
ORDER BY id;

SELECT id, title, status, priority, effort, focus_task_id, is_archived, updated_at
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

After counting the full catalog, expand `description` and other heavy fields for every active row and for the specific completed/archived rows that may prove a definition-of-done outcome. Keep every expansion project-scoped and query selected archived IDs explicitly. Never load the unfiltered cross-project archive.

## Read current plan and overrides

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

For the diff, compare stable keys. A locked override remains authoritative even when a new static estimate or schedule differs. The insert trigger also carries the latest locked values into a new plan item with the same stable key.

## Planning calculations

Let:

- `W` = manually assigned weekly hours;
- `D` = working days from today through deadline, inclusive;
- `B` = `0.20`;
- `R` = total remaining high-estimate hours.

Then:

- gross daily capacity = `W / 5`;
- usable daily capacity = `(W / 5) × (1 - B)`;
- gross available hours = `D × W / 5`;
- buffered available hours = `D × W / 5 × 0.80`;
- shortfall = `max(0, R - buffered available hours)`;
- required weekly capacity = `R / (D / 5 × 0.80)`;
- average extra hours/week = `max(0, required weekly capacity - W)`.

For the first realistic deadline, start today and consume only Monday–Friday slots of `W / 5 × 0.80` until `R` reaches zero. Respect dependencies and locked dates while consuming slots.

Feasibility:

- `on_track`: `R <= buffered available hours`;
- `at_risk`: buffered capacity is insufficient but `R <= gross available hours`;
- `infeasible`: `R > gross available hours`, deadline is past with remaining work, dependency ordering crosses the deadline, or a locked override makes the schedule impossible.

Use high estimates for feasibility. Show both low and high totals.

## Proposal hash

Compute SHA-256 over canonical JSON with sorted keys containing:

- project id;
- profile `updated_at` and all profile values;
- previous current plan id/version;
- selected velocity snapshot;
- sorted repository labels + HEAD SHAs + dirty flags;
- sorted item stable keys, sources, estimates, dependencies, phases, and planned dates;
- sorted generated To-Do planning keys;
- preserved overrides.

Do not include presentation text, absolute paths, timestamps generated by the scan, or array order that has no semantic meaning.

## Transactional apply sequence

Use one transaction per project. Substitute only the already displayed and approved values. Escape every text literal safely.

```sql
BEGIN;

-- Serialize against profile edits and competing plan writers.
SELECT *
FROM public.tt_delivery_profiles
WHERE project_id = <project_id>
FOR UPDATE;

SELECT *
FROM public.tt_delivery_plans
WHERE project_id = <project_id> AND status = 'current'
FOR UPDATE;

-- Idempotent retry guard. If this returns a row, ROLLBACK and report it already applied.
SELECT id, version, status
FROM public.tt_delivery_plans
WHERE project_id = <project_id>
  AND proposal_hash = '<sha256>';

-- Repeat for each approved gap. Never set status here: preserve human progress.
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
  '<on_track_or_at_risk>',
  '<brief>',
  '<definition_of_done>',
  '<deadline>',
  <owner_member_id>,
  '<owner_name>',
  <weekly_capacity_hours>,
  20,
  <total_high_hours>,
  <remaining_high_hours>,
  <buffered_available_hours>,
  <rate_or_null>,
  <hours_per_feature_or_null>,
  '<direct_weekly_or_personal_fallback>',
  '<high_medium_or_low>',
  '<velocity_json>'::jsonb,
  '<full_tracker_only_or_incomplete>',
  '<repo_state_json_without_paths>'::jsonb,
  '<risks_json>'::jsonb,
  '<assumptions_json>'::jsonb,
  '[]'::jsonb,
  '<summary>'
)
RETURNING id, version;

-- Insert every approved item using the returned plan id. Generated To-Dos use the ids returned above.
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
    '<title>',
    '<description>',
    '<phase>',
    <sequence>,
    '<planned_due_date>',
    <low_hours>,
    <high_hours>,
    '<confidence>',
    ARRAY['<dependency_stable_key>']::text[],
    true,
    '<scope_reason>'
  );

COMMIT;
```

If any validation or write fails, issue `ROLLBACK`. Do not mark the old plan superseded outside this transaction.

## Pontaj linkage contract

After creating a work-log row, link only explicit or unmistakable session items:

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

The DB trigger rejects a missing source or a source from a different project. If no item clears the high-confidence threshold, create no link and ask no extra question.
