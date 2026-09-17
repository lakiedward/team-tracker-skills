import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inspect, prepare, verify, reset, stableResourceId, requireTestBoundary } from './adapters.mjs';
import { executePreparation } from './transport.mjs';
import { ensureAccount, productOperation } from './product-flows.mjs';

const registry = JSON.parse(readFileSync(new URL('../../orchestrate/projects.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const requireFromApp = createRequire(`${process.env.TT_APP_REPO || registry.team_tracker.repo_path}/package.json`);
const { PGlite } = await import(pathToFileURL(requireFromApp.resolve('@electric-sql/pglite')).href);
const P = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OWNER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const base = { adapter: 'motion', projectId: 16, presentationId: P, runId: RUN, ownerId: OWNER, dedicatedAccountIds: [OWNER], resourceKey: 'child-1', table: 'children', payload: { name: 'Alex', birth_date: '2017-06-12' } };
async function database() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE agent_sql BYPASSRLS;
    CREATE TABLE profiles(id uuid PRIMARY KEY,role text); INSERT INTO profiles VALUES ('${OWNER}','PARENT'),('${OTHER}','COACH');
    CREATE TABLE children(id uuid PRIMARY KEY,parent_id uuid REFERENCES profiles(id),name text NOT NULL,birth_date date NOT NULL,level text,created_at timestamptz DEFAULT now());
    CREATE TABLE addresses(id uuid PRIMARY KEY,user_id uuid REFERENCES profiles(id),name text NOT NULL,details text[] NOT NULL,type text,is_default boolean,created_at timestamptz DEFAULT now());
    CREATE TABLE users(id uuid PRIMARY KEY); INSERT INTO users VALUES ('${OWNER}');
    CREATE TABLE matches(id text PRIMARY KEY,provider_fixture_id text,start_time timestamptz,odds_stale boolean);
    CREATE TABLE api_odds(match_id text,updated_at timestamptz);
    CREATE TABLE user_favorites(user_id uuid REFERENCES users(id),match_id text REFERENCES matches(id),created_at timestamptz DEFAULT now(),PRIMARY KEY(user_id,match_id));`);
  await db.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO agent_sql;`);
  await db.exec(readFileSync(new URL('./source-receipts.sql', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  return db;
}
async function run(db, descriptor) {
  const results = await db.exec(descriptor.sql);
  return results.at(-1).rows;
}

test('repeat prepare including a new run reconciles the same atomic receipt', async () => {
  const db = await database();
  try {
    const first = await run(db, prepare(base));
    const second = await run(db, prepare({ ...base, runId: OTHER }));
    assert.deepEqual(first, second);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM children')).rows[0].count, 1);
    assert.equal((await run(db, verify(base)))[0].verification, 'unchanged');
  } finally { await db.close(); }
});

test('source transaction rolls back the row when receipt write fails', async () => {
  const db = await database();
  try {
    await db.exec("ALTER TABLE tt_demo_source_receipts ADD CONSTRAINT force_failure CHECK (resource_key <> 'child-1')");
    await assert.rejects(() => run(db, prepare(base)), /force_failure/);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM children')).rows[0].count, 0);
    await db.exec('ALTER TABLE tt_demo_source_receipts DROP CONSTRAINT force_failure');
    assert.equal((await run(db, prepare(base)))[0].state, 'ready');
  } finally { await db.close(); }
});

test('lost tracker acknowledgement can retry after source commit without duplication', async () => {
  const db = await database();
  try {
    let failAck = true;
    const transport = { readResource: async () => null, source: operation => run(db, operation), tracker: async operation => {
      if (operation.sql.includes('"state":"ready"') && failAck) { failAck = false; throw Error('lost_ack'); }
    } };
    await assert.rejects(() => executePreparation(base, transport), /lost_ack/);
    const receipt = await executePreparation(base, transport);
    assert.equal(receipt.state, 'ready');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM children')).rows[0].count, 1);
  } finally { await db.close(); }
});

test('foreign collision and changed resource definition never gain ownership', async () => {
  const db = await database();
  try {
    const id = stableResourceId('motion', P, 'child-1');
    await db.exec(`INSERT INTO children(id,parent_id,name,birth_date) VALUES('${id}','${OWNER}','Someone else','2017-01-01')`);
    await assert.rejects(() => run(db, prepare(base)), /foreign_resource_collision/);
    await db.exec('DELETE FROM children');
    await run(db, prepare(base));
    await assert.rejects(() => run(db, prepare({ ...base, payload: { ...base.payload, name: 'Different' } })), /resource_definition_changed/);
  } finally { await db.close(); }
});

test('reset is idempotent and reprepare restores only its original owned fixture', async () => {
  const db = await database();
  try {
    const receipt = (await run(db, prepare(base)))[0];
    const operation = reset({ ...base, expectedFingerprint: receipt.fingerprint });
    await run(db, operation); await run(db, operation);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM children')).rows[0].count, 0);
    assert.equal((await run(db, prepare(base)))[0].state, 'ready');
  } finally { await db.close(); }
});

test('reset refuses edits, stale fingerprints, other owners and other presentations', async () => {
  const db = await database();
  try {
    const receipt = (await run(db, prepare(base)))[0];
    await assert.rejects(() => run(db, reset({ ...base, expectedFingerprint: '0'.repeat(32) })), /stale_resource_receipt/);
    await assert.rejects(() => run(db, reset({ ...base, ownerId: OTHER, dedicatedAccountIds: [OTHER], expectedFingerprint: receipt.fingerprint })), /owned_receipt_required/);
    await assert.rejects(() => run(db, reset({ ...base, presentationId: OTHER, expectedFingerprint: receipt.fingerprint })), /owned_receipt_required/);
    await db.exec("UPDATE children SET name='Changed by someone'");
    await assert.rejects(() => run(db, reset({ ...base, expectedFingerprint: receipt.fingerprint })), /resource_changed/);
    await assert.rejects(() => run(db, prepare(base)), /resource_changed/);
  } finally { await db.close(); }
});

test('reset prevents foreign cascade through FK dependencies', async () => {
  const db = await database();
  try {
    const receipt = (await run(db, prepare(base)))[0];
    await db.exec(`CREATE TABLE foreign_activity(id int, child_id uuid REFERENCES children(id) ON DELETE CASCADE);
      INSERT INTO foreign_activity VALUES(1,'${stableResourceId('motion',P,'child-1')}');`);
    await assert.rejects(() => run(db, reset({ ...base, expectedFingerprint: receipt.fingerprint })), /resource_has_dependents/);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM foreign_activity')).rows[0].count, 1);
  } finally { await db.close(); }
});

test('Motion reset locks and rejects polymorphic enrollments and notification history', async () => {
  const db = await database();
  try {
    await db.exec(`CREATE TABLE camps(id uuid PRIMARY KEY,coach_id uuid REFERENCES profiles(id),title text NOT NULL,slug text UNIQUE NOT NULL,period_start date,period_end date,location_text text,description text,capacity int,club_id uuid,price bigint,currency text,allow_cash boolean);
      CREATE TABLE enrollments(id uuid,entity_id uuid);
      CREATE SCHEMA private; CREATE TABLE private.push_events(source_type text,source_id uuid);`);
    const input = { ...base, ownerId: OTHER, dedicatedAccountIds: [OTHER], table: 'camps', resourceKey: 'camp', payload: { title: 'Sport de toamnă', slug: 'sport-toamna', period_start: '2026-10-01', period_end: '2026-10-03' } };
    const receipt = (await run(db, prepare(input)))[0];
    const operation = reset({ ...input, expectedFingerprint: receipt.fingerprint });
    assert.ok(operation.sql.indexOf('LOCK TABLE public.enrollments IN SHARE MODE') < operation.sql.indexOf("RAISE EXCEPTION 'resource_has_enrollments'"));
    const id = stableResourceId('motion', P, 'camp');
    await db.exec(`INSERT INTO enrollments VALUES('${RUN}','${id}')`);
    await assert.rejects(() => run(db, operation), /resource_has_enrollments/);
    await db.exec(`DELETE FROM enrollments; INSERT INTO private.push_events VALUES('camp','${id}')`);
    await assert.rejects(() => run(db, operation), /resource_has_notification_history/);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM camps')).rows[0].count, 1);
    await db.exec('DELETE FROM private.push_events');
    assert.equal((await run(db, operation))[0].state, 'reset');
  } finally { await db.close(); }
});

test('Culcush addresses preserve text-array shape and never modify default address', async () => {
  const db = await database();
  try {
    const input = { ...base, adapter: 'culcush', projectId: 7, table: 'addresses', resourceKey: 'address', payload: { name: 'Strada Florilor 10', details: ['Timișoara', 'Timiș', '300001'] } };
    await run(db, prepare(input));
    const row = (await db.query('SELECT details,is_default FROM addresses')).rows[0];
    assert.deepEqual(row.details, input.payload.details); assert.equal(row.is_default, false);
    await run(db, prepare(input));
    assert.equal((await db.query('SELECT count(*)::int AS count FROM addresses')).rows[0].count, 1);
  } finally { await db.close(); }
});

test('SQL preserves hostile quoted text and dollar delimiters as ordinary data', async () => {
  const db = await database();
  try {
    const name = "Alex'; DROP TABLE children; -- $demo$ $tt_demo_0$ $tt_demo_1$";
    await run(db, prepare({ ...base, payload: { ...base.payload, name } }));
    assert.equal((await db.query('SELECT name FROM children')).rows[0].name, name);
  } finally { await db.close(); }
});

test('Betora refuses fabricated/started/stale matches and prepares real fresh favorites', async () => {
  const db = await database();
  try {
    const input = { ...base, adapter: 'betora', projectId: 1, table: 'user_favorites', resourceKey: 'favorite', payload: { match_id: '1234' } };
    await assert.rejects(() => run(db, prepare(input)), /match_or_odds_not_fresh/);
    await db.exec("INSERT INTO matches VALUES('1234','provider-1234',now()+interval '1 day',false); INSERT INTO api_odds VALUES('1234',now()-interval '1 day')");
    await assert.rejects(() => run(db, prepare(input)), /match_or_odds_not_fresh/);
    await db.exec('UPDATE api_odds SET updated_at=now()');
    const receipt = (await run(db, prepare(input)))[0];
    await run(db, prepare(input));
    await run(db, reset({ ...input, expectedFingerprint: receipt.fingerprint }));
    assert.equal((await db.query('SELECT count(*)::int AS count FROM matches')).rows[0].count, 1);
  } finally { await db.close(); }
});

test('lost reset acknowledgement never adopts or deletes a favorite recreated afterward', async () => {
  const db = await database();
  try {
    await db.exec("INSERT INTO matches VALUES('1234','provider-1234',now()+interval '1 day',false); INSERT INTO api_odds VALUES('1234',now())");
    const input = { ...base, adapter: 'betora', projectId: 1, table: 'user_favorites', resourceKey: 'favorite', payload: { match_id: '1234' } };
    const receipt = (await run(db, prepare(input)))[0];
    const operation = reset({ ...input, expectedFingerprint: receipt.fingerprint });
    await run(db, operation);
    await db.exec(`INSERT INTO user_favorites(user_id,match_id) VALUES('${OWNER}','1234')`);
    await assert.rejects(() => run(db, operation), /resource_reappeared/);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM user_favorites')).rows[0].count, 1);
  } finally { await db.close(); }
});

test('receipt table refuses authenticated and anonymous reads and writes', async () => {
  const db = await database();
  try {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(() => db.query('SELECT * FROM tt_demo_source_receipts'), /permission denied/);
      await assert.rejects(() => db.exec('DELETE FROM tt_demo_source_receipts'), /permission denied/);
      await db.exec('RESET ROLE');
    }
  } finally { await db.close(); }
});

test('receipt ACL removes inherited destructive and agent_sql privileges', async () => {
  const db = await database();
  try {
    const grants = (await db.query(`SELECT
      has_table_privilege('service_role','tt_demo_source_receipts','SELECT') AS can_select,
      has_table_privilege('service_role','tt_demo_source_receipts','INSERT') AS can_insert,
      has_table_privilege('service_role','tt_demo_source_receipts','UPDATE') AS can_update,
      has_table_privilege('service_role','tt_demo_source_receipts','DELETE') AS can_delete,
      has_table_privilege('service_role','tt_demo_source_receipts','TRUNCATE') AS can_truncate,
      has_table_privilege('agent_sql','tt_demo_source_receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS agent_has_any_access`)).rows[0];
    assert.deepEqual(grants, { can_select: true, can_insert: true, can_update: true, can_delete: false, can_truncate: false, agent_has_any_access: false });
    await db.exec('SET ROLE service_role');
    await assert.rejects(() => db.exec('DELETE FROM public.tt_demo_source_receipts'), /permission denied/);
    await assert.rejects(() => db.exec('TRUNCATE public.tt_demo_source_receipts'), /permission denied/);
    await db.exec('RESET ROLE; SET ROLE agent_sql');
    await assert.rejects(() => db.query('SELECT * FROM public.tt_demo_source_receipts'), /permission denied/);
    await assert.rejects(() => db.exec('DELETE FROM public.tt_demo_source_receipts'), /permission denied/);
    await assert.rejects(() => db.exec('TRUNCATE public.tt_demo_source_receipts'), /permission denied/);
    await db.exec('RESET ROLE');
  } finally { await db.close(); }
});

test('guardrails reject cross-project, raw account/payment/ticket mutations and unowned data', () => {
  assert.throws(() => prepare({ ...base, projectId: 7 }), /project_adapter_mismatch/);
  assert.throws(() => prepare({ ...base, table: 'orders' }), /unsupported_resource/);
  assert.throws(() => prepare({ ...base, table: 'profiles' }), /unsupported_resource/);
  assert.throws(() => prepare({ ...base, dedicatedAccountIds: [] }), /dedicated_account_required/);
  assert.throws(() => prepare({ ...base, payload: { ...base.payload, qr_token: 'secret' } }), /unsupported_field/);
  assert.equal(inspect({ adapter: 'culcush' }).capabilities.productFlows.includes('cart'), true);
});

test('external flows require recent TEST proof and test-only recipients', () => {
  const now = Date.now(), good = { mode: 'test', livemode: false, recipients: 'test_only', providerReference: 'provider-proof', verifiedAt: new Date(now).toISOString() };
  requireTestBoundary(good, now);
  for (const evidence of [undefined, { ...good, livemode: true }, { ...good, recipients: 'mixed' }, { ...good, verifiedAt: new Date(now-3600001).toISOString() }]) assert.throws(() => requireTestBoundary(evidence, now), /verified_test_boundary_required/);
  assert.throws(() => productOperation({ adapter: 'culcush', projectId: 7, operation: 'checkout' }), /verified_test_boundary_required/);
  assert.equal(productOperation({ adapter: 'culcush', projectId: 7, operation: 'cart' }).kind, 'browser');
  assert.equal(productOperation({ adapter: 'motion', projectId: 16, operation: 'android_install' }).blocked, true);
});

test('Auth createUser lost response reconciles metadata, without leaking password or adopting others', async () => {
  const users = []; let creates = 0;
  const admin = { auth: { admin: { listUsers: async () => ({ data: { users }, error: null }), createUser: async body => { creates++; users.push({ id: OWNER, email: body.email, app_metadata: body.app_metadata }); throw Error('network_lost'); } } } };
  const input = { admin, presentationId: P, resourceKey: 'parent-account', email: 'presenter@example.test', password: 'a-long-private-password', name: 'Alex' };
  await assert.rejects(() => ensureAccount(input), /account_create_unconfirmed_retry_inspect/);
  const result = await ensureAccount(input);
  assert.equal(creates, 1); assert.equal(result.external_id, OWNER); assert.equal(JSON.stringify(result).includes(input.password), false);
  await assert.rejects(() => ensureAccount({ ...input, presentationId: OTHER }), /foreign_account_collision/);
});
