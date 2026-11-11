/* ============================================================
   DTI CALCULATOR — MATH SAFETY NET
   Run:            node tests/run.js            (tests preview/index.html)
                   node tests/run.js --page index.html   (tests the live copy)
   Re-lock values: node tests/run.js --update   (ONLY after a
                   deliberate, reviewed change to the numbers)

   Opens index.html in a hidden browser (no internet needed) and
   for every scenario in tests/scenarios.js checks that:
     A. the math engine matches the locked numbers (to the cent)
     B. the math engine matches the independent reference math
     C. the lender screen shows exactly the locked values
     D. the client link built from the lender screen opens a
        client screen showing exactly the locked values
     E. lender and client screens agree on payment and DTI
     F. the lender can only make a client link when a county (or an
        actual tax bill) is set; without one, the client screen waits
        for a location and Save Scenario is refused (B9)
     G. the version number shown on both screens comes from the single
        CONFIG.version setting, with no hand-typed copies left (P1.4)
     H. no-PDF fallback shows plain text (Q4)   I. outside scripts have SRI (Q8)
     J. client links (Q1): impossible values show the "link problem"
        screen (no payment), and real zeros stay zero
     K. Save Scenario (Q7) sends the Turnstile token, and sends nothing
        when the check can't load. Worker side: tests/worker.test.mjs
     L. Realie fallback (C6): a public-record bill is guidance only; one tap
        uses it, one tap switches back; the 4 county lookups still auto-fill
     M. Q5: a county record that isn't an exact match asks "Is this the right
        property?" and fills nothing until the client says yes
     N. ADDR1: typing in the tax lookup shows Google address suggestions;
        picking one fills street, city, county and unit
     O. Help: "?" opens the full help guide (not the welcome popup), no outdated text
     P. UX: phone Back closes the guide/welcome, swipe closes the guide, skeleton while loading
     Q. Q2: Chris's PMI quote scales with the client's price and down payment
     R. Q3: Share link + PDF QR reopen exactly the client's screen
     S. Bug hunt: night-mode amounts, no stray payment-card tags, rental line hides
     T. Floating ? / night-day buttons never cover the payment card; header ? on small phones
     U. Fonts load only from this site (no Google / outside font servers); title fonts preloaded, no swap jump
     W. Short client links (S5): lender PIN, short link = same screen, Share + PDF QR short, long links + unknown ids expired;
        lender lock screen (plain visit without the PIN sees no setup; wrong/old PIN stays locked)
   Exit code 0 = all good, 1 = something changed.
   ============================================================ */

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { reference } = require('./reference');
const scenarios = require('./scenarios');

const ROOT = path.resolve(__dirname, '..');
// Which copy to test: --page <file>. Default = the preview copy (where changes
// are made first); the publish step tests it again before copying it live.
const pageArg = process.argv.indexOf('--page');
const PAGE_FILE = pageArg !== -1 ? process.argv[pageArg + 1]
  : fs.existsSync(path.join(ROOT, 'preview', 'index.html')) ? 'preview/index.html' : 'index.html';
const PAGE = 'file://' + path.resolve(ROOT, PAGE_FILE);
const EXPECTED_FILE = path.join(__dirname, 'expected.json');
const UPDATE = process.argv.includes('--update');
const FIXED_DATE = 'Oct 28, 2026';   // keeps date text on screens stable
const CENT = 0.005;

/* Known differences between lender and client screens (bugs already on
   the master list). They are reported but don't fail the run. If one
   disappears, the run says so — then remove it from this list. */
const KNOWN_SCREEN_DIFFS = {
  // (empty) B5 fixed in v8.30.7 by Q1 — VA/USDA 0% down now stays 0%.
};

const ENGINE_FIELDS = ['loanAmt', 'ufmip', 'pi', 'monthlyTax', 'monthlyIns', 'monthlyMI',
  'housingPayment', 'rentalShortfall', 'frontDTI', 'backDTI', 'overallStatus', 'isJumbo'];

const LENDER_IDS = /^(br-|lbr-|lender-|front-dti|back-dti|dti-status|tax-val|tax-badge|ins-val|ins-badge|pmi-|mip-val|usda-val|price-val|down-|jumbo-)/;
const CLIENT_IDS = /^(client-|cbr-|mini-)/;

function round(v) {
  return typeof v === 'number' ? Math.round(v * 100) / 100 : v;
}

function pickEngine(r) {
  if (r && r.error) return { error: r.error };
  const o = {};
  for (const k of ENGINE_FIELDS) o[k] = round(r[k]);
  return o;
}

function sameNumber(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= CENT;
  return a === b;
}

/* Reads every visible on-screen value whose id matches the pattern. */
async function readScreen(page, pattern) {
  return page.evaluate((src) => {
    const re = new RegExp(src);
    const out = {};
    document.querySelectorAll('[id]').forEach((el) => {
      if (!re.test(el.id) || el.children.length) return;
      if (el.checkVisibility && !el.checkVisibility()) return;
      const t = el.textContent.replace(/\s+/g, ' ').trim();
      if (t && t.length <= 160) out[el.id] = t;
    });
    return out;
  }, pattern.source);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ timezoneId: 'America/New_York', locale: 'en-US' });
  // Block everything outside the local file: no fonts, CDNs, or Worker calls.
  const outsideCalls = [];
  await context.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith('file:')) return r.continue();
    outsideCalls.push(u);
    return r.abort();
  });

  const pageErrors = [];
  const lender = await context.newPage();
  lender.on('pageerror', (e) => pageErrors.push('lender: ' + e.message));
  await lender.goto(PAGE);
  await lender.waitForFunction(() => typeof calcAll === 'function' && typeof S === 'object');
  await lender.evaluate(() => { window.__S0 = JSON.parse(JSON.stringify(S)); });

  const client = await context.newPage();
  client.on('pageerror', (e) => pageErrors.push('client: ' + e.message));

  /* G. version: one setting, shown everywhere it appears */
  async function checkVersion(page, where) {
    const v = await page.evaluate(() => {
      const shown = [...document.querySelectorAll('.app-version')].map((e) => e.textContent.trim());
      const all = (document.documentElement.outerHTML.match(/v\d+\.\d+\.\d+/g) || []);
      return { cfg: CONFIG.version, shown, all };
    });
    const want = 'v' + v.cfg;
    if (!/^\d+\.\d+\.\d+$/.test(v.cfg || '')) failures.push(`${where}: CONFIG.version is missing or malformed (${v.cfg})`);
    if (!v.shown.length) failures.push(`${where}: no version label on the page`);
    v.shown.filter((t) => t !== want).forEach((t) => failures.push(`${where}: version label shows "${t}" but CONFIG.version is ${want}`));
    v.all.filter((t) => t !== want).forEach((t) => failures.push(`${where}: hand-typed version "${t}" found in the page — set it only in CONFIG.version`));
    return want;
  }
  const failures = [];
  const lenderVersion = await checkVersion(lender, 'lender page');
  let clientVersionChecked = false;

  const expected = fs.existsSync(EXPECTED_FILE) ? JSON.parse(fs.readFileSync(EXPECTED_FILE, 'utf8')) : {};
  const actual = {};
  const notes = [];

  for (const sc of scenarios) {
    // Lender screen: reset to starting values, apply scenario, redraw.
    const run = await lender.evaluate(({ input, date }) => {
      Object.assign(S, JSON.parse(JSON.stringify(window.__S0)), { clientName: 'Test' }, input);
      refreshAll();
      const engine = calcAll({
        income: S.income, otherDebts: S.otherDebts, rate: S.rate, loanType: S.loanType,
        purchasePrice: S.purchasePrice, downPct: S.downPct, termYears: S.termYears,
        hoa: S.hoa, floodActive: S.floodActive, floodIns: S.floodIns,
        cddActive: S.cddActive, cddAnnual: S.cddAnnual,
        countyMillRate: S.countyMillRate, pmiOverride: S.pmiOverride, ficoVal: S.ficoVal,
        rentalActive: S.rentalActive, grossRent: S.grossRent, departingPitia: S.departingPitia,
        taxOverride: S.taxOverride, insOverride: S.insOverride, homestead: S.homestead,
      });
      const url = new URL(buildClientUrl());
      url.searchParams.set('ts', date);
      const state = JSON.parse(JSON.stringify(S));
      return { engine, url: url.toString(), state };
    }, { input: sc.in, date: FIXED_DATE });

    const engine = pickEngine(run.engine);
    const ref = pickEngine(reference(run.state));
    const rec = { engine };

    // B. engine vs independent reference
    for (const k of Object.keys(ref)) {
      if (!sameNumber(engine[k], ref[k])) {
        failures.push(`${sc.id}: math engine ${k} = ${engine[k]}, reference math says ${ref[k]}`);
      }
    }

    if (!sc.engineOnly) {
      rec.lenderScreen = await readScreen(lender, LENDER_IDS);
      rec.linkAllowed = await lender.evaluate(() => validateSetup());
      rec.clientLink = new URL(run.url).search;
      await client.goto(run.url);
      await client.waitForFunction(() => document.getElementById('client-back-dti'));
      rec.clientScreen = await readScreen(client, CLIENT_IDS);
      if (!clientVersionChecked) { await checkVersion(client, 'client page'); clientVersionChecked = true; }

      // F. location rule
      const hasLocation = run.state.countyMillRate != null || run.state.taxOverride != null;
      if (rec.linkAllowed !== hasLocation) {
        failures.push(`${sc.id}: lender ${rec.linkAllowed ? 'ALLOWED' : 'REFUSED'} a client link ${hasLocation ? 'with' : 'without'} a county`);
      }
      if (sc.clientWaitsForLocation) {
        const c = rec.clientScreen;
        if (c['client-back-dti'] !== '—' || c['client-housing-total'] !== '—' || c['client-status-badge'] !== 'Enter your location to get started') {
          failures.push(`${sc.id}: client screen should wait for a location but shows ${c['client-housing-total']} / ${c['client-back-dti']} / "${c['client-status-badge']}"`);
        }
        const save = await client.evaluate(() => {
          document.getElementById('save-email').value = 'test@example.com';
          document.getElementById('save-label').value = 'Test';
          document.getElementById('save-address').value = '1 Main St';
          document.getElementById('btn-save-scenario').click();
          return document.getElementById('save-error').textContent;
        });
        await client.waitForTimeout(200);
        if (!/Pick the property location/.test(save) || outsideCalls.some((u) => /send-scenario/.test(u))) {
          failures.push(`${sc.id}: Save Scenario was not refused without a location (message: "${save}")`);
        }
      }

      // E. lender vs client agreement (skipped when the client is waiting for a location)
      const pairs = [['lbr-housing', 'client-housing-total'], ['lender-front-dti', 'client-front-dti'], ['lender-back-dti', 'client-back-dti']];
      const mismatched = sc.clientWaitsForLocation ? [] : pairs.filter(([l, c]) => rec.lenderScreen[l] !== rec.clientScreen[c]);
      const known = KNOWN_SCREEN_DIFFS[sc.id];
      if (mismatched.length && !known) {
        for (const [l, c] of mismatched) {
          failures.push(`${sc.id}: lender shows ${l} = ${rec.lenderScreen[l]} but client shows ${c} = ${rec.clientScreen[c]}`);
        }
      } else if (mismatched.length && known) {
        notes.push(`${sc.id}: lender and client screens differ — known issue ${known}`);
      } else if (!mismatched.length && known) {
        notes.push(`${sc.id}: lender and client now AGREE — ${known.split(' ')[0]} looks fixed; remove it from KNOWN_SCREEN_DIFFS`);
      }
    }

    actual[sc.id] = rec;

    // A, C, D. compare with locked values
    const exp = expected[sc.id];
    if (!UPDATE) {
      if (!exp) { failures.push(`${sc.id}: no locked values yet (run with --update once)`); continue; }
      for (const k of Object.keys({ ...exp.engine, ...engine })) {
        if (!sameNumber(engine[k], exp.engine[k])) failures.push(`${sc.id}: math engine ${k} was ${exp.engine[k]}, now ${engine[k]}`);
      }
      for (const part of ['lenderScreen', 'clientScreen']) {
        if (!exp[part] && !rec[part]) continue;
        const a = rec[part] || {}, e = exp[part] || {};
        for (const id of new Set([...Object.keys(a), ...Object.keys(e)])) {
          if (a[id] !== e[id]) {
            const where = part === 'lenderScreen' ? 'lender screen' : 'client screen';
            failures.push(`${sc.id}: ${where} "${id}" was ${JSON.stringify(e[id])}, now ${JSON.stringify(a[id])}`);
          }
        }
      }
      if (exp.clientLink !== rec.clientLink) {
        failures.push(`${sc.id}: client link changed\n    was ${exp.clientLink}\n    now ${rec.clientLink}`);
      }
    }
  }

  /* I. Q8: every outside script must carry an integrity hash */
  // Exception: Cloudflare Turnstile (Q7) changes on Cloudflare's side and can't carry a hash.
  const noSri = await lender.evaluate(() => [...document.querySelectorAll('script[src]')]
    .filter((s) => /^https?:/.test(s.src) && !/^https:\/\/challenges\.cloudflare\.com\/turnstile\//.test(s.src) && !/^sha(256|384|512)-/.test(s.getAttribute('integrity') || ''))
    .map((s) => s.src));
  noSri.forEach((u) => failures.push(`outside script without an integrity hash: ${u}`));

  /* H. Q4: if the PDF library is missing, the fallback shows text, never HTML from the link */
  await client.goto(PAGE + '?client=1&pp=400000&inc=11000&dbt=800&rt=7&cn=Pinellas%3Cb%20id%3Dinj%3EX%3C%2Fb%3E&mr=17.43&ts=x&nm=Test');
  const fb = await client.evaluate(async () => {
    window.jspdf = undefined; let d = null;
    window.open = () => { d = document.implementation.createHTMLDocument('x'); return { document: d, print: () => {} }; };
    window.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    document.getElementById('save-email').value = 'a@example.com';
    document.getElementById('save-label').value = 'x';
    document.getElementById('save-address').value = '1 Main St';
    document.getElementById('btn-save-scenario').click();
    await new Promise((r) => setTimeout(r, 400));
    return { opened: !!d, injected: !!(d && d.getElementById('inj')), hasText: !!(d && /Pinellas<b/.test(d.body.textContent)) };
  });
  if (!fb.opened || fb.injected || !fb.hasText) failures.push(`PDF fallback: ${JSON.stringify(fb)} (expected plain text, no HTML element)`);

  /* J. Q1: link reader — bad links refused, real zeros kept */
  const BASE = PAGE + '?client=1&pp=400000&inc=11000&dbt=800&rt=7&cn=Pinellas&mr=17.43&ts=x&nm=Test';
  const badLinks = {
    'negative tax': BASE + '&tax=-10000',
    'unknown loan type': BASE + '&lt=BAD',
    'price is text': BASE.replace('pp=400000', 'pp=abc'),
    'income missing': BASE.replace('inc=11000&', ''),
    'rate missing': BASE.replace('rt=7&', ''),
    'down payment 100%': BASE + '&dp=100',
    'unknown FICO tier': BASE + '&fco=999',
    'negative HOA': BASE + '&hoa=-50',
  };
  for (const [name, url] of Object.entries(badLinks)) {
    await client.goto(url);
    const r = await client.evaluate(() => ({
      problem: !!document.getElementById('link-problem'),
      calcShown: document.getElementById('client-page').style.display !== 'none',
      helpShown: getComputedStyle(document.getElementById('help-btn')).display !== 'none',
    }));
    if (!r.problem || r.calcShown || r.helpShown) failures.push(`Q1 bad link (${name}): expected the "link problem" screen, got ${JSON.stringify(r)}`);
  }
  const zeroChecks = [
    ['VA 0% down', BASE + '&lt=VA&dp=0', 'client-down-pct', '0%'],
    ['USDA 0% down', BASE + '&lt=USDA&dp=0', 'client-down-pct', '0%'],
    ['0% rate shown', BASE.replace('rt=7', 'rt=0') + '&rr=1', 'client-rate-display', '0.000%'],
    ['$0 flood', BASE + '&fld=1&fi=0', 'client-flood-val', '$0/mo'],
  ];
  for (const [name, url, id, want] of zeroChecks) {
    await client.goto(url);
    const got = await client.evaluate((i) => ({
      text: (document.getElementById(i) || {}).textContent,
      problem: !!document.getElementById('link-problem'),
      sliderMin: document.getElementById('client-down').min,
      minLabel: (document.getElementById('client-down-min-label') || {}).textContent,
    }), id);
    if (got.problem || got.text !== want) failures.push(`Q1 zero kept (${name}): ${id} = ${JSON.stringify(got.text)}, expected "${want}"${got.problem ? ' (link problem screen shown)' : ''}`);
    if (/0% down/.test(name) && (got.sliderMin !== '0' || got.minLabel !== '0%')) failures.push(`Q1 ${name}: down-payment slider starts at ${got.sliderMin}% (label "${got.minLabel}"), expected 0%`);
  }
  // A normal link must NOT show the problem screen
  await client.goto(BASE);
  if (await client.evaluate(() => !!document.getElementById('link-problem'))) failures.push('Q1: a normal link showed the "link problem" screen');

  /* K. Q7: Save Scenario sends the human-check token; if the check can't load, nothing is sent */
  await client.goto(BASE);
  const k = await client.evaluate(async () => {
    const sent = [];
    window.fetch = async (u, o) => { sent.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true }) }; };
    window.open = () => ({ document: document.implementation.createHTMLDocument('x'), print: () => {} });
    const fill = () => {
      document.getElementById('save-email').value = 'a@example.com';
      document.getElementById('save-label').value = 'x';
      document.getElementById('save-address').value = '1 Main St';
      const b = document.getElementById('btn-save-scenario'); b.disabled = false; b.style.display = '';
      b.click();
    };
    const wait = () => new Promise((r) => setTimeout(r, 300));
    CONFIG.turnstileSiteKey = 'test-site-key';
    tsLoadFailed = true;                       // check failed to load
    fill(); await wait();
    const blocked = { sent: sent.length, msg: document.getElementById('save-error').textContent };
    tsLoadFailed = false; tsWidgetId = 1;       // check works
    window.turnstile = { reset() {}, execute() { setTimeout(() => { const p = tsPending; tsPending = null; p.resolve('TOKEN123'); }, 10); } };
    fill(); await wait();
    return { blocked, token: sent.length ? sent[sent.length - 1].turnstileToken : null, total: sent.length };
  });
  if (k.blocked.sent !== 0 || !/security check/.test(k.blocked.msg)) failures.push(`Q7: when the human check can't load, Save Scenario must not send (sent ${k.blocked.sent}, message "${k.blocked.msg}")`);
  if (k.token !== 'TOKEN123' || k.total !== 1) failures.push(`Q7: Save Scenario did not pass the human-check token to the Worker (${JSON.stringify(k)})`);

  /* L. Realie fallback (C6): owner's bill is guidance only; "use it" needs a confirm; county lookups unchanged */
  await client.goto(BASE);
  const L = await client.evaluate(async () => {
    const out = {};
    const sel = document.getElementById('realie-county');
    out.countyOptions = [...sel.options].filter((o) => o.value).length;
    const reply = (obj) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    const taxShown = () => document.getElementById('client-tax-override').value;
    document.getElementById('realie-address').value = '1 Test St';
    // public-record (Realie) answer
    window.fetch = reply({ source: 'realie', guidance_only: true, annual_tax: 3911.5, tax_year: 2024, county: 'Broward', address_confirmed: '1 TEST ST', is_homesteaded: true });
    sel.value = 'Broward';
    await lookupRealieAddress();
    out.afterGuidance = taxShown();
    out.guidanceVisible = document.getElementById('realie-guidance').style.display === 'block';
    document.getElementById('realie-use-btn').click();
    out.afterUse = taxShown();
    out.btnAfterUse = document.getElementById('realie-use-btn').textContent;
    document.getElementById('realie-use-btn').click();
    out.afterSwitchBack = taxShown();
    out.btnAfterBack = document.getElementById('realie-use-btn').textContent;
    // county lookup answer (Pinellas) still auto-fills
    document.getElementById('client-tax-override').value = '';
    window.fetch = reply({ annual_tax: 4468, tax_year: 2025, county: 'Pinellas', address_confirmed: '4900 BRITTANY DR S UNIT 1808' });
    sel.value = 'Pinellas';
    await lookupRealieAddress();
    out.countyFill = taxShown();
    out.guidanceHiddenForCounty = document.getElementById('realie-guidance').style.display === 'none';
    return out;
  });
  if (L.countyOptions !== 67) failures.push(`C6: tax-lookup county list should have all 67 Florida counties, has ${L.countyOptions}`);
  if (L.afterGuidance !== '' || !L.guidanceVisible) failures.push(`C6: public-record bill must be guidance only (tax box "${L.afterGuidance}", guidance shown ${L.guidanceVisible})`);
  if (L.afterUse !== '325.96' || L.btnAfterUse !== 'Switch back to my estimate') failures.push(`C6: one tap on "Use this number instead" should set 325.96/mo and offer "Switch back" (got "${L.afterUse}", button "${L.btnAfterUse}")`);
  if (L.afterSwitchBack !== '' || L.btnAfterBack !== 'Use this number instead') failures.push(`C6: "Switch back to my estimate" should clear the owner's bill (got "${L.afterSwitchBack}", button "${L.btnAfterBack}")`);
  if (L.countyFill !== '372.33' || !L.guidanceHiddenForCounty) failures.push(`C6: county lookups must still auto-fill (got "${L.countyFill}") and hide the guidance note`);

  /* M. Q5: a county record that isn't an exact match is never used without the client's OK */
  await client.goto(BASE);
  const M = await client.evaluate(async () => {
    const out = {};
    const reply = (obj) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    const tax = () => document.getElementById('client-tax-override').value;
    document.getElementById('realie-address').value = '100 Main St';
    document.getElementById('realie-county').value = 'Pinellas';
    const near = { annual_tax: 4800, tax_year: 2025, county: 'Pinellas', address_confirmed: '100 MAIN AVE, ST PETERSBURG, FL', needs_confirmation: true, confirm_reason: 'street differs' };
    window.fetch = reply(near);
    await lookupRealieAddress();
    out.askShown = document.getElementById('tax-confirm-box').style.display === 'block';
    out.foundText = document.getElementById('tax-confirm-found').textContent;
    out.beforeYes = tax();
    document.getElementById('tax-confirm-no').click();
    out.afterNo = tax();
    out.askHiddenAfterNo = document.getElementById('tax-confirm-box').style.display === 'none';
    await lookupRealieAddress();
    document.getElementById('tax-confirm-yes').click();
    out.afterYes = tax();
    document.getElementById('client-tax-override').value = '';
    window.fetch = reply({ ...near, address_confirmed: '100 MAIN ST, ST PETERSBURG, FL', needs_confirmation: false });
    await lookupRealieAddress();
    out.exactFill = tax();
    out.askHiddenForExact = document.getElementById('tax-confirm-box').style.display === 'none';
    return out;
  });
  if (!M.askShown || !/100 MAIN AVE/.test(M.foundText) || M.beforeYes !== '') failures.push(`Q5: a near match must ask "Is this the right property?" without filling the tax (${JSON.stringify(M)})`);
  if (M.afterNo !== '' || !M.askHiddenAfterNo) failures.push(`Q5: "No, I'll fix the address" must not fill anything (${JSON.stringify(M)})`);
  if (M.afterYes !== '400.00') failures.push(`Q5: "Yes, use this property" should fill 400.00/mo, got "${M.afterYes}"`);
  if (M.exactFill !== '400.00' || !M.askHiddenForExact) failures.push(`Q5: an exact match should fill straight away, got "${M.exactFill}"`);

  /* N. ADDR1: typing shows Google suggestions (via the Worker); picking one fills street, city, county, unit */
  await client.goto(BASE);
  const N = await client.evaluate(async () => {
    const calls = [];
    window.fetch = async (u, o) => {
      calls.push(String(u));
      const body = /address-suggest/.test(u)
        ? { suggestions: [{ placeId: 'ChIJ_abcdefghij123', main: '4900 Brittany Dr S', secondary: 'St. Petersburg, FL, USA' }] }
        : { street: '4900 Brittany Dr S', unit: '1808', city: 'St. Petersburg', county: 'Pinellas', state: 'FL', zip: '33715' };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
    const el = document.getElementById('realie-address');
    el.value = '490'; el.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 450));
    const shortCalls = calls.length;
    el.value = '4900 Britt'; el.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 450));
    const items = [...document.querySelectorAll('#addr-suggest .addr-suggest-item')].map((b) => b.textContent);
    document.querySelector('#addr-suggest .addr-suggest-item').click();
    await new Promise((r) => setTimeout(r, 100));
    return { shortCalls, items, street: el.value, city: document.getElementById('realie-city').value,
      county: document.getElementById('realie-county').value, unit: document.getElementById('realie-unit').value,
      listHidden: document.getElementById('addr-suggest').style.display === 'none' };
  });
  if (N.shortCalls !== 0) failures.push('ADDR1: fewer than 4 letters must not ask for suggestions');
  if (N.items.length !== 1 || !/4900 Brittany Dr S/.test(N.items[0])) failures.push(`ADDR1: typing should show the suggestion list (${JSON.stringify(N.items)})`);
  if (N.street !== '4900 Brittany Dr S' || N.city !== 'St. Petersburg' || N.county !== 'Pinellas' || N.unit !== '1808' || !N.listHidden) failures.push(`ADDR1: picking a suggestion should fill street, city, county and unit (${JSON.stringify(N)})`);

  /* O. Help: the "?" button opens the full help guide (not the 3-page welcome), with no outdated text */
  await client.goto(BASE);
  const O = await client.evaluate(async () => {
    const ob = document.getElementById('client-onboard'); if (ob) ob.style.display = 'none';
    document.getElementById('help-btn').click();
    await new Promise((r) => setTimeout(r, 50));
    const pages = [];
    const label = document.getElementById('help-step-label').textContent;
    const total = parseInt((label.match(/of (\d+)/) || [])[1], 10) || 0;
    for (let i = 0; i < total; i++) {
      pages.push(document.getElementById('help-content').textContent);
      if (i < total - 1) document.getElementById('help-next').click();
    }
    return { open: document.getElementById('help-drawer').style.transform === 'translateX(0px)' || document.getElementById('help-drawer').style.transform === 'translateX(0)',
      welcomeShown: ob && ob.style.display !== 'none', label, total, text: pages.join(' | ') };
  });
  if (!O.open || O.welcomeShown) failures.push(`Help: "?" must open the full help guide, not the welcome popup (${JSON.stringify({ open: O.open, welcome: O.welcomeShown })})`);
  if (O.total < 10) failures.push(`Help: the guide should have at least 10 pages, has ${O.total} ("${O.label}")`);
  if (/Homestead Exemption box|Download PDF/i.test(O.text)) failures.push('Help: guide still mentions things that no longer exist (Homestead box / Download PDF)');
  if (!/Look up the real tax bill/.test(O.text) || !/Back to My Quote/.test(O.text)) failures.push('Help: guide should cover the tax lookup and the Back to My Quote tab');
  // Guide v2: pages follow the screen top to bottom (price before down payment before tax before save before share)
  const order = ['Purchase price', 'Down payment', 'Loan term', 'HOA fee', 'Homeowners insurance', 'Property tax', 'Look up the real tax bill', 'Back to My Quote', 'Save your scenario', 'Share with someone'].map((w) => O.text.indexOf(w));
  if (order.some((x) => x < 0) || order.some((x, k) => k > 0 && x < order[k - 1])) failures.push(`Help: guide pages should follow the screen order (${order.join(',')})`);

  /* P. UX Release B: Back button closes the guide/welcome, swipe closes the guide, skeletons show while loading */
  await client.goto(BASE);
  await client.evaluate(() => { try { localStorage.removeItem('ctc_onboard_seen'); } catch (e) {} });
  await client.goto(BASE + '&p=1');
  const P = {};
  P.welcomeOpen = await client.evaluate(() => document.getElementById('client-onboard').style.display !== 'none');
  await client.goBack({ waitUntil: 'commit' }).catch(() => {});
  await client.waitForTimeout(400);
  P.welcomeClosedByBack = await client.evaluate(() => document.getElementById('client-onboard').style.display === 'none');
  P.stillOnCalculator = /p=1/.test(client.url());
  await client.evaluate(() => document.getElementById('help-btn').click());
  await client.waitForTimeout(100);
  P.helpOpen = await client.evaluate(() => document.getElementById('help-drawer').style.transform === 'translateX(0px)' || document.getElementById('help-drawer').style.transform === 'translateX(0)');
  await client.goBack({ waitUntil: 'commit' }).catch(() => {});
  await client.waitForTimeout(400);
  P.helpClosedByBack = await client.evaluate(() => document.getElementById('help-drawer').style.transform === 'translateX(100%)');
  P.stillOnCalculator2 = /p=1/.test(client.url());
  // swipe right on the guide
  const sw = await client.evaluate(async () => {
    document.getElementById('help-btn').click();
    const d = document.getElementById('help-drawer');
    const t = (x) => new Touch({ identifier: 1, target: d, clientX: x, clientY: 300 });
    d.dispatchEvent(new TouchEvent('touchstart', { touches: [t(60)], bubbles: true }));
    d.dispatchEvent(new TouchEvent('touchmove', { touches: [t(120)], bubbles: true }));
    d.dispatchEvent(new TouchEvent('touchmove', { touches: [t(220)], bubbles: true }));
    d.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const closed = d.style.transform === 'translateX(100%)';
    // a short swipe springs back
    document.getElementById('help-btn').click();
    d.dispatchEvent(new TouchEvent('touchstart', { touches: [t(60)], bubbles: true }));
    d.dispatchEvent(new TouchEvent('touchmove', { touches: [t(100)], bubbles: true }));
    d.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    return { closed, sprangBack: d.style.transform === 'translateX(0)' || d.style.transform === 'translateX(0px)' };
  });
  // skeletons while loading
  const sk = await client.evaluate(async () => {
    let release; window.fetch = () => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({ suggestions: [] }), text: async () => '{"annual_tax":1200,"county":"Pinellas","address_confirmed":"1 A ST","needs_confirmation":false}' }); });
    document.getElementById('realie-address').value = '1 A St'; document.getElementById('realie-county').value = 'Pinellas';
    const pending = lookupRealieAddress();
    await new Promise((r) => setTimeout(r, 20));
    const during = document.getElementById('tax-skeleton').style.display === 'block';
    release(); await pending;
    return { during, after: document.getElementById('tax-skeleton').style.display === 'none' };
  });
  /* Q. Q2: Chris's PMI quote follows the client's price and down payment */
  await client.goto(PAGE + '?client=1&pp=400000&dp=5&inc=15000&dbt=500&rt=7&cn=Pinellas&mr=17.43&pmi=100&nm=Test');
  await client.waitForFunction(() => typeof calcAll === 'function' && document.getElementById('cbr-mi'));
  const Q = await client.evaluate(async () => {
    const wait = () => new Promise((r) => setTimeout(r, 60));
    const set = async (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); await wait(); };
    const read = () => ({ mi: document.getElementById('cbr-mi').textContent.trim(), badge: document.getElementById('cbr-pmi-badge').textContent.trim() });
    const m = document.getElementById('pmi-drift-modal'); const hide = () => { m.style.display = 'none'; };
    const out = {};
    out.start = read();
    await set('client-price', 600000); hide(); out.price600 = read();
    await set('client-down', 10); hide(); out.down10 = read();
    await set('client-down', 20); hide(); out.down20 = read();
    out.math = { same: scalePmiQuote(100, 400000, 5, 600000, 5, 760), tier: Math.round(scalePmiQuote(100, 400000, 5, 600000, 10, 760)) };
    return out;
  });
  if (Q.start.mi !== '$100' || Q.start.badge !== 'QUOTED') failures.push(`Q2: at Chris's numbers the PMI should be his $100 quote, marked QUOTED (${JSON.stringify(Q.start)})`);
  if (Q.price600.mi !== '$150' || Q.price600.badge !== 'EST') failures.push(`Q2: $100 quote at $400K should become $150 at $600K, marked EST (${JSON.stringify(Q.price600)})`);
  if (Q.math.same !== 150 || Q.math.tier !== 47) failures.push(`Q2: PMI scaling math is off (${JSON.stringify(Q.math)})`);
  if (Q.down10.mi !== '$' + Q.math.tier) failures.push(`Q2: moving to 10% down should use the scaled quote, $${Q.math.tier} (${JSON.stringify(Q.down10)})`);

  /* R. Q3: Share + PDF QR rebuild exactly what is on the client's screen */
  await client.goto(PAGE + '?client=1&pp=400000&dp=5&inc=15000&dbt=500&rt=7&cn=Pinellas&mr=17.43&pmi=100&fld=1&cdd=1&ca=1200&ren=1&grn=2000&pit=1500&nm=Test');
  await client.waitForFunction(() => typeof calcAll === 'function' && document.getElementById('cbr-mi'));
  const R = await client.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms || 60));
    const set = async (id, v, ev) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event(ev || 'input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); await wait(); };
    const hide = () => { document.getElementById('pmi-drift-modal').style.display = 'none'; };
    await set('client-price', 560000); hide();
    await set('client-down', 10); hide();
    document.querySelector('.client-term-btn[data-cterm="25"]').click(); await wait();
    await set('client-hoa', 250);
    await set('client-ins-slider', 300);
    await set('client-flood-slider', 175);
    await set('client-cdd-annual', 1800, 'input'); await set('client-cdd-annual', 1800, 'blur');
    await set('client-rent-slider', 2600);
    // pick a different county
    const cs = document.getElementById('client-county-search'); cs.value = 'Hillsb'; cs.dispatchEvent(new Event('input', { bubbles: true })); await wait();
    const opt = [...document.querySelectorAll('#client-county-dropdown *')].find((e) => e.children.length === 0 && /Hillsborough/.test(e.textContent));
    if (opt) opt.click(); await wait(150);
    let shared = null;
    navigator.share = (d) => { shared = d; return Promise.resolve(); };
    document.getElementById('btn-share-scenario').click(); await wait();
    // QR: capture what the PDF encodes when the client saves
    // (outside libraries are blocked in tests, so stand-ins for jsPDF + the QR maker record what would be drawn)
    let qrData = null;
    window.qrcode = () => ({ addData: (d) => { qrData = d; }, make() {}, getModuleCount: () => 21, isDark: () => false });
    const fakeDoc = new Proxy({}, { get: (t, k) => {
      if (k === 'internal') return { pageSize: { getWidth: () => 215.9, getHeight: () => 279.4, width: 215.9, height: 279.4 }, getNumberOfPages: () => 1 };
      if (k === 'splitTextToSize') return (txt) => [String(txt)];
      if (k === 'getTextWidth' || k === 'getStringUnitWidth') return () => 10;
      if (k === 'getNumberOfPages') return () => 1;
      if (k === 'output') return () => 'blob:x';
      if (k === 'then') return undefined;
      return () => fakeDoc;
    } });
    window.jspdf = { jsPDF: function () { return fakeDoc; } };
    window.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    CONFIG.turnstileSiteKey = 'test-site-key'; tsLoadFailed = false; tsWidgetId = 1;
    window.turnstile = { reset() {}, execute() { setTimeout(() => { const p = tsPending; tsPending = null; p.resolve('T'); }, 10); } };
    document.getElementById('save-email').value = 'a@example.com';
    document.getElementById('save-label').value = 'x';
    document.getElementById('save-address').value = '1 Main St';
    const b = document.getElementById('btn-save-scenario'); b.disabled = false; b.style.display = ''; b.click();
    await wait(1500);
    return { url: shared && shared.url, qrData, county: opt ? opt.textContent.trim() : null };
  });
  const CLIENT_SCREEN = /^(cbr-|client-back-dti|client-front-dti|client-price-val|client-down-pct|client-down-amt|client-hoa-val|client-flood|client-cdd|client-rent|client-county-result|client-ins)/;
  const before = await readScreen(client, CLIENT_SCREEN);
  if (!R.url) failures.push('Q3: Share did not produce a link');
  else {
    await client.goto(R.url.replace(/^.*\?/, PAGE + '?'));
    await client.waitForFunction(() => typeof calcAll === 'function' && document.getElementById('cbr-mi'));
    await client.waitForTimeout(150);
    const after = await readScreen(client, CLIENT_SCREEN);
    const diffs = Object.keys(Object.assign({}, before, after)).filter((k) => before[k] !== after[k]).map((k) => `${k}: "${before[k]}" → "${after[k]}"`);
    if (diffs.length) failures.push(`Q3: the shared link reopens different numbers — ${diffs.join('; ')}`);
    if (!before['cbr-mi'] || before['cbr-pmi-badge'] !== 'EST') failures.push(`Q3 test setup: expected an estimated PMI (${JSON.stringify(before)})`);
  }
  if (!R.county) failures.push('Q3 test setup: could not pick Hillsborough');
  if (R.qrData !== R.url) failures.push(`Q3: the PDF QR code should open the same numbers as Share (QR ${R.qrData}, share ${R.url})`);

  /* S. Bug hunt Nov 10: night-mode amounts readable, no stray tags in the payment card, stale rental line hides */
  await client.goto(PAGE + '?client=1&pp=350000&lt=FHA&dp=3.5&inc=11000&dbt=800&rt=7&cn=Pinellas&mr=17.43&hoa=300&fld=1&ren=1&grn=2500&pit=1800');
  await client.waitForFunction(() => typeof calcAll === 'function' && document.getElementById('cbr-mi'));
  const S2 = await client.evaluate(async () => {
    applyMode(true); await new Promise((r) => setTimeout(r, 50));
    const NAVY = 'rgb(27, 58, 107)';
    const navyText = ['client-hoa-val', 'client-flood-val', 'client-rent-val', 'client-down-pct'].filter((id) => getComputedStyle(document.getElementById(id)).color === NAVY);
    const save = [...document.querySelectorAll('div')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Save This Scenario');
    if (save && getComputedStyle(save).color === NAVY) navyText.push('Save This Scenario');
    const grid = document.getElementById('client-compact-grid');
    const stray = ['cbr-pmi-badge', 'cbr-ufmip-note', 'cbr-rental-detail-row'].filter((id) => !grid.contains(document.getElementById(id)));
    const uf = document.getElementById('cbr-ufmip-note'); const ufColor = getComputedStyle(uf).color;
    const s = document.getElementById('client-rent-slider'); const set = async (v) => { s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 40)); };
    await set(0); const shownAt0 = document.getElementById('cbr-rental-detail-row').checkVisibility();
    await set(3000); const shownAt3000 = document.getElementById('cbr-rental-detail-row').checkVisibility();
    applyMode(false);
    return { navyText, stray, ufVisible: uf.checkVisibility(), ufColor, shownAt0, shownAt3000 };
  });
  if (S2.navyText.length) failures.push(`Night mode: these are still navy on navy — ${S2.navyText.join(', ')}`);
  if (S2.stray.length) failures.push(`Payment card: ${S2.stray.join(', ')} should sit inside the breakdown, not loose under the status pill`);
  if (!S2.ufVisible || !/255, 255, 255/.test(S2.ufColor)) failures.push(`FHA note should be visible light text on the navy card (${JSON.stringify(S2)})`);
  if (!S2.shownAt0 || S2.shownAt3000) failures.push(`Rental "how the math works" line should show only while there is a shortfall (${JSON.stringify(S2)})`);

  /* T. The floating ? and night/day buttons never cover the payment card (small phones use the header ?) */
  for (const [w, h] of [[375, 548], [360, 640], [390, 664], [1280, 720]]) {
    const pg = await context.newPage();
    pg.on('pageerror', (e) => pageErrors.push(`floating buttons ${w}x${h}: ` + e.message));
    await pg.setViewportSize({ width: w, height: h });
    await pg.goto(PAGE + '?client=1&pp=400000&dp=10&pmi=120&inc=11000&dbt=800&rt=7&cn=Pinellas&mr=17.43');
    await pg.waitForFunction(() => typeof calcAll === 'function' && document.getElementById('cbr-mi'));
    const T = await pg.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById('client-onboard').style.display = 'none';
      const bar = [...document.querySelectorAll('body > *')].find((e) => /PREVIEW COPY/.test(e.textContent) && e.offsetHeight < 120);
      if (bar) bar.style.display = 'none';
      const ov = (a, b) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
      const look = () => {
        const card = document.getElementById('client-thermo-section').getBoundingClientRect();
        const shown = ['help-btn', 'mode-toggle'].filter((id) => +getComputedStyle(document.getElementById(id)).opacity > 0.5);
        return { shown, covering: shown.filter((id) => ov(document.getElementById(id).getBoundingClientRect(), card)), headerQ: !!(document.getElementById('help-btn-top') && document.getElementById('help-btn-top').checkVisibility()) };
      };
      scrollTo(0, 0); window.dispatchEvent(new Event('scroll')); await wait(350);
      const top = look();
      const covered = [];
      for (const y of [150, 300, 600, 1500]) { scrollTo(0, y); window.dispatchEvent(new Event('scroll')); await wait(300); const l = look(); if (l.covering.length) covered.push(y + ':' + l.covering.join('+')); }
      scrollTo(0, 0); window.dispatchEvent(new Event('scroll')); await wait(300);
      let opened = null;
      if (document.getElementById('help-btn-top') && document.getElementById('help-btn-top').checkVisibility()) { document.getElementById('help-btn-top').click(); await wait(100); opened = /translateX\(0/.test(document.getElementById('help-drawer').style.transform); }
      return { top, covered, opened };
    });
    if (T.top.covering.length || T.covered.length) failures.push(`${w}x${h}: floating buttons cover the payment card (${JSON.stringify(T)})`);
    if (!T.top.shown.includes('help-btn') && !T.top.headerQ) failures.push(`${w}x${h}: no ? button anywhere at the top of the page`);
    if (T.opened === false) failures.push(`${w}x${h}: the header ? did not open the help guide`);
    await pg.close();
  }

  /* U. Fonts come only from this site — no visitor request to Google or any other font server */
  {
    const html = fs.readFileSync(path.resolve(ROOT, PAGE_FILE), 'utf8');
    const outside = html.match(/https?:\/\/[^"'\s)]*(fonts\.googleapis|fonts\.gstatic|typekit|use\.fontawesome|fonts\.bunny|fontshare|cloud\.typography|fast\.fonts)[^"'\s)]*/gi) || [];
    if (outside.length) failures.push(`Fonts: still loading from an outside server — ${[...new Set(outside)].join(', ')}`);
    /* V. SEC2: other sites never learn which page (and numbers) a visitor came from */
    if (!/<meta name="referrer" content="(same-origin|no-referrer)">/.test(html)) failures.push('Security: the page must tell browsers not to pass its address (with client numbers) to other sites — referrer rule missing');
    /* SEC3: every link that opens a new tab can't control or learn about this page */
    const unsafeTabs = [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].map((m) => m[0]).filter((a) => !/rel="[^"]*noopener[^"]*noreferrer|rel="[^"]*noreferrer[^"]*noopener/.test(a));
    if (unsafeTabs.length) failures.push(`Security: ${unsafeTabs.length} new-tab link(s) missing rel="noopener noreferrer" — ${unsafeTabs.map((a) => a.slice(0, 80)).join(' | ')}`);
    if (/window\.open\((?!''\s*,\s*'_blank'\))/.test(html)) failures.push('Security: a window.open to an outside page needs noopener');
    const urls = [...html.matchAll(/@font-face\s*{[^}]*?url\(([^)]+)\)/g)].map((m) => m[1].replace(/['"]/g, ''));
    if (!urls.length) failures.push('Fonts: no @font-face rules found (headings would fall back to plain fonts)');
    for (const u of urls) {
      if (!u.startsWith('/dti-calculator/fonts/')) { failures.push(`Fonts: ${u} is not on this site`); continue; }
      const local = path.join(ROOT, u.replace('/dti-calculator/', ''));
      if (!fs.existsSync(local)) failures.push(`Fonts: ${u} is missing from the fonts folder`);
    }
    /* No title-font jump: the three title fonts are fetched first, and never swapped in late */
    const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin>/g)].map((m) => m[1]);
    for (const f of ['bebas-neue-latin-400-normal', 'raleway-latin-800-normal', 'montserrat-latin-800-normal']) {
      const href = '/dti-calculator/fonts/' + f + '.woff2';
      if (!preloads.includes(href)) failures.push(`Fonts: ${f} should be preloaded (title font jumps on first visit)`);
      else if (!fs.existsSync(path.join(ROOT, 'fonts', f + '.woff2'))) failures.push(`Fonts: preloaded ${f} is missing from the fonts folder`);
    }
    if (/font-display:\s*swap/.test(html)) failures.push('Fonts: font-display: swap makes the title jump from a backup font — use block');
  }

  /* W. S5 short links, tested as the REAL site (christoclose.github.io) with a stand-in Worker */
  {
    const SITE = 'https://christoclose.github.io/dti-calculator/' + (PAGE_FILE.startsWith('preview') ? 'preview/' : '');
    const pageHtml = fs.readFileSync(path.resolve(ROOT, PAGE_FILE), 'utf8');
    const store = new Map(); const calls = [];
    const wctx = await browser.newContext({ timezoneId: 'America/New_York', locale: 'en-US' });
    await wctx.route('**/*', async (r) => {
      const req = r.request(); const u = new URL(req.url());
      if (u.host === 'christoclose.github.io') {
        if (u.pathname.includes('/fonts/')) { const fp = path.join(ROOT, 'fonts', path.basename(u.pathname)); return fs.existsSync(fp) ? r.fulfill({ path: fp }) : r.fulfill({ status: 404, body: '' }); }
        return r.fulfill({ status: 200, contentType: 'text/html', body: pageHtml });
      }
      if (u.host.includes('workers.dev')) {
        const cors = { 'access-control-allow-origin': 'https://christoclose.github.io', 'access-control-allow-headers': 'Content-Type', 'access-control-allow-methods': 'POST, OPTIONS' };
        if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
        const b = JSON.parse(req.postData() || '{}'); calls.push(u.pathname);
        const reply = (st, obj) => r.fulfill({ status: st, headers: cors, contentType: 'application/json', body: JSON.stringify(obj) });
        if (u.pathname === '/link-create') {
          if (b.pin !== undefined && b.pin !== 'right-pin') return reply(401, { error: 'That PIN isn’t right.', pin: false });
          if (b.pin === undefined && !b.turnstileToken) return reply(403, { error: 'robot' });
          const id = 'Test' + String(store.size).padStart(6, '0'); store.set(id, b.params); return reply(200, { ok: true, id });
        }
        if (u.pathname === '/pin-check') return b.pin === 'right-pin' ? reply(200, { ok: true }) : reply(401, { error: 'That PIN isn’t right.' });
        if (u.pathname === '/link-get') return store.has(b.id) ? reply(200, { ok: true, params: store.get(b.id) }) : reply(404, { error: 'expired' });
        if (u.pathname === '/send-scenario') { if (b.linkId && b.linkParams && !store.has(b.linkId)) store.set(b.linkId, b.linkParams); return reply(200, { ok: true }); }
        return reply(404, { error: 'unknown' });
      }
      return r.abort();
    });
    const pg = await wctx.newPage(); pg.on('pageerror', (e) => pageErrors.push('short links: ' + e.message));
    const SCREEN = /^(cbr-|client-back-dti|client-front-dti|client-price-val|client-down-pct|client-county-result)/;
    const LONG = 'pp=400000&dp=10&inc=11000&dbt=800&rt=7&cn=Pinellas&mr=17.43&hoa=250&fld=1&fi=175&pmi=120&nm=Sam';
    const settle = async () => { await pg.waitForTimeout(400); };

    // 1. an old long link on the real site is retired
    await pg.goto(SITE + '?client=1&' + LONG); await settle();
    const longKind = await pg.evaluate(() => { const b = document.getElementById('link-problem'); return b && b.getAttribute('data-kind'); });
    if (longKind !== 'expired') failures.push(`Short links: an old long link on the real site should show "expired" (got ${longKind})`);

    // 1b. Lender lock: a plain visit with no PIN on this device shows the lock screen, not the setup
    await pg.goto(SITE); await settle();
    const lock1 = await pg.evaluate(() => {
      const vis = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null; };
      const txt = document.body.innerText;
      return { gate: vis('lender-gate'), setup: vis('setup-page'), rateWord: /show rate to client/i.test(txt), income: /gross monthly income/i.test(txt) };
    });
    if (!lock1.gate || lock1.setup || lock1.rateWord || lock1.income) failures.push(`Lender lock: a visitor without the PIN must see only the lock screen (${JSON.stringify(lock1)})`);
    if (lock1.gate) {
    await pg.fill('#gate-pin', 'wrong'); await pg.click('#gate-unlock'); await pg.waitForFunction(() => document.getElementById('gate-msg').textContent.trim());
    const lockMsg = await pg.textContent('#gate-msg');
    const stillLocked = await pg.evaluate(() => document.getElementById('setup-page').offsetParent === null);
    if (!/isn.t right/.test(lockMsg) || !stillLocked) failures.push(`Lender lock: a wrong PIN must keep it locked (msg "${lockMsg}")`);
    await pg.fill('#gate-pin', 'right-pin'); await pg.click('#gate-unlock');
    await pg.waitForFunction(() => document.getElementById('setup-page').offsetParent !== null && !document.getElementById('lender-gate'));
    if ((await pg.evaluate(() => getLenderPin())) !== 'right-pin') failures.push('Lender lock: unlocking should remember the PIN on this device');
    await pg.reload(); await settle();
    const lock2 = await pg.evaluate(() => ({ gate: !!document.getElementById('lender-gate'), setup: document.getElementById('setup-page').offsetParent !== null }));
    if (lock2.gate || !lock2.setup) failures.push(`Lender lock: a device with the PIN should go straight to the setup (${JSON.stringify(lock2)})`);
    await pg.evaluate(() => setLenderPin('old-pin')); await pg.reload(); await pg.waitForSelector('#lender-gate'); await settle();
    const lock3 = await pg.evaluate(() => ({ setup: document.getElementById('setup-page').offsetParent !== null, pin: getLenderPin() }));
    if (lock3.setup || lock3.pin) failures.push(`Lender lock: a remembered PIN that no longer works must lock again and be forgotten (${JSON.stringify(lock3)})`);
    }
    await pg.evaluate(() => setLenderPin(''));

    // 2. Chris makes a link with his PIN (wrong PIN first)
    await pg.goto(SITE); await settle();
    const made = pg.evaluate((long) => { const o = Object.fromEntries(new URLSearchParams(long)); return makeLenderLink(o).then((u) => u, (e) => 'ERR ' + e.message); }, LONG);
    await pg.waitForSelector('#lender-pin-input'); await pg.fill('#lender-pin-input', 'wrong'); await pg.click('#lender-pin-ok');
    await pg.waitForSelector('#lender-pin-input'); const retryNote = await pg.textContent('#lender-pin-box');
    await pg.fill('#lender-pin-input', 'right-pin'); await pg.click('#lender-pin-ok');
    const lenderUrl = await made;
    if (!/\?s=Test\d{6}$/.test(lenderUrl) || /pp=|inc=/.test(lenderUrl)) failures.push(`Short links: lender link should be short with no numbers (got ${lenderUrl})`);
    if (!/didn.t match/.test(retryNote)) failures.push('Short links: a wrong PIN should ask again with "didn’t match"');
    const remembered = await pg.evaluate(() => getLenderPin());
    if (remembered !== 'right-pin') failures.push('Short links: the device should remember the right PIN');

    // 3. the short link opens the same screen as the long link does on a test computer
    await pg.goto(lenderUrl); await pg.waitForFunction(() => document.getElementById('cbr-mi') && document.getElementById('client-back-dti').textContent.trim()); await settle();
    await pg.evaluate(() => { const o = document.getElementById('client-onboard'); if (o) o.style.display = 'none'; });
    const shortScreen = await readScreen(pg, SCREEN);
    const ref = await context.newPage(); await ref.goto(PAGE + '?client=1&' + LONG); await ref.waitForTimeout(400);
    const longScreen = await readScreen(ref, SCREEN); await ref.close();
    const d1 = Object.keys({ ...shortScreen, ...longScreen }).filter((k) => shortScreen[k] !== longScreen[k]);
    if (!Object.keys(shortScreen).length || d1.length) failures.push(`Short links: short link screen differs from the same numbers as a long link — ${d1.map((k) => `${k}: ${shortScreen[k]} vs ${longScreen[k]}`).join('; ') || 'empty screen'}`);
    if (/pp=|inc=/.test(pg.url())) failures.push('Short links: numbers appeared in the address bar');
    if (await pg.evaluate(() => !!document.getElementById('lender-gate') || document.documentElement.classList.contains('lender-locked'))) failures.push('Lender lock: a client link must never show the lock screen');

    // 4. client changes numbers, Share makes a new short link that reopens the same screen; Save's QR does too
    const W = await pg.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms || 80));
      const set = async (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); await wait(); };
      await set('client-price', 520000); document.getElementById('pmi-drift-modal').style.display = 'none';
      await set('client-down', 15);
      CONFIG.turnstileSiteKey = 'test-site-key'; tsLoadFailed = false; tsWidgetId = 1;
      window.turnstile = { reset() {}, execute() { setTimeout(() => { const p = tsPending; tsPending = null; if (p) p.resolve('T'); }, 10); } };
      let shared = null; navigator.share = (d) => { shared = d; return Promise.resolve(); };
      document.getElementById('btn-share-scenario').click(); await wait(600);
      let qr = null; window.qrcode = () => ({ addData: (d) => { qr = d; }, make() {}, getModuleCount: () => 21, isDark: () => false });
      const fakeDoc = new Proxy({}, { get: (t, k) => k === 'internal' ? { pageSize: { getWidth: () => 215.9, getHeight: () => 279.4, width: 215.9, height: 279.4 }, getNumberOfPages: () => 1 } : k === 'splitTextToSize' ? (x) => [String(x)] : (k === 'getTextWidth' || k === 'getStringUnitWidth') ? () => 10 : k === 'getNumberOfPages' ? () => 1 : k === 'then' ? undefined : () => fakeDoc });
      window.jspdf = { jsPDF: function () { return fakeDoc; } };
      document.getElementById('save-email').value = 'a@example.com'; document.getElementById('save-label').value = 'x'; document.getElementById('save-address').value = '1 Main St';
      const b = document.getElementById('btn-save-scenario'); b.disabled = false; b.style.display = ''; b.click(); await wait(800);
      return { share: shared && shared.url, qr };
    });
    const before = await readScreen(pg, SCREEN);
    for (const [name, url] of [['Share', W.share], ['PDF QR', W.qr]]) {
      if (!url || !/\?s=[A-Za-z0-9]{10}$/.test(url)) { failures.push(`Short links: ${name} should give a short link (got ${url})`); continue; }
      const p2 = await wctx.newPage(); await p2.goto(url); await p2.waitForFunction(() => document.getElementById('cbr-mi') && document.getElementById('client-back-dti').textContent.trim()); await p2.waitForTimeout(400);
      const after = await readScreen(p2, SCREEN); await p2.close();
      const d = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
      if (d.length) failures.push(`Short links: ${name} link reopens different numbers — ${d.map((k) => `${k}: ${before[k]} → ${after[k]}`).join('; ')}`);
    }
    // 5. an unknown / expired short link
    await pg.goto(SITE + '?s=Nope123456'); await settle();
    const expKind = await pg.evaluate(() => { const b = document.getElementById('link-problem'); return b && b.getAttribute('data-kind'); });
    if (expKind !== 'expired') failures.push(`Short links: an unknown link should say "expired" (got ${expKind})`);
    await wctx.close();
  }

  if (!P.welcomeOpen || !P.welcomeClosedByBack || !P.stillOnCalculator) failures.push(`UX12: Back should close the welcome popup and stay on the calculator (${JSON.stringify(P)})`);
  if (!P.helpOpen || !P.helpClosedByBack || !P.stillOnCalculator2) failures.push(`UX12: Back should close the help guide and stay on the calculator (${JSON.stringify(P)})`);
  if (!sw.closed || !sw.sprangBack) failures.push(`UX10: swiping the guide right should close it; a short swipe should spring back (${JSON.stringify(sw)})`);
  if (!sk.during || !sk.after) failures.push(`UX1: the tax lookup should show a placeholder card while loading (${JSON.stringify(sk)})`);

  await browser.close();

  for (const e of pageErrors) failures.push('Page error — ' + e);

  /* Q9: --update only saves new locked numbers when EVERY other check passed
     (independent math, screens agree, feature checks, no page errors).
     The locked-number comparison is the only check allowed to differ. */
  if (UPDATE && failures.length) {
    console.log(`\nREFUSED: new numbers were NOT saved — ${failures.length} other check(s) failed. Fix these first:`);
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  if (UPDATE) {
    fs.writeFileSync(EXPECTED_FILE, JSON.stringify(actual, null, 2) + '\n');
    console.log(`Locked values written for ${scenarios.length} scenarios → tests/expected.json`);
  }

  notes.forEach((n) => console.log('NOTE  ' + n));
  if (failures.length) {
    console.log(`\nFAILED (${PAGE_FILE}) — ${failures.length} difference(s):`);
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`\nPASSED (${PAGE_FILE}, ${lenderVersion}) — ${scenarios.length} scenarios: math engine, reference math, lender screen, client link, client screen.`);
})().catch((e) => { console.error(e); process.exit(1); });
