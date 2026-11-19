/* ============================================================
   WORKER TESTS — Save Scenario protection (Q7)
   Run: node tests/worker.test.mjs
   Loads the real tax-worker.js with a fake EmailJS, a fake
   Turnstile check and fake KV storage — nothing real is sent.
   Exit code 0 = all good, 1 = something is wrong.
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'tax-worker.js'), 'utf8');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')), 'worker.mjs');
fs.writeFileSync(tmp, src);
const worker = (await import(pathToFileURL(tmp).href)).default;

const ORIGIN = 'https://christoclose.github.io';
const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(name + (detail ? ' — ' + detail : '')); };

/* Fake outside world */
let emailsSent = 0;
let lastEmail = null;
let turnstileAnswer = { success: true, hostname: 'christoclose.github.io' };
let realieCalls = 0;
let pinellasParcels = [];
let googleCalls = 0, lastGoogleBody = null;
const parcel = (site, legal, taxes) => ({ PARCELID_DSP1: 'P-' + site, STRAP: '1', TAXABLE_VALUE: 200000, HOMESTEAD: 'No', HOMESTEAD_EXEMP: 0, TAXES: taxes || 4000, SITE_ADDRESS: site, SITE_CITY: 'ST PETERSBURG', SITE_ZIP: '33701', LEGAL: legal || 'LOT 1', LAND_VALUE: 50000, IMP_VALUE: 150000, NEW_CONST_VALUE: 0, SALEPRICE1: 0 });
let realieAnswer = { status: 200, body: { property: {
  propertyIdentification: { county: 'MIAMI-DADE', currentOwner: { ownerName: 'SECRET OWNER' } },
  propertyLocation: { addressFull: '1 TEST ST APT 5, MIAMI, FL 33101', unitNumberStripped: '5' },
  valuationInformation: { totalAssessedValue: 300000, exemptions: [{ exemptionType: 'Homestead' }] },
  taxInformation: { taxAmount: 3911.5, taxYear: 2024 }, mortgages: [{ amount: 1 }] }, otherResults: [] } };
globalThis.fetch = async function (url) {
  url = String(url);
  if (url.includes('api.emailjs.com')) { emailsSent++; lastEmail = JSON.parse(arguments[1].body); return new Response('OK', { status: 200 }); }
  if (url.includes('places.googleapis.com/v1/places:autocomplete')) { googleCalls++; lastGoogleBody = JSON.parse(arguments[1].body); return new Response(JSON.stringify({ suggestions: [
    { placePrediction: { placeId: 'ChIJ_abcdefghij123', text: { text: '4900 Brittany Dr S, St. Petersburg, FL, USA' }, structuredFormat: { mainText: { text: '4900 Brittany Dr S' }, secondaryText: { text: 'St. Petersburg, FL, USA' } } } },
    { queryPrediction: { text: { text: 'ignored' } } } ] }), { status: 200 }); }
  if (url.includes('places.googleapis.com/v1/places/')) { googleCalls++; return new Response(JSON.stringify({ formattedAddress: '4900 Brittany Dr S #1808, St. Petersburg, FL 33715, USA', addressComponents: [
    { longText: '4900', shortText: '4900', types: ['street_number'] }, { longText: 'Brittany Drive South', shortText: 'Brittany Dr S', types: ['route'] },
    { longText: '1808', shortText: '1808', types: ['subpremise'] }, { longText: 'St. Petersburg', shortText: 'St. Petersburg', types: ['locality', 'political'] },
    { longText: 'Pinellas County', shortText: 'Pinellas County', types: ['administrative_area_level_2', 'political'] },
    { longText: 'Florida', shortText: 'FL', types: ['administrative_area_level_1'] }, { longText: '33715', shortText: '33715', types: ['postal_code'] } ] }), { status: 200 }); }
  if (url.includes('egis.pinellas.gov')) return new Response(JSON.stringify({ features: pinellasParcels.map((a) => ({ attributes: a })) }), { status: 200 });
  if (url.includes('app.realie.ai')) { realieCalls++; return new Response(JSON.stringify(realieAnswer.body), { status: realieAnswer.status }); }
  if (url.includes('turnstile/v0/siteverify')) return new Response(JSON.stringify(turnstileAnswer), { status: 200 });
  throw new Error('unexpected outside call: ' + url);
};
function fakeKV() {
  const m = new Map(); const ttl = new Map();
  return {
    m, ttl,
    async get(k, type) { const v = m.has(k) ? m.get(k) : null; return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v, opts) { m.set(k, v); ttl.set(k, opts && opts.expirationTtl); },
  };
}

/* D3 Option B: Save Scenario and client-made links must come from a link Chris made.
   LENDER_LINK is a stand-in for one of his links; seedLender() puts it in the fake storage. */
const LINK_REQUIRED_NOW = /const LINK_REQUIRED = true;/.test(src);
const LENDER_LINK = 'ChrisLnk01';
function seedLender(env, id = LENDER_LINK, ageDays = 0) {
  if (!env.LOOKUP_KV) env.LOOKUP_KV = fakeKV();
  env.LOOKUP_KV.m.set('link:' + id, JSON.stringify({ p: { pp: '400000', inc: '11000', rt: '7' }, by: 'lender', created: Date.now() - ageDays * 86400000 }));
  return id;
}
const okLimiter = { limit: async () => ({ success: true }) };

let n = 0;
function params(to, extra) {
  return { to_email: to, scenario_label: 'Test ' + (++n), property_address: '1 Main St', housing_payment: '$3,000', ...extra };
}
async function send(env, p, token, from, w) {
  const body = { params: p };
  if (token !== undefined) body.turnstileToken = token;
  if (from === undefined) { seedLender(env); body.from = LENDER_LINK; } else if (from !== null) body.from = from;
  const r = await (w || worker).fetch(new Request('https://w.example/send-scenario', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify(body),
  }), env, {});
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const baseEnv = () => ({ GOOGLE_PLACES_KEY: 'gk', REALIE_API_KEY: 'rk', LOOKUP_KV: null, EMAILJS_PRIVATE_KEY: 'x', TURNSTILE_SECRET: 's', EMAIL_LIMITS_KV: fakeKV(), LOOKUP_LIMITER: okLimiter, EMAIL_LIMITER: okLimiter });

/* 1. A valid send works and is counted */
{
  const env = baseEnv(); emailsSent = 0;
  const r = await send(env, params('a@example.com'), 'tok');
  check('valid send accepted', r.status === 200 && r.body.ok, JSON.stringify(r));
  check('valid send reaches EmailJS', emailsSent === 1);
  check('send is counted', env.EMAIL_LIMITS_KV.m.size === 3, 'keys: ' + [...env.EMAIL_LIMITS_KV.m.keys()].join(','));
  check('recipient address is not stored in plain text', ![...env.EMAIL_LIMITS_KV.m.keys(), ...env.EMAIL_LIMITS_KV.m.values()].some((x) => String(x).includes('a@example.com')));
}
/* 2. A bad Turnstile token is refused, nothing sent */
{
  const env = baseEnv(); emailsSent = 0;
  turnstileAnswer = { success: false, 'error-codes': ['invalid-input-response'] };
  const r = await send(env, params('b@example.com'), 'bad');
  check('bad human-check token refused', r.status === 403 && emailsSent === 0, JSON.stringify(r));
  turnstileAnswer = { success: true, hostname: 'evil.example' };
  const r2 = await send(env, params('b@example.com'), 'tok');
  check('token from another website refused', r2.status === 403 && emailsSent === 0, JSON.stringify(r2));
  turnstileAnswer = { success: true, hostname: 'christoclose.github.io' };
}
/* 3. Token present but no secret configured → refuse */
{
  const env = baseEnv(); delete env.TURNSTILE_SECRET; emailsSent = 0;
  const r = await send(env, params('c@example.com'), 'tok');
  check('no Turnstile secret = refuse', r.status === 503 && emailsSent === 0, JSON.stringify(r));
}
/* 4. No storage → refuse (fail closed) */
{
  const env = baseEnv(); delete env.EMAIL_LIMITS_KV; emailsSent = 0;
  const r = await send(env, params('d@example.com'), 'tok');
  check('no limit storage = refuse', r.status === 503 && emailsSent === 0, JSON.stringify(r));
}
/* 5. 5 per hour per recipient */
{
  const env = baseEnv(); emailsSent = 0;
  const results = [];
  for (let i = 0; i < 6; i++) results.push((await send(env, params('e@example.com'), 'tok')).status);
  check('5 per hour allowed, 6th refused', results.slice(0, 5).every((s) => s === 200) && results[5] === 429 && emailsSent === 5, results.join(','));
  const other = await send(env, params('f@example.com'), 'tok');
  check('another recipient is not blocked', other.status === 200);
}
/* 6. 15 per day per recipient (sends spread over the last 24h) */
{
  const env = baseEnv(); emailsSent = 0;
  const now = Date.now();
  // seed: 15 earlier sends, each 2h+ apart, all within 24h? 15 sends over 23h → ~1.5h apart
  const seeded = Array.from({ length: 15 }, (_, i) => now - (2 + i * 1.4) * 3600000);
  const keyed = [...(await (async () => { await send(env, params('g@example.com'), 'tok'); return env.EMAIL_LIMITS_KV.m.keys(); })())].find((k) => k.startsWith('rcpt:'));
  env.EMAIL_LIMITS_KV.m.set(keyed, JSON.stringify(seeded));
  emailsSent = 0;
  const r = await send(env, params('g@example.com'), 'tok');
  check('16th in 24 hours refused', r.status === 429 && emailsSent === 0 && /today/.test(r.body.error || ''), JSON.stringify(r));
  env.EMAIL_LIMITS_KV.m.set(keyed, JSON.stringify(seeded.slice(0, 14)));
  const r2 = await send(env, params('g@example.com'), 'tok');
  check('15th in 24 hours allowed', r2.status === 200, JSON.stringify(r2));
}
/* 7. 50 per day site-wide */
{
  const env = baseEnv(); emailsSent = 0;
  await send(env, params('h@example.com'), 'tok');
  const siteKey = [...env.EMAIL_LIMITS_KV.m.keys()].find((k) => k.startsWith('site:'));
  env.EMAIL_LIMITS_KV.m.set(siteKey, '50');
  emailsSent = 0;
  const r = await send(env, params('i@example.com'), 'tok');
  check('51st email of the day site-wide refused', r.status === 429 && emailsSent === 0, JSON.stringify(r));
}
/* 8. Exact duplicate within a minute is ignored (reported OK, sent once) */
{
  const env = baseEnv(); emailsSent = 0;
  const p = params('j@example.com');
  const r1 = await send(env, p, 'tok');
  const r2 = await send(env, { ...p }, 'tok2');
  check('duplicate sent only once', r1.status === 200 && r2.status === 200 && r2.body.duplicate === true && emailsSent === 1, JSON.stringify([r1, r2, emailsSent]));
}
/* 8b. Client names in the email (Nov 19, 2026): passed through as plain text, capped at 200 characters */
{
  const env = baseEnv();
  await send(env, params('names@example.com', { client_names: 'Sarah & Mike' }), 'tok');
  check('client names reach the email', lastEmail.template_params.client_names === 'Sarah & Mike', JSON.stringify(lastEmail.template_params.client_names));
  await send(env, params('names2@example.com', { client_names: 'x'.repeat(500) }), 'tok');
  check('client names capped at 200 characters', lastEmail.template_params.client_names.length === 200);
}
/* 9. Lender CC is still forced by the Worker */
{
  check('lender CC still set by the Worker', /params\.cc_email = EMAILJS_SETTINGS\.lenderEmail/.test(src));
}
/* 9b. DTI bar numbers: only real numbers 0–100 pass; badge colour set by the Worker */
{
  const env = baseEnv();
  await send(env, params('m@example.com', { bar_ok: 71.7, bar_warn: '11.7', bar_over: 16.6, bar_pos: '<b>x</b>', dti_warn: 150, dti_max: -1, dti_status: 'Approaching Limit', status_color: 'red;background:url(x)' }), 'tok');
  const p = lastEmail && lastEmail.template_params || {};
  check('bar numbers kept', p.bar_ok === '71.7' && p.bar_warn === '11.7' && p.bar_over === '16.6', JSON.stringify(p));
  check('bad bar values dropped', p.bar_pos === undefined && p.dti_warn === undefined && p.dti_max === undefined, JSON.stringify(p));
  check('status colour chosen by the Worker, not the browser', p.status_color === '#E8A317', p.status_color);
  await send(env, params('n@example.com', { dti_status: 'whatever' }), 'tok');
  check('unknown status gets the neutral colour', lastEmail.template_params.status_color === '#2B7FA4');
}
/* 11. Realie fallback for counties without a county lookup (C6) */
async function lookup(env, body) {
  const r = await worker.fetch(new Request('https://w.example/realie-lookup', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body),
  }), env, {});
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
{
  const env = baseEnv(); env.LOOKUP_KV = fakeKV(); realieCalls = 0;
  const q = { address: '1 Test St', unit: '5', state: 'FL', county: 'Miami-Dade', city: 'Miami' };
  const r1 = await lookup(env, q);
  check('Realie used for an unsupported county', r1.status === 200 && r1.body.source === 'realie' && r1.body.guidance_only === true && r1.body.annual_tax === 3911.5 && r1.body.tax_year === 2024 && r1.body.is_homesteaded === true, JSON.stringify(r1));
  check('no owner or mortgage data passed on', !/SECRET OWNER|mortgage/i.test(JSON.stringify(r1.body)));
  const r2 = await lookup(env, q);
  check('second lookup of the same address comes from the 30-day save (not paid again)', r2.status === 200 && r2.body.cached === true && realieCalls === 1, 'calls ' + realieCalls);
  // monthly cap
  const monthKey = [...env.LOOKUP_KV.m.keys()].find((k) => k.startsWith('realie-month:'));
  env.LOOKUP_KV.m.set(monthKey, '50'); realieCalls = 0;
  const r3 = await lookup(env, { ...q, address: '2 Test St' });
  check('monthly cap of 50 stops new Realie lookups', r3.status === 500 && realieCalls === 0 && /enter it with the pencil/.test(r3.body.error || ''), JSON.stringify(r3));
}
{
  const env = baseEnv(); env.LOOKUP_KV = fakeKV();
  const r = await lookup(env, { address: '1 Test St', unit: '5', state: 'FL', county: 'Broward' });
  check('address found in a different county is refused', r.status === 500 && /Miami-Dade County, not Broward/.test(r.body.error || ''), JSON.stringify(r));
  const r2 = await lookup(env, { address: '1 Test St', unit: '7', state: 'FL', county: 'Miami-Dade' });
  check('different unit is refused', r2.status === 500 && /Unit 7/.test(r2.body.error || ''), JSON.stringify(r2));
  const saved = realieAnswer;
  realieAnswer = { status: 200, body: { ...saved.body, otherResults: [{}] } };
  const r3 = await lookup(env, { address: '9 Test St', state: 'FL', county: 'Miami-Dade' });
  check('several matches are refused (no guessing)', r3.status === 500 && /More than one/.test(r3.body.error || ''), JSON.stringify(r3));
  realieAnswer = { status: 404, body: { error: 'not found' } };
  const r4 = await lookup(env, { address: '8 Test St', state: 'FL', county: 'Miami-Dade' });
  check('not found gives a clear message', r4.status === 500 && /couldn.t find that address/.test(r4.body.error || ''), JSON.stringify(r4));
  realieAnswer = saved;
  const env2 = baseEnv(); delete env2.REALIE_API_KEY; env2.LOOKUP_KV = fakeKV(); realieCalls = 0;
  const r5 = await lookup(env2, { address: '1 Test St', state: 'FL', county: 'Miami-Dade' });
  check('no Realie key = friendly refusal, no call', r5.status === 500 && realieCalls === 0, JSON.stringify(r5));
}
/* 12. Q5 wrong-property guard (Pinellas) — never auto-use a property that isn't an exact match */
{
  const env = baseEnv(); env.LOOKUP_KV = fakeKV();
  const ask = async (address, unit) => (await lookup(env, { address, unit: unit || '', state: 'FL', county: 'Pinellas', city: 'St Petersburg' })).body;
  pinellasParcels = [parcel('100 MAIN AVE')];
  let r = await ask('100 Main St');
  check('Q5: typed Main St, only Main Ave exists → asks to confirm', r.needs_confirmation === true && /100 MAIN AVE/.test(r.address_confirmed || ''), JSON.stringify(r));
  pinellasParcels = [parcel('100 S MAIN ST')];
  r = await ask('100 N Main St');
  check('Q5: typed N Main, only S Main exists → asks to confirm', r.needs_confirmation === true, JSON.stringify(r));
  pinellasParcels = [parcel('100 MAIN ST'), parcel('100 MAIN AVE')];
  r = await ask('100 Main St');
  check('Q5: exact match → used without asking', r.needs_confirmation === false && /^100 MAIN ST/.test(r.address_confirmed || ''), JSON.stringify(r));
  r = await ask('100 Main Street');
  check('Q5: "Street" spelled out still counts as an exact match', r.needs_confirmation === false, JSON.stringify(r));
  pinellasParcels = [parcel('200 OCEAN DR', 'OCEAN CONDO')];
  r = await ask('200 Ocean Dr', '5');
  check('Q5: unit typed but not on the county record → asks to confirm', r.needs_confirmation === true && /unit 5/i.test(r.confirm_reason || ''), JSON.stringify(r));
  pinellasParcels = [parcel('200 OCEAN DR', 'OCEAN CONDO UNIT 5'), parcel('200 OCEAN DR', 'OCEAN CONDO UNIT 6')];
  r = await ask('200 Ocean Dr', '5');
  check('Q5: unit found on the county record → used without asking', r.needs_confirmation === false, JSON.stringify(r));
}
/* 13. Q5 — the 3 scraper counties report whether the address came from the county (no echoing the typed one) */
{
  check('Q5: Hillsborough flags when the county gave no address', /addressVerified: !!countySite/.test(src));
  check('Q5: Pasco flags when the county gave no address', /const addressVerified = !!addrMatch;/.test(src));
  check('Q5: Manatee flags when the county gave no address', /if \(cleaned\) \{ addressConfirmed = cleaned; addressVerified = true; \}/.test(src));
}
/* 14. ADDR1 Google address autocomplete */
async function post(env, path, body) {
  const r = await worker.fetch(new Request('https://w.example' + path, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body),
  }), env, {});
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
{
  const env = baseEnv(); env.LOOKUP_KV = fakeKV(); googleCalls = 0;
  let r = await post(env, '/address-suggest', { input: '4900 Britt', sessionToken: 'abc12345-6789' });
  check('autocomplete returns address suggestions', r.status === 200 && r.body.suggestions.length === 1 && r.body.suggestions[0].main === '4900 Brittany Dr S' && r.body.suggestions[0].placeId === 'ChIJ_abcdefghij123', JSON.stringify(r));
  check('autocomplete asks Google for US addresses, favouring Florida', lastGoogleBody && lastGoogleBody.includedRegionCodes[0] === 'us' && lastGoogleBody.locationBias && lastGoogleBody.sessionToken === 'abc12345-6789');
  r = await post(env, '/address-suggest', { input: '49' });
  check('fewer than 4 letters → no Google call', r.body.suggestions.length === 0 && googleCalls === 1);
  r = await post(env, '/address-details', { placeId: 'ChIJ_abcdefghij123', sessionToken: 'abc12345-6789' });
  check('picking a suggestion returns street, unit, city, county, state, ZIP', r.body.street === '4900 Brittany Dr S' && r.body.unit === '1808' && r.body.city === 'St. Petersburg' && r.body.county === 'Pinellas' && r.body.state === 'FL' && r.body.zip === '33715', JSON.stringify(r));
  r = await post(env, '/address-details', { placeId: 'bad id!' });
  check('bad place id refused', r.status === 400);
  const monthKey = [...env.LOOKUP_KV.m.keys()].find((k) => k.startsWith('gplaces-month:'));
  env.LOOKUP_KV.m.set(monthKey, '4000'); googleCalls = 0;
  r = await post(env, '/address-suggest', { input: '4900 Britt' });
  check('monthly cap of 4,000 stops Google calls (plain typing after)', r.body.suggestions.length === 0 && r.body.unavailable === true && googleCalls === 0, JSON.stringify(r));
  const env2 = baseEnv(); delete env2.GOOGLE_PLACES_KEY; env2.LOOKUP_KV = fakeKV(); googleCalls = 0;
  r = await post(env2, '/address-suggest', { input: '4900 Britt' });
  check('no Google key → no suggestions, no call', r.body.suggestions.length === 0 && googleCalls === 0);
}
/* 10. Missing token: allowed only while TURNSTILE_REQUIRED is false */
{
  const required = /const TURNSTILE_REQUIRED = true;/.test(src);
  const env = baseEnv(); emailsSent = 0;
  const r = await send(env, params('k@example.com'));
  if (required) check('no token refused (TURNSTILE_REQUIRED on)', r.status === 403 && emailsSent === 0, JSON.stringify(r));
  else check('no token accepted while TURNSTILE_REQUIRED is off (limits still apply)', r.status === 200, JSON.stringify(r));
  console.log('Turnstile required: ' + (required ? 'YES' : 'NO (transition — turn on after the page is published)'));
}

/* 15. Short client links (S5): lender PIN or human check, 90-day storage, refusals */
{
  const env = baseEnv(); env.LOOKUP_KV = fakeKV(); env.LENDER_PIN = 'correct horse 42';
  const P = { pp: '400000', dp: '10', inc: '11000', dbt: '800', rt: '7', cn: 'Pinellas', mr: '17.43', nm: 'Sam', evil: '<script>' };
  let r = await post(env, '/link-create', { params: P, pin: 'correct horse 42' });
  check('lender with the right PIN gets a 10-character link id', r.status === 200 && /^[A-Za-z0-9]{10}$/.test(r.body.id), JSON.stringify(r));
  const id = r.body.id;
  const rec = JSON.parse(env.LOOKUP_KV.m.get('link:' + id));
  check('only known link fields are stored (junk dropped)', rec.p.pp === '400000' && rec.p.nm === 'Sam' && rec.p.evil === undefined && rec.by === 'lender', JSON.stringify(rec));
  r = await post(env, '/link-get', { id });
  check('reading a link returns its numbers', r.status === 200 && r.body.params.inc === '11000', JSON.stringify(r));
  {  /* co-borrower (Nov 16, 2026): nm2 is kept, capped at 40 characters like nm */
    const r2 = await post(env, '/link-create', { params: Object.assign({}, P, { nm2: 'Mike' + 'x'.repeat(60) }), pin: 'correct horse 42' });
    const rec2 = JSON.parse(env.LOOKUP_KV.m.get('link:' + r2.body.id));
    check('co-borrower name (nm2) is stored with the link, max 40 characters', r2.status === 200 && rec2.p.nm2 && rec2.p.nm2.startsWith('Mike') && rec2.p.nm2.length === 40, JSON.stringify(rec2.p.nm2));
  }
  r = await post(env, '/link-get', { id: 'Nope123456' });
  check('unknown/expired link → "expired"', r.status === 404 && r.body.error === 'expired');
  r = await post(env, '/link-get', { id: '../../etc' });
  check('malformed link id refused without a storage read', r.status === 404);
  r = await post(env, '/link-create', { params: P, pin: 'wrong' });
  check('wrong PIN refused', r.status === 401 && r.body.pin === false, JSON.stringify(r));
  for (let i = 0; i < 12; i++) r = await post(env, '/link-create', { params: P, pin: 'guess' + i });
  check('too many wrong PINs → locked for the hour (even the right one)', r.status === 429 && (await post(env, '/link-create', { params: P, pin: 'correct horse 42' })).status === 429, JSON.stringify(r));
  const env2 = baseEnv(); env2.LOOKUP_KV = fakeKV(); env2.LENDER_PIN = 'pin'; seedLender(env2);
  turnstileAnswer = { success: true, hostname: 'christoclose.github.io' };
  r = await post(env2, '/link-create', { params: P, turnstileToken: 'tok', from: LENDER_LINK });
  check('client Share with a human check gets a link', r.status === 200 && JSON.parse(env2.LOOKUP_KV.m.get('link:' + r.body.id)).by === 'client', JSON.stringify(r));
  r = await post(env2, '/link-create', { params: P });
  check('no PIN and no human check → refused', r.status === 403);
  turnstileAnswer = { success: false };
  r = await post(env2, '/link-create', { params: P, turnstileToken: 'bad' });
  check('failed human check → refused', r.status === 403);
  turnstileAnswer = { success: true, hostname: 'christoclose.github.io' };
  r = await post(env2, '/link-create', { params: { pp: '400000' }, turnstileToken: 'tok', from: LENDER_LINK });
  check('missing income/rate → refused', r.status === 400);
  const dayKey = [...env2.LOOKUP_KV.m.keys()].find((k) => k.startsWith('linkday:'));
  env2.LOOKUP_KV.m.set(dayKey, '300');
  r = await post(env2, '/link-create', { params: P, turnstileToken: 'tok', from: LENDER_LINK });
  check('client links capped at 300/day', r.status === 429);
  r = await post(env2, '/link-create', { params: P, pin: 'pin' });
  check('lender links are not affected by the client cap', r.status === 200);
  const big = await worker.fetch(new Request('https://w.example/link-create', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' }, body: JSON.stringify({ params: P, pin: 'x'.repeat(9000) }) }), env2, {});
  check('oversized request refused', big.status === 400);
  /* Save Scenario stores the PDF QR link under the id the page picked, only after a good send */
  const env3 = baseEnv(); env3.LOOKUP_KV = fakeKV(); seedLender(env3); emailsSent = 0;
  const sr = await worker.fetch(new Request('https://w.example/send-scenario', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ params: params('qr@example.com'), turnstileToken: 'tok', from: LENDER_LINK, linkId: 'QrLink2345', linkParams: P }) }), env3, {});
  check('Save Scenario stores the PDF QR link after sending', sr.status === 200 && emailsSent === 1 && JSON.parse(env3.LOOKUP_KV.m.get('link:QrLink2345') || '{}').by === 'save');
  const sr2 = await worker.fetch(new Request('https://w.example/send-scenario', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ params: params('qr2@example.com'), turnstileToken: 'tok', from: LENDER_LINK, linkId: 'QrLink2345', linkParams: { ...P, inc: '1' } }) }), env3, {});
  check('a Save can never overwrite an existing link', sr2.status === 200 && JSON.parse(env3.LOOKUP_KV.m.get('link:QrLink2345')).p.inc === '11000');
}

/* ── 16. calc.christoclose.com is allowed; look-alikes are not ── */
{
  const env4 = baseEnv(); env4.LOOKUP_KV = fakeKV(); seedLender(env4);
  const ask = (origin) => worker.fetch(new Request('https://w.example/link-get', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'Nothing234' }) }), env4, {});
  let r = await ask('https://calc.christoclose.com');
  check('calc.christoclose.com may call the Worker', r.status === 404 && r.headers.get('access-control-allow-origin') === 'https://calc.christoclose.com', r.status);
  r = await ask('https://christoclose.github.io');
  check('github.io still allowed', r.status === 404);
  for (const bad of ['https://evil.christoclose.com', 'https://calc.christoclose.com.evil.example', 'http://calc.christoclose.com']) {
    r = await ask(bad);
    check('look-alike refused: ' + bad, r.status === 403);
  }
  const pre = await worker.fetch(new Request('https://w.example/link-get', { method: 'OPTIONS', headers: { Origin: 'https://calc.christoclose.com' } }), env4, {});
  check('calc preflight ok', pre.status === 204);
  turnstileAnswer = { success: true, hostname: 'calc.christoclose.com' };
  r = await post(env4, '/link-create', { params: { pp: '400000', inc: '9000', rt: '6' }, turnstileToken: 'tok', from: LENDER_LINK });
  check('human check from calc.christoclose.com accepted', r.status === 200, r.status);
  turnstileAnswer = { success: true, hostname: 'christoclose.github.io' };
}

/* ── 17. D3 Option B (Chris, Nov 14): Save Scenario + client-made links only from a link Chris made ── */
{
  const SWITCH = /const LINK_REQUIRED = (true|false);/;
  check('Option B switch is in the Worker', SWITCH.test(src));
  check('Option B is switched ON (the live page, v8.45.0 on, sends its link)', LINK_REQUIRED_NOW);
  /* "strict" = this same Worker file with the switch ON; "lenient" = the same file with it OFF
     (the emergency off-switch). Both are tested whichever way the real switch is set. */
  const tmp2 = path.join(path.dirname(tmp), 'worker-strict.mjs');
  fs.writeFileSync(tmp2, src.replace(SWITCH, 'const LINK_REQUIRED = true;'));
  const strict = (await import(pathToFileURL(tmp2).href)).default;
  const tmp3 = path.join(path.dirname(tmp), 'worker-lenient.mjs');
  fs.writeFileSync(tmp3, src.replace(SWITCH, 'const LINK_REQUIRED = false;'));
  const lenient = (await import(pathToFileURL(tmp3).href)).default;
  const postTo = async (w, env, path_, body) => {
    const r = await w.fetch(new Request('https://w.example' + path_, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) }), env, {});
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const P = { pp: '400000', dp: '10', inc: '11000', dbt: '800', rt: '7', cn: 'Pinellas', mr: '17.43', nm: 'Sam' };
  const DAY = 86400000;
  turnstileAnswer = { success: true, hostname: 'christoclose.github.io' };

  /* Save Scenario */
  let env = baseEnv(); seedLender(env); emailsSent = 0;
  let r = await send(env, params('ob1@example.com'), 'tok', null, strict);
  check('B: Save without a link is refused, with "refresh" (old open pages)', r.status === 403 && r.body.code === 'refresh' && /refresh/i.test(r.body.error) && emailsSent === 0, JSON.stringify(r));
  check('B: a refused Save is not counted against anyone', env.EMAIL_LIMITS_KV.m.size === 0, [...env.EMAIL_LIMITS_KV.m.keys()].join(','));
  r = await send(env, params('ob1@example.com'), 'tok', 'Nope123456', strict);
  check('B: Save from an unknown / ended link is refused', r.status === 403 && r.body.code === 'link' && /ask Chris/.test(r.body.error) && emailsSent === 0, JSON.stringify(r));
  for (const bad of ['../../etc', 'short', 12345, { id: LENDER_LINK }, [LENDER_LINK], true]) {
    r = await send(env, params('ob1@example.com'), 'tok', bad, strict);
    check('B: Save with a malformed link (' + JSON.stringify(bad) + ') is refused', r.status === 403 && emailsSent === 0, JSON.stringify(r));
  }
  r = await send(env, params('ob1@example.com'), 'tok', LENDER_LINK, strict);
  check('B: Save from a link Chris made goes through', r.status === 200 && r.body.ok && emailsSent === 1, JSON.stringify(r));
  turnstileAnswer = { success: false };
  r = await send(env, params('ob2@example.com'), 'bad', LENDER_LINK, strict);
  check('B: a good link does not replace the human check', r.status === 403 && emailsSent === 1, JSON.stringify(r));
  turnstileAnswer = { success: true, hostname: 'christoclose.github.io' };
  const envNoKv = baseEnv(); emailsSent = 0;
  r = await send(envNoKv, params('ob3@example.com'), 'tok', LENDER_LINK, strict);
  check('B: no link storage = refuse (fail closed)', r.status === 403 && emailsSent === 0, JSON.stringify(r));

  /* Client-made links (Share) */
  env = baseEnv(); env.LENDER_PIN = 'pin'; seedLender(env, LENDER_LINK, 80);   // Chris's link is 80 days old → 10 days left
  r = await postTo(strict, env, '/link-create', { params: P, turnstileToken: 'tok' });
  check('B: Share without a link is refused', r.status === 403 && r.body.code === 'refresh', JSON.stringify(r));
  r = await postTo(strict, env, '/link-create', { params: P, turnstileToken: 'tok', from: 'Nope123456' });
  check('B: Share from an unknown link is refused', r.status === 403 && r.body.code === 'link', JSON.stringify(r));
  r = await postTo(strict, env, '/link-create', { params: P, turnstileToken: 'tok', from: LENDER_LINK, by: 'lender', root: 'Attacker01' });
  const child = r.body.id; const childRec = child ? JSON.parse(env.LOOKUP_KV.m.get('link:' + child)) : {};
  check('B: Share from Chris\'s link works and remembers it as the root', r.status === 200 && childRec.by === 'client' && childRec.root === LENDER_LINK, JSON.stringify([r, childRec]));
  const childTtl = env.LOOKUP_KV.ttl.get('link:' + child);
  check('B: a shared link ends when Chris\'s link ends (10 days left, not a fresh 90)', childTtl > 9.9 * 86400 && childTtl <= 10 * 86400, 'ttl seconds: ' + childTtl);
  check('B: the reply says when the shared link ends', Math.abs(new Date(r.body.expires).getTime() - (Date.now() + 10 * DAY)) < 60000, r.body.expires);
  r = await postTo(strict, env, '/link-create', { params: P, turnstileToken: 'tok', from: child });
  const grand = r.body.id; const grandRec = grand ? JSON.parse(env.LOOKUP_KV.m.get('link:' + grand)) : {};
  check('B: a share of a share still traces back to Chris\'s link', r.status === 200 && grandRec.root === LENDER_LINK && env.LOOKUP_KV.ttl.get('link:' + grand) <= 10 * 86400, JSON.stringify([r, grandRec]));
  emailsSent = 0;
  r = await send(env, params('ob4@example.com'), 'tok', child, strict);
  check('B: Save from a shared link works while Chris\'s link is alive', r.status === 200 && emailsSent === 1, JSON.stringify(r));
  r = await postTo(strict, env, '/link-create', { params: P, pin: 'pin' });
  check('B: Chris (PIN) can always make a link, no "from" needed', r.status === 200 && JSON.parse(env.LOOKUP_KV.m.get('link:' + r.body.id)).by === 'lender' && env.LOOKUP_KV.ttl.get('link:' + r.body.id) === 90 * 86400, JSON.stringify(r));

  /* Save's QR link also carries the root */
  const sr = await strict.fetch(new Request('https://w.example/send-scenario', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ params: params('ob5@example.com'), turnstileToken: 'tok', from: child, linkId: 'QrLinkB234', linkParams: P }) }), env, {});
  const qrRec = JSON.parse(env.LOOKUP_KV.m.get('link:QrLinkB234') || '{}');
  check('B: the PDF QR link from a Save traces back to Chris\'s link and ends with it', sr.status === 200 && qrRec.by === 'save' && qrRec.root === LENDER_LINK && env.LOOKUP_KV.ttl.get('link:QrLinkB234') <= 10 * 86400, JSON.stringify(qrRec));

  /* Links that do NOT come from Chris */
  env.LOOKUP_KV.m.set('link:OldShare01', JSON.stringify({ p: P, by: 'client', created: Date.now() }));                       // made before Option B (no root)
  env.LOOKUP_KV.m.set('link:SelfRoot01', JSON.stringify({ p: P, by: 'client', created: Date.now(), root: 'SelfRoot01' }));   // points at itself
  env.LOOKUP_KV.m.set('link:FakeRoot01', JSON.stringify({ p: P, by: 'client', created: Date.now(), root: 'OldShare01' }));   // points at a non-lender link
  env.LOOKUP_KV.m.set('link:BrokenRec1', '{not json');
  emailsSent = 0;
  for (const id of ['OldShare01', 'SelfRoot01', 'FakeRoot01', 'BrokenRec1']) {
    r = await send(env, params('ob6@example.com'), 'tok', id, strict);
    const c = await postTo(strict, env, '/link-create', { params: P, turnstileToken: 'tok', from: id });
    check('B: link ' + id + ' (not from Chris) can\'t Save or Share', r.status === 403 && r.body.code === 'link' && c.status === 403 && emailsSent === 0, JSON.stringify([r, c]));
  }
  r = await postTo(strict, env, '/link-get', { id: 'OldShare01' });
  check('B: such a link can still be opened and read', r.status === 200 && r.body.params.inc === '11000', JSON.stringify(r));

  /* When Chris's link is gone, shares of it stop too */
  env.LOOKUP_KV.m.delete('link:' + LENDER_LINK); emailsSent = 0;
  r = await send(env, params('ob7@example.com'), 'tok', child, strict);
  check('B: once Chris\'s link has ended, its shares can\'t Save', r.status === 403 && r.body.code === 'link' && emailsSent === 0, JSON.stringify(r));
  seedLender(env, LENDER_LINK, 90);   // exactly at its 90 days: nothing left
  r = await send(env, params('ob7@example.com'), 'tok', LENDER_LINK, strict);
  check('B: a link Chris made that is past its 90 days is refused even if still stored', r.status === 403 && emailsSent === 0, JSON.stringify(r));

  /* The emergency off-switch: with the switch OFF, a page that sends no link works again,
     and a link that IS sent is still checked */
  {
    env = baseEnv(); env.LENDER_PIN = 'pin'; seedLender(env); emailsSent = 0;
    r = await send(env, params('ob8@example.com'), 'tok', null, lenient);
    check('B off: Save without a link works', r.status === 200 && emailsSent === 1, JSON.stringify(r));
    r = await send(env, params('ob9@example.com'), 'tok', 'Nope123456', lenient);
    check('B off: a link that IS sent is still checked', r.status === 403 && r.body.code === 'link' && emailsSent === 1, JSON.stringify(r));
    r = await postTo(lenient, env, '/link-create', { params: P, turnstileToken: 'tok' });
    check('B off: Share without a link works', r.status === 200 && JSON.parse(env.LOOKUP_KV.m.get('link:' + r.body.id)).root === undefined, JSON.stringify(r));
    r = await postTo(lenient, env, '/link-create', { params: P, turnstileToken: 'tok', from: LENDER_LINK });
    check('B off: a page that sends its link still gets the root', r.status === 200 && JSON.parse(env.LOOKUP_KV.m.get('link:' + r.body.id)).root === LENDER_LINK, JSON.stringify(r));
  }
  /* And the Worker exactly as it is deployed behaves like "strict" */
  if (LINK_REQUIRED_NOW) {
    env = baseEnv(); env.LENDER_PIN = 'pin'; seedLender(env); emailsSent = 0;
    r = await send(env, params('ob10@example.com'), 'tok', null);
    check('B on (as deployed): Save without a link is refused with "please refresh"', r.status === 403 && r.body.code === 'refresh' && emailsSent === 0, JSON.stringify(r));
    r = await post(env, '/link-create', { params: P, turnstileToken: 'tok' });
    check('B on (as deployed): Share without a link is refused with "please refresh"', r.status === 403 && r.body.code === 'refresh', JSON.stringify(r));
    r = await send(env, params('ob11@example.com'), 'tok', LENDER_LINK);
    check('B on (as deployed): Save from a link Chris made sends the email', r.status === 200 && emailsSent === 1, JSON.stringify(r));
  }
  console.log('Link from Chris required (Option B): ' + (LINK_REQUIRED_NOW ? 'YES' : 'NO (emergency off-switch is set)'));
}

/* 20. Saved clients (Chris, Nov 16, 2026): up to 5, behind the PIN, only the client's profile kept */
{
  const env = baseEnv(); env.LOOKUP_KV = fakeKV(); env.LENDER_PIN = 'correct horse 42';
  const PIN = 'correct horse 42';
  let r = await post(env, '/clients', { pin: 'wrong', action: 'list' });
  check('saved clients: wrong PIN refused', r.status === 401 && !r.body.clients, JSON.stringify(r));
  r = await post(env, '/clients', { action: 'list' });
  check('saved clients: no PIN refused', r.status === 401, JSON.stringify(r));
  r = await post(env, '/clients', { pin: PIN, action: 'list' });
  check('saved clients: empty list to start, 5 spots', r.status === 200 && r.body.clients.length === 0 && r.body.slots === 5, JSON.stringify(r));
  const sarah = { nm: 'Sarah', nm2: 'Mike', inc: 9000, debts: [400, 24, 80, 119, -5, 'x'], lt: 'FHA', tm: 30, rt: 6.375, fco: 700, ren: false,
                  email: 'leak@example.com', address: '1 Main St', tax: 999, evil: '<script>' };
  r = await post(env, '/clients', { pin: PIN, action: 'save', client: sarah });
  const saved = r.body.clients && r.body.clients[0];
  check('saved clients: save keeps name, co-borrower, income, each debt, loan type, rate, credit score', r.status === 200 && saved.nm === 'Sarah' && saved.nm2 === 'Mike' && saved.inc === 9000 && saved.debts.join(',') === '400,24,80,119' && saved.lt === 'FHA' && saved.rt === 6.375 && saved.fco === 700 && /^[A-Za-z0-9]{8}$/.test(saved.id), JSON.stringify(r));
  check('saved clients: anything else (email, address, tax, junk) is NOT stored', saved && saved.email === undefined && saved.address === undefined && saved.tax === undefined && saved.evil === undefined && !env.LOOKUP_KV.m.get('lo-clients').includes('leak@'), JSON.stringify(saved));
  r = await post(env, '/clients', { pin: PIN, action: 'save', id: saved.id, client: Object.assign({}, sarah, { inc: 9500, debts: [400, 30] }) });
  check('saved clients: saving with the same id updates, not adds', r.status === 200 && r.body.clients.length === 1 && r.body.clients[0].inc === 9500 && r.body.clients[0].debts.join(',') === '400,30', JSON.stringify(r.body));
  {  /* down payment (Nov 18, 2026): kept to the half percent, 0-50; junk or missing = not set */
    const d = async (dp) => { const e2 = baseEnv(); e2.LOOKUP_KV = fakeKV(); e2.LENDER_PIN = PIN; const x = await post(e2, '/clients', { pin: PIN, action: 'save', client: { nm: 'D', dp } }); return x.body.clients[0].dp; };
    const got = [await d(10), await d(3.5), await d(0), await d('12.5'), await d(80), await d(-1), await d('abc'), await d(undefined)];
    check('saved clients: down payment % kept (10, 3.5, 0, 12.5); out of range or junk = not set', JSON.stringify(got) === JSON.stringify([10, 3.5, 0, 12.5, null, null, null, null]), JSON.stringify(got));
  }
  r = await post(env, '/clients', { pin: PIN, action: 'save', client: { inc: 5000 } });
  check('saved clients: a client with no name is refused', r.status === 400, JSON.stringify(r));
  r = await post(env, '/clients', { pin: PIN, action: 'save', client: { nm: '<b>Bob</b>', inc: 'lots', rt: 99, lt: 'JUMBO', tm: 7, fco: 1 } });
  const bob = r.body.clients && r.body.clients[1];
  check('saved clients: bad values are cleaned (no tags, 0 income, no rate, CONV, 30 yr, 760)', bob && bob.nm === 'bBob/b' && bob.inc === 0 && bob.rt === null && bob.lt === 'CONV' && bob.tm === 30 && bob.fco === 760, JSON.stringify(bob));
  for (const n of ['C3', 'C4', 'C5']) await post(env, '/clients', { pin: PIN, action: 'save', client: { nm: n, inc: 1 } });
  r = await post(env, '/clients', { pin: PIN, action: 'save', client: { nm: 'Sixth', inc: 1 } });
  check('saved clients: a 6th client is refused with "spots are full"', r.status === 409 && r.body.full === true && /full/.test(r.body.error), JSON.stringify(r));
  r = await post(env, '/clients', { pin: PIN, action: 'delete', id: saved.id });
  check('saved clients: delete removes just that one', r.status === 200 && r.body.clients.length === 4 && !r.body.clients.some((c) => c.id === saved.id), JSON.stringify(r.body));
  r = await post(env, '/clients', { pin: PIN, action: 'save', client: { nm: 'Sixth', inc: 1 } });
  check('saved clients: after a delete there is room again', r.status === 200 && r.body.clients.length === 5, JSON.stringify(r.body));
  r = await post(env, '/clients', { pin: PIN, action: 'nuke' });
  check('saved clients: unknown action refused', r.status === 400);
  for (let i = 0; i < 12; i++) r = await post(env, '/clients', { pin: 'guess' + i, action: 'list' });
  check('saved clients: guessing the PIN locks out for the hour (even the right PIN)', r.status === 429 && (await post(env, '/clients', { pin: PIN, action: 'list' })).status === 429, JSON.stringify(r));
}

if (failures.length) {
  console.log(`\nWORKER TESTS FAILED — ${failures.length}:`);
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('\nWORKER TESTS PASSED — Save Scenario: human check, 5/hour + 15/day per recipient, 50/day site, duplicates, fail-closed; links from Chris only (Option B rule tested on and off).');
