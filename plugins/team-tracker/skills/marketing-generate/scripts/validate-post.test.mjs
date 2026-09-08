// Teste pentru validate-post.mjs. Rulare: node scripts/validate-post.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasFigure, isLabelledSample, parseArgs, validatePost } from './validate-post.mjs';

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`not ok - ${name}\n    ${String(error.stack || error).split('\n').join('\n    ')}`);
  }
}

const assetsDir = mkdtempSync(join(tmpdir(), 'validate-post-'));
mkdirSync(join(assetsDir, 'betora'));
writeFileSync(join(assetsDir, 'betora', 'phone-1.webp'), 'x');

function slide(orderIndex, overrides = {}) {
  return { order_index: orderIndex, layout: 'statement', headline: `Headline ${orderIndex}`, body: 'Plain body.', ...overrides };
}

function goodPost(overrides = {}) {
  return {
    post_id: 1,
    version: 1,
    caption: 'A caption that says something.',
    hashtags: ['#alkistudio', '#betora'],
    slides: [slide(0, { layout: 'cover' }), slide(1), slide(2, { layout: 'cta', cta: 'alkistudio.ro' })],
    ...overrides,
  };
}

function errorsOf(post, options = {}) {
  return validatePost(post, { assetsDir, ...options }).errors;
}

test('un post corect trece', () => {
  assert.deepEqual(validatePost(goodPost(), { assetsDir }), { ok: true, errors: [] });
});

test('numărul de slide-uri trebuie să fie în [min, max]', () => {
  assert.match(errorsOf(goodPost({ slides: [slide(0), slide(1)] })).join('\n'), /număr de slide-uri 2/);
  const many = Array.from({ length: 11 }, (_, i) => slide(i));
  assert.match(errorsOf(goodPost({ slides: many })).join('\n'), /număr de slide-uri 11/);
  assert.equal(validatePost(goodPost({ slides: [slide(0), slide(1)] }), { assetsDir, minSlides: 2 }).ok, true);
});

test('hashtag-uri: maxim 5, un singur token fără spații', () => {
  const six = ['#a', '#b', '#c', '#d', '#e', '#f'];
  assert.match(errorsOf(goodPost({ hashtags: six })).join('\n'), /6 hashtag-uri, maxim 5/);
  assert.match(errorsOf(goodPost({ hashtags: ['#two words'] })).join('\n'), /hashtag invalid/);
  assert.match(errorsOf(goodPost({ hashtags: [''] })).join('\n'), /hashtag invalid/);
  assert.equal(errorsOf(goodPost({ hashtags: undefined })).length, 0, 'fără hashtag-uri e permis');
  assert.equal(validatePost(goodPost({ hashtags: ['#a', '#b', '#c'] }), { assetsDir, maxHashtags: 2 }).ok, false);
});

test('caption: ne-gol și ≤ 2200 caractere', () => {
  assert.match(errorsOf(goodPost({ caption: '   ' })).join('\n'), /caption gol/);
  assert.match(errorsOf(goodPost({ caption: undefined })).join('\n'), /caption gol/);
  assert.match(errorsOf(goodPost({ caption: 'x'.repeat(2201) })).join('\n'), /2201 caractere, maxim 2200/);
  assert.equal(errorsOf(goodPost({ caption: 'x'.repeat(2200) })).length, 0);
});

test('fiecare slide are headline ne-gol și layout cunoscut', () => {
  const errors = errorsOf(goodPost({ slides: [slide(0, { headline: '' }), slide(1, { layout: 'hero' }), slide(2)] }));
  assert.match(errors.join('\n'), /slide 1: headline gol/);
  assert.match(errors.join('\n'), /slide 2: layout necunoscut "hero"/);
});

test('order_index lipsă sau duplicat', () => {
  const errors = errorsOf(goodPost({ slides: [slide(0), slide(0), { layout: 'cover', headline: 'x' }] }));
  assert.match(errors.join('\n'), /order_index duplicat/);
  assert.match(errors.join('\n'), /order_index lipsă/);
});

test('asset-ul trebuie să existe sub assetsDir', () => {
  const ok = goodPost({ slides: [slide(0, { layout: 'screenshot_phone', asset: 'betora/phone-1.webp' }), slide(1), slide(2)] });
  assert.equal(errorsOf(ok).length, 0);
  const missing = goodPost({ slides: [slide(0, { layout: 'screenshot_phone', asset: 'betora/phone-9.webp' }), slide(1), slide(2)] });
  assert.match(errorsOf(missing).join('\n'), /slide 1: asset inexistent: betora\/phone-9.webp/);
  const noDir = validatePost(ok, {}).errors;
  assert.match(noDir.join('\n'), /nu s-a dat assetsDir/);
});

test('layout-ul stat cere disclaimer ne-gol', () => {
  const noDisclaimer = goodPost({ slides: [slide(0, { layout: 'stat', stat: '6', headline: 'markets' }), slide(1), slide(2)] });
  assert.match(errorsOf(noDisclaimer).join('\n'), /"stat" cere un disclaimer/);
  const withDisclaimer = goodPost({
    slides: [slide(0, { layout: 'stat', stat: '6', headline: 'markets', disclaimer: 'sample output' }), slide(1), slide(2)],
  });
  assert.equal(errorsOf(withDisclaimer).length, 0);
});

test('hasFigure detectează %, +N și Nx, dar nu dimensiuni ca 1080x1350', () => {
  assert.equal(hasFigure('85%'), true);
  assert.equal(hasFigure('85 %'), true);
  assert.equal(hasFigure('+27% edge'), true);
  assert.equal(hasFigure('+3 leads'), true);
  assert.equal(hasFigure('2x faster'), true);
  assert.equal(hasFigure('1080x1350'), false);
  assert.equal(hasFigure('six markets'), false);
  assert.equal(hasFigure(undefined), false);
});

test('isLabelledSample caută sample/demo/mock/illustrative în oricare text', () => {
  assert.equal(isLabelledSample('Sample output', ''), true);
  assert.equal(isLabelledSample('', 'a demo of the model'), true);
  assert.equal(isLabelledSample('', 'Mockup numbers'), true);
  assert.equal(isLabelledSample(undefined, 'illustrative only'), true);
  assert.equal(isLabelledSample('real results', 'from clients'), false);
});

test('cifrele de mockup fără etichetă produc eroare', () => {
  const unlabelled = goodPost({ slides: [slide(0, { headline: '+27% edge on the market', body: 'Real talk.' }), slide(1), slide(2)] });
  const errors = errorsOf(unlabelled);
  assert.match(errors.join('\n'), /slide 1: conține o cifră care arată a rezultat \(headline\)/);
  assert.match(errors.join('\n'), /sample/);
});

test('cifrele etichetate în disclaimer sau body trec', () => {
  const viaDisclaimer = goodPost({
    slides: [slide(0, { layout: 'stat', stat: '85%', headline: 'confidence', disclaimer: 'sample output, not client results' }), slide(1), slide(2)],
  });
  assert.equal(errorsOf(viaDisclaimer).length, 0);
  const viaBody = goodPost({ slides: [slide(0, { headline: '2x faster', body: 'Illustrative numbers from a demo dataset.' }), slide(1), slide(2)] });
  assert.equal(errorsOf(viaBody).length, 0);
});

test('post invalid la rădăcină', () => {
  assert.equal(validatePost(null).ok, false);
  assert.match(validatePost({ caption: 'x' }).errors.join('\n'), /"slides" trebuie să fie un array/);
  assert.match(validatePost({ caption: 'x', slides: [], hashtags: 'nope' }).errors.join('\n'), /"hashtags" trebuie să fie un array/);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--post', 'p.json', '--assets', 'a']), { post: 'p.json', assets: 'a' });
  assert.throws(() => parseArgs([]), /--post/);
  assert.throws(() => parseArgs(['--x']), /necunoscut/);
});

rmSync(assetsDir, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} test(e) picate`);
  process.exit(1);
}
console.log('\ntoate testele au trecut');
