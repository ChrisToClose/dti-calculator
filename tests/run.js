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
  'va-0-down': 'B5 — client link turns 0% down into 5%',
  'usda-0-down': 'B5 — client link turns 0% down into 5%',
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

  await browser.close();

  for (const e of pageErrors) failures.push('Page error — ' + e);

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
