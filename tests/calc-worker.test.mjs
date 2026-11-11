/* ============================================================
   CALC WORKER TESTS — calc.christoclose.com (calc-worker.js)
   Run: node tests/calc-worker.test.mjs
   Loads the real calc-worker.js with a fake GitHub (serving the
   real preview/index.html) and fake link storage.
   Exit code 0 = all good, 1 = something is wrong.
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'calc-worker.js'), 'utf8')
  + '\nexport { firstName, shortPrice, buildCaption, rewriteMeta };\n';
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-')), 'calc.mjs');
fs.writeFileSync(tmp, src);
const mod = await import(pathToFileURL(tmp).href);
const worker = mod.default;

const PAGE = fs.readFileSync(path.join(ROOT, 'preview', 'index.html'), 'utf8');
const GH = 'https://christoclose.github.io/dti-calculator';
const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(name + (detail ? ' — ' + detail : '')); };

/* Fake GitHub Pages */
let lastFetch = null;
globalThis.fetch = async (url, opts) => {
  url = String(url); lastFetch = { url, opts };
  if (!url.startsWith(GH)) throw new Error('unexpected outside call: ' + url);
  const p = url.slice(GH.length);
  if (p === '/' || p === '/preview/') return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=600', etag: 'x' } });
  if (p === '/help-img') return new Response('', { status: 301, headers: { location: GH + '/help-img/' } });
  if (p === '/elsewhere') return new Response('', { status: 302, headers: { location: 'https://evil.example/' } });
  if (p.startsWith('/fonts/')) return new Response('FONTDATA', { status: 200, headers: { 'content-type': 'font/woff2', 'cache-control': 'max-age=600' } });
  return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
};

/* Fake link storage — read only (any write fails the test) */
const store = new Map();
const kv = { async get(k) { return store.has(k) ? store.get(k) : null; }, async put() { throw new Error('calc Worker must never write'); }, async delete() { throw new Error('calc Worker must never delete'); } };
const env = { LOOKUP_KV: kv };
store.set('link:AbCdEfGhJk', JSON.stringify({ p: { pp: '400000', inc: '9000', dbt: '800', rt: '6.5', nm: 'sarah jones', cn: 'Pinellas', ts: 'Nov 10, 2026' }, by: 'lender', created: 1 }));
store.set('link:NoNameLink', JSON.stringify({ p: { pp: '1250000', inc: '30000', rt: '6', cn: 'Hillsborough', ts: 'Dec 2, 2026' }, by: 'client', created: 1 }));
store.set('link:EvilNameXx', JSON.stringify({ p: { pp: '300000', inc: '5000', rt: '6', nm: '<script>alert(1)</script>', cn: 'Pasco"><b>', ts: 'Jan 5, 2027' }, by: 'client', created: 1 }));

const call = (u, method = 'GET') => worker.fetch(new Request('https://calc.christoclose.com' + u, { method }), env);
const head = (html) => html.slice(0, html.toLowerCase().indexOf('</head>'));
const meta = (html, key) => { const m = head(html).match(new RegExp('<meta (?:property|name)="' + key + '" content="([^"]*)"')); return m ? m[1] : null; };

// 1. Home page comes from GitHub, preview points at calc.christoclose.com
{
  const r = await call('/');
  const html = await r.text();
  check('home 200', r.status === 200);
  check('home fetched from GitHub /', lastFetch.url === GH + '/');
  check('home og:url', meta(html, 'og:url') === 'https://calc.christoclose.com/', meta(html, 'og:url'));
  check('home keeps default title', meta(html, 'og:title') === 'ChrisToClose Home Calculator');
  check('home security: no framing', r.headers.get('x-frame-options') === 'DENY');
  check('home security: nosniff', r.headers.get('x-content-type-options') === 'nosniff');
  check('home keeps the whole page', html.length > PAGE.length - 500 && html.includes('</html>'));
}
// 2. Fonts asked for at /dti-calculator/fonts/... load from GitHub
{
  const r = await call('/dti-calculator/fonts/x.woff2');
  check('font path mapped', lastFetch.url === GH + '/fonts/x.woff2', lastFetch.url);
  check('font body passed', (await r.text()) === 'FONTDATA');
  check('font type passed', r.headers.get('content-type') === 'font/woff2');
}
// 3. Short link with a name → its own caption, first name only
{
  const r = await call('/?s=AbCdEfGhJk');
  const html = await r.text();
  check('caption title', meta(html, 'og:title') === 'Sarah’s Home Payment Estimate', meta(html, 'og:title'));
  check('caption description', meta(html, 'og:description') === '$400K home · Pinellas · Nov 10', meta(html, 'og:description'));
  check('caption og:url keeps link', meta(html, 'og:url') === 'https://calc.christoclose.com/?s=AbCdEfGhJk');
  check('caption image stays', meta(html, 'og:image') === GH + '/og-image-1200x630-3.png');
  check('caption <title>', head(html).includes('<title>Sarah’s Home Payment Estimate</title>'));
  check('last name never shown', !head(html).includes('Jones') && !head(html).includes('jones'));
  const said = meta(html, 'og:title') + ' ' + meta(html, 'og:description');
  check('income/debts never in preview', !/9000|9,000|\b800\b|6\.5/.test(said), said);
  check('caption not cached for others', r.headers.get('cache-control') === 'private, no-store');
  check('one caption per tag', (head(html).match(/og:title/g) || []).length === 1);
}
// 4. Preview folder works too
{
  const r = await call('/preview/?s=AbCdEfGhJk');
  const html = await r.text();
  check('preview fetched', lastFetch.url === GH + '/preview/');
  check('preview caption', meta(html, 'og:title') === 'Sarah’s Home Payment Estimate');
  check('preview og:url', meta(html, 'og:url') === 'https://calc.christoclose.com/preview/?s=AbCdEfGhJk');
}
// 5. No name / big price
{
  const html = await (await call('/?s=NoNameLink')).text();
  check('no-name title', meta(html, 'og:title') === 'Your Home Payment Estimate', meta(html, 'og:title'));
  check('millions price', meta(html, 'og:description') === '$1.25M home · Hillsborough · Dec 2', meta(html, 'og:description'));
}
// 6. Junk in the link can't break the page
{
  const html = await (await call('/?s=EvilNameXx')).text();
  check('script stripped from name', !head(html).includes('<script>alert') && !head(html).includes('&lt;script'), meta(html, 'og:title'));
  check('quotes stripped from county', !head(html).includes('"><b>'));
}
// 7. Unknown / bad ids → normal preview
{
  const a = await (await call('/?s=ZZZZZZZZZZ')).text();
  check('unknown id default title', meta(a, 'og:title') === 'ChrisToClose Home Calculator');
  check('unknown id og:url plain', meta(a, 'og:url') === 'https://calc.christoclose.com/');
  const b = await (await call('/?s=../../etc')).text();
  check('bad id default title', meta(b, 'og:title') === 'ChrisToClose Home Calculator');
}
// 8. Only reading allowed
{
  check('POST refused', (await call('/', 'POST')).status === 405);
  check('HEAD works', (await call('/', 'HEAD')).status === 200);
}
// 9. Paths and redirects stay on calc.christoclose.com
{
  check('dot-dot refused', (await call('/fonts/%2e%2e/secret')).status === 404 || lastFetch.url.startsWith(GH + '/'));
  const p = await call('/preview');
  check('/preview → /preview/', p.status === 301 && p.headers.get('location') === 'https://calc.christoclose.com/preview/');
  const g = await call('/help-img');
  check('GitHub redirect rewritten', g.status === 301 && g.headers.get('location') === 'https://calc.christoclose.com/help-img/', g.headers.get('location'));
  const e = await call('/elsewhere');
  check('outside redirect refused', e.status === 404);
  check('missing file 404', (await call('/nothing-here.txt')).status === 404);
}
// 10. Little helpers
{
  check('firstName trims', mod.firstName('  maria  lopez ') === 'Maria');
  check('firstName empty', mod.firstName('123') === '');
  check('price small', mod.shortPrice('99000') === '$99K');
  check('price junk', mod.shortPrice('abc') === '');
}

if (failures.length) {
  console.error('CALC WORKER TESTS FAILED (' + failures.length + '):\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('calc Worker tests: all passed');
