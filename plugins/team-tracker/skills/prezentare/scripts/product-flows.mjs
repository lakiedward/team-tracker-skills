import { adapterFor, requireTestBoundary } from './adapters.mjs';

// Uses a Supabase service client supplied by the executing local agent. Passwords
// stay in memory and are never returned in the receipt or logged by this helper.
export async function ensureAccount({ admin, presentationId, resourceKey, email, password, name }) {
  if (!/^[\da-f-]{36}$/i.test(presentationId) || !resourceKey || !email || !password || password.length < 16) throw Error('account_input_required');
  const ownership = `${presentationId}:${resourceKey}`;
  const normalizedEmail = email.trim().toLowerCase();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 }).catch(() => { throw Error('account_inspection_failed'); });
    if (error) throw Error('account_inspection_failed');
    const existing = data.users.find(user => user.email?.toLowerCase() === normalizedEmail);
    if (existing) {
      if (existing.app_metadata?.tt_presentation_owner !== ownership) throw Error('foreign_account_collision');
      return { external_id: existing.id, ownership: 'created', state: 'ready', proof: 'auth_account_only' };
    }
    if (data.users.length < 1000) break;
  }
  const { data, error } = await admin.auth.admin.createUser({ email: normalizedEmail, password, email_confirm: true, user_metadata: { name }, app_metadata: { tt_presentation_owner: ownership } }).catch(() => { throw Error('account_create_unconfirmed_retry_inspect'); });
  if (error || !data?.user?.id) throw Error('account_create_unconfirmed_retry_inspect');
  return { external_id: data.user.id, ownership: 'created', state: 'ready', proof: 'auth_account_only' };
}

export function productOperation(input) {
  const a = adapterFor(input.adapter);
  if (Number(input.projectId) !== a.projectId) throw Error('project_adapter_mismatch');
  const common = { projectRef: a.ref, proof: 'execute_then_verify', reset: 'product_flow_only' };
  if (a.key === 'betora' && input.operation === 'manual_premium') {
    if (!/^[\da-f-]{36}$/i.test(input.accountId || '') || !input.dedicatedAccountIds?.includes(input.accountId)) throw Error('dedicated_account_required');
    return { ...common, kind: 'edge_function', name: 'admin-grant-premium', body: { targetUserId: input.accountId, action: 'grant' }, authentication: 'authenticated_product_admin', readBack: ['users.subscription', 'subscriptions.subscription_source', 'subscriptions.manual_premium_until'], warning: 'Do not replace existing real Stripe customer/subscription bindings.' };
  }
  if (a.key === 'betora' && input.operation === 'ticket') return { ...common, kind: 'browser', steps: ['Authenticate dedicated account.', 'Read fresh real matches and bookmaker odds; refuse stale or started matches.', 'Build and save a ticket through the existing ticket UI/service.', 'Record returned ticket id, user_id and selections; verify the saved ticket UI.'], recordInTracker: 'created product row; never reset by raw DELETE; use delete_or_hide_ticket under this user.' };
  if (a.key === 'culcush' && input.operation === 'cart') return { ...common, kind: 'browser', steps: ['Authenticate dedicated customer.', 'Select published products, variants and colors with live stock.', 'Add to the cart in this browser.', 'Read cart UI and totals; cart is browser storage, not a database table.'] };
  if ((a.key === 'culcush' && input.operation === 'checkout') || (a.key === 'motion' && input.operation === 'payment')) {
    requireTestBoundary(input.testEvidence, input.now);
    return { ...common, kind: 'browser', steps: a.key === 'culcush' ? ['Inspect currently deployed checkout and Stripe TEST configuration; use dedicated test recipients.', 'Submit existing checkout with server price/stock confirmation and its current idempotency contract.', 'Complete Stripe TEST flow.', 'Read order and webhook-backed payment_status; record returned order/payment identifiers.'] : ['Use the existing create-enrollment/payment flow for the dedicated parent and child.', 'Complete Stripe TEST card / 3DS / Google Pay only on supported device.', 'Read authoritative payment and enrollment state after webhook completion.'], externalEffects: 'verified_test_only', reset: 'Never delete payment, order or enrollment rows to undo an external operation.' };
  }
  if (a.key === 'motion' && ['enrollment', 'attendance', 'club_course', 'club_camp'].includes(input.operation)) {
    // Current live triggers enqueue notifications; a public club can have real followers.
    requireTestBoundary(input.testEvidence, input.now);
    return { ...common, kind: 'browser', steps: ['Read current account roles, resource ownership and all notification recipients; test-only recipients are mandatory.', `Execute ${input.operation} in the existing product UI and existing domain API.`, 'Capture exact resulting IDs under the dedicated account and register them before continuing.', 'Verify with a fresh query and the affected role UI; any device-only action remains open without that device.'], externalEffects: 'verified_test_only' };
  }
  return { ...common, kind: 'manual', blocked: true, reason: 'unsupported_capability', operation: input.operation };
}
