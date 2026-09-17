// SQL descriptors for Supabase MCP. No network, credentials, or persistent secrets here.
import { prepare, reset, adapterFor } from './adapters.mjs';
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const literal = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : typeof value === 'object' ? `${quote(JSON.stringify(value))}::jsonb` : quote(value);
export const TRACKER_REF = 'ntjzghsbrzkvpkniotaj';
const contracts = {
  tt_demo_start: ['p_presentation_id', 'p_kind', 'p_expected_revision', 'p_idempotency_key'],
  tt_demo_record: ['p_run_id', 'p_results', 'p_summary', 'p_status', 'p_expected_results'],
  tt_demo_resource_save: ['p_run_id', 'p_resource'],
  tt_presentation_regenerate: ['p_presentation_id', 'p_expected_revision', 'p_changes', 'p_steps'],
};
export function trackerRpc(name, args) {
  const fields = contracts[name];
  if (!fields || Object.keys(args).some(key => !fields.includes(key)) || fields.some(key => !(key in args))) throw Error('invalid_tracker_contract');
  return { projectRef: TRACKER_REF, sql: `BEGIN; SET LOCAL ROLE service_role; SELECT public.${name}(${fields.map(key => `${key} => ${literal(args[key])}`).join(',')}); COMMIT;` };
}

export async function executePreparation(input, transport) {
  // Transport adapters execute one descriptor and return parsed database rows.
  // Keeping the intent before the source transaction closes the cross-database retry gap.
  const operation = prepare(input);
  const existing = await transport.readResource(input.presentationId, input.resourceKey);
  if (!existing) await transport.tracker(trackerRpc('tt_demo_resource_save', { p_run_id: input.runId, p_resource: operation.resource }));
  else if (existing.ownership !== 'created' || existing.resource_type !== operation.resource.resource_type || existing.owner_ref !== input.ownerId || (existing.external_id && existing.external_id !== operation.externalId)) throw Error('tracker_resource_conflict');
  const rows = await transport.source(operation);
  const receipt = rows.find(row => row.resource_key === input.resourceKey);
  if (!receipt || receipt.state !== 'ready' || receipt.ownership !== 'created' || !receipt.fingerprint) throw Error('source_receipt_missing');
  const ready = { ...operation.resource, external_id: operation.externalId, state: 'ready', fingerprint: receipt.fingerprint };
  await transport.tracker(trackerRpc('tt_demo_resource_save', { p_run_id: input.runId, p_resource: ready }));
  return ready;
}

export async function executeReset(input, transport) {
  const existing = await transport.readResource(input.presentationId, input.resourceKey);
  if (!existing || existing.ownership !== 'created' || existing.owner_ref !== input.ownerId) throw Error('owned_tracker_resource_required');
  const operation = reset({ ...input, expectedFingerprint: existing.fingerprint });
  const rows = await transport.source(operation);
  const receipt = rows.find(row => row.resource_key === input.resourceKey);
  if (!receipt || receipt.state !== 'reset') throw Error('source_reset_unconfirmed');
  const resource = { resource_key: existing.resource_key, resource_type: existing.resource_type, external_id: existing.external_id, ownership: existing.ownership, owner_ref: existing.owner_ref, fingerprint: existing.fingerprint, state: 'reset', metadata: { ...existing.metadata, foreign_dependencies: false, reset_verification: `source_receipt:${receipt.fingerprint}` } };
  await transport.tracker(trackerRpc('tt_demo_resource_save', { p_run_id: input.runId, p_resource: resource }));
  return resource;
}

export function contextQueries({ adapter, presentationId }) {
  const a = adapterFor(adapter);
  if (!/^[\da-f-]{36}$/i.test(presentationId)) throw Error('invalid_presentation_id');
  return [
    { projectRef: TRACKER_REF, sql: `SELECT id,project_id,audience_id,baseline_at,revision,status,document FROM public.tt_presentations WHERE id=${quote(presentationId)}::uuid AND project_id=${a.projectId};` },
    { projectRef: TRACKER_REF, sql: `SELECT launch_stage FROM public.tt_delivery_profiles WHERE project_id=${a.projectId};` },
    { projectRef: TRACKER_REF, sql: `SELECT r.* FROM public.tt_demo_resources r WHERE presentation_id=${quote(presentationId)}::uuid;` },
  ];
}
