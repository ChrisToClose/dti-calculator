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
  await context.route('**/*', (r) => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));

  const pageErrors = [];
  const lender = await context.newPage();
  lender.on('pageerror', (e) => pageErrors.push('lender: ' + e.message));
  await lender.goto(PAGE);
  await lender.waitForFunction(() => typeof calcAll === 'function' && typeof S === 'object');
  await lender.evaluate(() => { window.__S0 = JSON.parse(JSON.stringify(S)); });

  const client = await context.newPage();
  client.on('pageerror', (e) => pageErrors.push('client: ' + e.message));

  const expected = fs.existsSync(EXPECTED_FILE) ? JSON.parse(fs.readFileSync(EXPECTED_FILE, 'utf8')) : {};
  const actual = {};
  const failures = [];
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
      rec.clientLink = new URL(run.url).search;
      await client.goto(run.url);
      await client.waitForFunction(() => document.getElementById('client-back-dti'));
      rec.clientScreen = await readScreen(client, CLIENT_IDS);

      // E. lender vs client agreement
      const pairs = [['lbr-housing', 'client-housing-total'], ['lender-front-dti', 'client-front-dti'], ['lender-back-dti', 'client-back-dti']];
      const mismatched = pairs.filter(([l, c]) => rec.lenderScreen[l] !== rec.clientScreen[c]);
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
  console.log(`\nPASSED (${PAGE_FILE}) — ${scenarios.length} scenarios: math engine, reference math, lender screen, client link, client screen.`);
})().catch((e) => { console.error(e); process.exit(1); });
