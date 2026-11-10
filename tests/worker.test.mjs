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
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.has(k) ? m.get(k) : null; return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
  };
}
const okLimiter = { limit: async () => ({ success: true }) };

let n = 0;
function params(to, extra) {
  return { to_email: to, scenario_label: 'Test ' + (++n), property_address: '1 Main St', housing_payment: '$3,000', ...extra };
}
async function send(env, p, token) {
  const body = { params: p };
  if (token !== undefined) body.turnstileToken = token;
  const r = await worker.fetch(new Request('https://w.example/send-scenario', {
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

if (failures.length) {
  console.log(`\nWORKER TESTS FAILED — ${failures.length}:`);
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('\nWORKER TESTS PASSED — Save Scenario: human check, 5/hour + 15/day per recipient, 50/day site, duplicates, fail-closed.');
