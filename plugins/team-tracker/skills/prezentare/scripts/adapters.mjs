import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync(new URL('../../orchestrate/projects.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const sql = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${sql(JSON.stringify(value))}::jsonb`;
const uuid = value => {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value || '')) throw Error('invalid_uuid');
  return value.toLowerCase();
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dollarTag = input => {
  const serialized = JSON.stringify(input);
  let suffix = 0;
  while (serialized.includes(`$tt_demo_${suffix}$`)) suffix++;
  return `$tt_demo_${suffix}$`;
};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const DEFINITIONS = {
  motion: { registry: 'motiontimisoara', ref: 'ehdzafadshbaaghzdzdo', accountTable: 'profiles', tables: {
    children: { owner: 'parent_id', role: 'PARENT', fields: ['name', 'birth_date', 'level'], required: ['name', 'birth_date'] },
    clubs: { owner: 'owner_user_id', role: 'CLUB', fields: ['name', 'description', 'city'], required: ['name'] },
    courses: { owner: 'coach_id', role: 'COACH', fields: ['name', 'sport_id', 'location_id', 'description', 'capacity', 'age_from', 'age_to'], required: ['name', 'sport_id', 'location_id'], defaults: { club_id: null, price: 0, price_per_session: 0, currency: 'RON', active: true } },
    camps: { owner: 'coach_id', role: 'COACH', fields: ['title', 'slug', 'period_start', 'period_end', 'location_text', 'description', 'capacity'], required: ['title', 'slug', 'period_start', 'period_end'], defaults: { club_id: null, price: 0, currency: 'RON', allow_cash: false } },
  } },
};

export function adapterFor(name) {
  const key = name === 'motiontimisoara' ? 'motion' : name;
  const definition = Object.hasOwn(DEFINITIONS, key) ? DEFINITIONS[key] : null;
  if (!definition) throw Error('unsupported_adapter');
  return { key, ...definition, projectId: registry[definition.registry].project_id, repoPath: registry[definition.registry].repo_path };
}

export function stableResourceId(adapter, presentationId, resourceKey) {
  const hex = digest([adapter, uuid(presentationId), resourceKey]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function context(input) {
  const adapter = adapterFor(input.adapter);
  if (Number(input.projectId) !== adapter.projectId) throw Error('project_adapter_mismatch');
  const presentationId = uuid(input.presentationId), runId = uuid(input.runId), ownerId = uuid(input.ownerId);
  if (!input.dedicatedAccountIds?.map(uuid).includes(ownerId)) throw Error('dedicated_account_required');
  if (typeof input.resourceKey !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(input.resourceKey)) throw Error('invalid_resource_key');
  const table = input.table, schema = Object.hasOwn(adapter.tables, table) ? adapter.tables[table] : null;
  if (!schema) throw Error('unsupported_resource_use_product_flow');
  return { adapter, presentationId, runId, ownerId, table, schema, resourceKey: input.resourceKey };
}

function recordQuery(c) {
  return `adapter=${sql(c.adapter.key)} AND presentation_id=${sql(c.presentationId)}::uuid AND resource_key=${sql(c.resourceKey)}`;
}

function ownerCheck(c) {
  return `IF NOT EXISTS (SELECT 1 FROM public.${c.adapter.accountTable} WHERE id=${sql(c.ownerId)}::uuid${c.schema.role ? ` AND role=${sql(c.schema.role)}` : ''}) THEN RAISE EXCEPTION 'owner_role_missing'; END IF;`;
}

export function inspect(input) {
  const a = adapterFor(input.adapter);
  const tables = [...Object.keys(a.tables), a.accountTable, 'enrollments', 'attendance', 'camp_coaches'];
  return { projectId: a.projectId, projectRef: a.ref, repoPath: a.repoPath, sql: [
    `SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name IN (${tables.map(sql).join(',')}) ORDER BY table_name,ordinal_position;`,
    `SELECT event_object_table,trigger_name,action_statement FROM information_schema.triggers WHERE event_object_schema='public' AND event_object_table IN (${tables.map(sql).join(',')});`,
    `SELECT to_regclass('public.tt_demo_source_receipts') IS NOT NULL AS receipts_installed;`,
  ], capabilities: { database: Object.keys(a.tables), productFlows: ['accounts', 'club_courses', 'club_camps', 'enrollment', 'attendance', 'stripe_test', 'android'], proof: 'configuration_and_rows_only' } };
}

export function prepare(input) {
  const c = context(input), payload = input.payload || {};
  for (const key of Object.keys(payload)) if (!c.schema.fields.includes(key)) throw Error(`unsupported_field:${key}`);
  for (const key of c.schema.required) if (payload[key] === undefined || payload[key] === null || payload[key] === '') throw Error(`required_field:${key}`);
  const identity = { id: stableResourceId(c.adapter.key, c.presentationId, c.resourceKey) };
  const row = canonical({ ...c.schema.defaults, ...payload, ...identity, [c.schema.owner]: c.ownerId });
  const requestHash = digest(row);
  const tag = dollarTag(input);
  const statement = `DO ${tag}
DECLARE r public.tt_demo_source_receipts%ROWTYPE; current_row jsonb; initial_fingerprint text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(${sql(`${c.adapter.key}:${c.presentationId}:${c.resourceKey}`)},0));
  ${ownerCheck(c)}
  SELECT * INTO r FROM public.tt_demo_source_receipts WHERE ${recordQuery(c)} FOR UPDATE;
  IF FOUND THEN
    IF r.ownership <> 'created' OR r.owner_id <> ${sql(c.ownerId)}::uuid OR r.resource_table <> ${sql(c.table)} OR r.identity <> ${json(identity)} OR r.request_hash <> ${sql(requestHash)} THEN RAISE EXCEPTION 'resource_definition_changed'; END IF;
    IF r.state = 'ready' THEN
      SELECT to_jsonb(t) INTO current_row FROM public.${c.table} t WHERE to_jsonb(t) @> r.identity FOR UPDATE;
      IF current_row IS NULL THEN RAISE EXCEPTION 'resource_missing_requires_reset'; END IF;
      IF md5(current_row::text) <> r.fingerprint THEN RAISE EXCEPTION 'resource_changed'; END IF;
      RETURN;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.${c.table} t WHERE to_jsonb(t) @> ${json(identity)}) THEN RAISE EXCEPTION 'foreign_resource_collision'; END IF;
  INSERT INTO public.${c.table} (${Object.keys(row).map(k => `"${k}"`).join(',')})
    SELECT ${Object.keys(row).map(k => `x."${k}"`).join(',')} FROM jsonb_populate_record(NULL::public.${c.table},${json(row)}) x;
  SELECT md5(to_jsonb(t)::text) INTO initial_fingerprint FROM public.${c.table} t WHERE to_jsonb(t) @> ${json(identity)};
  INSERT INTO public.tt_demo_source_receipts(adapter,presentation_id,resource_key,run_id,resource_table,identity,owner_id,ownership,request_hash,fingerprint,state)
    VALUES (${sql(c.adapter.key)},${sql(c.presentationId)}::uuid,${sql(c.resourceKey)},${sql(c.runId)}::uuid,${sql(c.table)},${json(identity)},${sql(c.ownerId)}::uuid,'created',${sql(requestHash)},initial_fingerprint,'ready')
    ON CONFLICT (adapter,presentation_id,resource_key) DO UPDATE SET run_id=excluded.run_id,fingerprint=excluded.fingerprint,state='ready',updated_at=now();
END ${tag};
SELECT resource_key,resource_table,identity,ownership,fingerprint,state FROM public.tt_demo_source_receipts WHERE ${recordQuery(c)};`;
  return { projectRef: c.adapter.ref, sql: statement, externalId: identity.id, resource: { resource_key: c.resourceKey, resource_type: `${c.adapter.key}.${c.table}`, external_id: '', ownership: 'created', state: 'intent', owner_ref: c.ownerId, fingerprint: '', metadata: { adapter: c.adapter.key, identity, proof: 'populated_state' } } };
}

export function verify(input) {
  const c = context(input);
  return { projectRef: c.adapter.ref, sql: `SELECT r.resource_key,r.identity,r.ownership,r.state,CASE WHEN t.row IS NULL THEN 'missing' WHEN md5(t.row::text)=r.fingerprint THEN 'unchanged' ELSE 'changed' END AS verification,r.fingerprint FROM public.tt_demo_source_receipts r LEFT JOIN LATERAL (SELECT to_jsonb(s) AS row FROM public.${c.table} s WHERE to_jsonb(s) @> r.identity) t ON true WHERE ${recordQuery(c)} AND r.resource_table=${sql(c.table)} AND r.owner_id=${sql(c.ownerId)}::uuid;`, proof: 'rows_only_not_end_to_end' };
}

export function reset(input) {
  const c = context(input);
  if (!/^[\da-f]{32}$/.test(input.expectedFingerprint || '')) throw Error('verified_fingerprint_required');
  // Refuse every FK dependant, including owned children: reset leaf resources first.
  // This also prevents ON DELETE CASCADE/SET NULL from affecting another user's rows.
  const polymorphicCheck = ['courses', 'camps'].includes(c.table) ? `LOCK TABLE public.enrollments IN SHARE MODE;
  IF EXISTS (SELECT 1 FROM public.enrollments WHERE entity_id=(r.identity->>'id')::uuid) THEN RAISE EXCEPTION 'resource_has_enrollments'; END IF;
  IF to_regclass('private.push_events') IS NOT NULL THEN
    LOCK TABLE private.push_events IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM private.push_events WHERE source_id=(r.identity->>'id')::uuid AND source_type=${sql(c.table === 'camps' ? 'camp' : 'course')}) THEN RAISE EXCEPTION 'resource_has_notification_history'; END IF;
  END IF;` : '';
  const tag = dollarTag(input);
  return { projectRef: c.adapter.ref, sql: `DO ${tag}
DECLARE r public.tt_demo_source_receipts%ROWTYPE; current_row jsonb; dependency record; predicate text; has_dependents boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(${sql(`${c.adapter.key}:${c.presentationId}:${c.resourceKey}`)},0));
  SELECT * INTO r FROM public.tt_demo_source_receipts WHERE ${recordQuery(c)} FOR UPDATE;
  IF NOT FOUND OR r.ownership <> 'created' OR r.owner_id <> ${sql(c.ownerId)}::uuid OR r.resource_table <> ${sql(c.table)} THEN RAISE EXCEPTION 'owned_receipt_required'; END IF;
  IF r.state='reset' THEN
    IF EXISTS (SELECT 1 FROM public.${c.table} t WHERE to_jsonb(t) @> r.identity) THEN RAISE EXCEPTION 'resource_reappeared'; END IF;
    RETURN;
  END IF;
  IF r.fingerprint <> ${sql(input.expectedFingerprint)} THEN RAISE EXCEPTION 'stale_resource_receipt'; END IF;
  SELECT to_jsonb(t) INTO current_row FROM public.${c.table} t WHERE to_jsonb(t) @> r.identity FOR UPDATE;
  IF current_row IS NULL OR md5(current_row::text) <> r.fingerprint THEN RAISE EXCEPTION 'resource_changed'; END IF;
  ${polymorphicCheck}
  FOR dependency IN SELECT conrelid,conkey,confkey FROM pg_constraint WHERE contype='f' AND confrelid='public.${c.table}'::regclass LOOP
    EXECUTE format('LOCK TABLE %s IN SHARE MODE',dependency.conrelid::regclass);
    SELECT string_agg(format('to_jsonb(d)->%L = $1->%L',a.attname,b.attname),' AND ') INTO predicate
      FROM unnest(dependency.conkey,dependency.confkey) keys(local_key,foreign_key)
      JOIN pg_attribute a ON a.attrelid=dependency.conrelid AND a.attnum=keys.local_key
      JOIN pg_attribute b ON b.attrelid='public.${c.table}'::regclass AND b.attnum=keys.foreign_key;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s d WHERE %s)',dependency.conrelid::regclass,predicate) INTO has_dependents USING current_row;
    IF has_dependents THEN RAISE EXCEPTION 'resource_has_dependents'; END IF;
  END LOOP;
  DELETE FROM public.${c.table} t WHERE to_jsonb(t) @> r.identity;
  UPDATE public.tt_demo_source_receipts SET state='reset',run_id=${sql(c.runId)}::uuid,updated_at=now() WHERE ${recordQuery(c)};
END ${tag};
SELECT resource_key,resource_table,identity,ownership,fingerprint,state FROM public.tt_demo_source_receipts WHERE ${recordQuery(c)};` };
}

export function requireTestBoundary(evidence, now = Date.now()) {
  if (!evidence || evidence.mode !== 'test' || evidence.livemode !== false || evidence.recipients !== 'test_only' || !evidence.providerReference || !Number.isFinite(Date.parse(evidence.verifiedAt)) || now-Date.parse(evidence.verifiedAt) < 0 || now-Date.parse(evidence.verifiedAt) > 60*60*1000) throw Error('verified_test_boundary_required');
}
