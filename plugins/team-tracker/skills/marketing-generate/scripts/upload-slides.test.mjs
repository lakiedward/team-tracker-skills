// Teste pentru upload-slides.mjs cu fetch fals: fără rețea. Rulare: node scripts/upload-slides.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BUCKET,
  MISSING_KEY_MESSAGE,
  SUPABASE_URL,
  listSlidePngs,
  objectPath,
  objectUrl,
  parseArgs,
  uploadAll,
} from './upload-slides.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'upload-slides.mjs');

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.log(`not ok - ${name}\n    ${String(error.stack || error).split('\n').join('\n    ')}`);
    }
  });
}

const dir = mkdtempSync(join(tmpdir(), 'upload-slides-'));
const PNG_A = Buffer.alloc(1500, 1);
const PNG_B = Buffer.alloc(2500, 2);
writeFileSync(join(dir, 'slide-01.png'), PNG_A);
writeFileSync(join(dir, 'slide-03.png'), PNG_B);
writeFileSync(join(dir, 'slide-02.html'), '<html></html>');
writeFileSync(join(dir, 'notes.txt'), 'nu e slide');

const KEY = 'sb-secret-test-key-DO-NOT-LOG';

// Un fetch fals care înregistrează apelurile și răspunde după un scenariu.
function fakeFetch(plan = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, bodyLength: init.body ? init.body.length : 0 });
    const decide = plan[init.method] || (() => 200);
    const status = decide(url, calls.length);
    return { ok: status >= 200 && status < 300, status, text: async () => `body-${status}` };
  };
  return { impl, calls };
}

test('objectPath și objectUrl', () => {
  assert.equal(objectPath(11, 12, 2, 0), '11/posts/12/v2/slide-01.png');
  assert.equal(objectPath('11', '12', '3', 9), '11/posts/12/v3/slide-10.png');
  assert.equal(objectUrl('marketing-assets', '11/posts/12/v2/slide-01.png'), `${SUPABASE_URL}/storage/v1/object/marketing-assets/11/posts/12/v2/slide-01.png`);
});

test('parseArgs', () => {
  const args = parseArgs(['--dir', 'out', '--project', '11', '--post', '12', '--version', '2']);
  assert.equal(args.bucket, DEFAULT_BUCKET);
  assert.equal(args.only, null);
  assert.deepEqual([...parseArgs(['--dir', 'o', '--project', '1', '--post', '2', '--version', '3', '--only', '3,5', '--bucket', 'b']).only], [3, 5]);
  assert.throws(() => parseArgs(['--dir', 'out']), /--project/);
  assert.throws(() => parseArgs(['--dir', 'o', '--project', 'x', '--post', '2', '--version', '3']), /număr întreg/);
  assert.throws(() => parseArgs(['--nope']), /necunoscut/);
});

test('listSlidePngs ia doar slide-NN.png, sortate', () => {
  const list = listSlidePngs(dir);
  assert.deepEqual(list.map((s) => [s.name, s.orderIndex]), [['slide-01.png', 0], ['slide-03.png', 2]]);
});

test('fără cheie: aruncă înainte de orice fetch, cu exitCode 2', async () => {
  const { impl, calls } = fakeFetch();
  await assert.rejects(
    uploadAll({ dir, project: 11, post: 12, version: 2, key: '' }, { fetchImpl: impl }),
    (error) => error.message === MISSING_KEY_MESSAGE && error.exitCode === 2,
  );
  assert.equal(calls.length, 0, 'fetch nu trebuie apelat');
});

test('uploadAll: URL-uri, metode, antete, lungimi și rezultat', async () => {
  const { impl, calls } = fakeFetch();
  const result = await uploadAll({ dir, project: 11, post: 12, version: 2, key: KEY }, { fetchImpl: impl });
  assert.deepEqual(result, {
    bucket: DEFAULT_BUCKET,
    uploaded: [
      { order_index: 0, path: '11/posts/12/v2/slide-01.png', bytes: 1500 },
      { order_index: 2, path: '11/posts/12/v2/slide-03.png', bytes: 2500 },
    ],
  });
  assert.equal(calls.length, 4, 'POST + GET per slide');
  const [post1, get1, post3, get3] = calls;
  assert.equal(post1.url, `${SUPABASE_URL}/storage/v1/object/marketing-assets/11/posts/12/v2/slide-01.png`);
  assert.equal(post1.method, 'POST');
  assert.equal(post1.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(post1.headers.apikey, KEY);
  assert.equal(post1.headers['Content-Type'], 'image/png');
  assert.equal(post1.headers['x-upsert'], 'true');
  assert.equal(post1.bodyLength, 1500);
  assert.equal(get1.url, post1.url);
  assert.equal(get1.method, 'GET');
  assert.equal(get1.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(get1.bodyLength, 0);
  assert.equal(post3.bodyLength, 2500);
  assert.ok(post3.url.endsWith('/slide-03.png'));
  assert.equal(get3.method, 'GET');
  assert.ok(!JSON.stringify(result).includes(KEY), 'cheia nu apare în rezultat');
});

test('uploadAll respectă --only și --bucket', async () => {
  const { impl, calls } = fakeFetch();
  const result = await uploadAll({ dir, project: 1, post: 2, version: 3, bucket: 'alt', only: new Set([2]), key: KEY }, { fetchImpl: impl });
  assert.equal(result.bucket, 'alt');
  assert.deepEqual(result.uploaded.map((u) => u.order_index), [2]);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes('/object/alt/1/posts/2/v3/slide-03.png'));
});

test('răspuns non-2xx la upload aruncă și numește slide-ul, fără cheie în mesaj', async () => {
  const { impl, calls } = fakeFetch({ POST: (url) => (url.endsWith('slide-03.png') ? 403 : 200) });
  await assert.rejects(
    uploadAll({ dir, project: 11, post: 12, version: 2, key: KEY }, { fetchImpl: impl }),
    (error) => /slide-03\.png: upload eșuat \(HTTP 403\)/.test(error.message) && !error.message.includes(KEY),
  );
  assert.equal(calls.length, 3, 'POST+GET pentru slide-01, POST eșuat pentru slide-03');
});

test('verificarea GET non-200 aruncă numind slide-ul', async () => {
  const { impl } = fakeFetch({ GET: () => 404 });
  await assert.rejects(
    uploadAll({ dir, project: 11, post: 12, version: 2, key: KEY }, { fetchImpl: impl }),
    /slide-01\.png: verificarea după upload a eșuat \(HTTP 404\)/,
  );
});

test('director fără slide-uri aruncă', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'upload-empty-'));
  const { impl, calls } = fakeFetch();
  await assert.rejects(uploadAll({ dir: empty, project: 1, post: 1, version: 1, key: KEY }, { fetchImpl: impl }), /niciun slide/);
  assert.equal(calls.length, 0);
  rmSync(empty, { recursive: true, force: true });
});

test('CLI fără SUPABASE_SERVICE_ROLE_KEY iese cu 2 și mesajul exact', () => {
  const env = { ...process.env };
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  const result = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--project', '11', '--post', '12', '--version', '2'], { env, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes(MISSING_KEY_MESSAGE), result.stderr);
  assert.equal(result.stdout, '');
});

(async () => {
  for (const run of pending) await run();
  rmSync(dir, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`\n${failures} test(e) picate`);
    process.exit(1);
  }
  console.log('\ntoate testele au trecut');
})();
