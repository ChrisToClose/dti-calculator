# Math safety net

These tests make sure no change to `index.html` quietly changes a payment or DTI number.

**What runs:** 20 scenarios (CONV PMI tiers, PMI quote, FHA with flood + CDD, VA, USDA, rental shortfall, tax/insurance actuals, 15-yr, jumbo, no location, 0% rate, no income). For each one, the test checks:

1. **The math engine** (`calcAll`) still gives the locked numbers, to the cent.
2. **The independent reference math** (`reference.js`) agrees with the engine.
3. **The lender screen** shows exactly the locked values.
4. **The client link** built from the lender screen hasn't changed.
5. **The client screen** opened from that link shows exactly the locked values.
6. The lender and client screens agree on the payment and DTI.

**There are two copies of the calculator:**

- `preview/index.html` is at https://christoclose.github.io/dti-calculator/preview/ and shows an orange "PREVIEW COPY" bar. **Every change is made here first.**
- `index.html` is the live site clients use. **Never edit it directly.** It only changes through the **"Publish preview to live"** button (Actions tab → Publish preview to live → Run workflow). That button reruns the tests on the preview copy, copies it to live only if they pass, then tests the live copy too.

**When it runs:** automatically on GitHub every time the preview copy or the tests change (Actions tab → "Math tests"; a green check means no number changed). It also runs inside "Publish preview to live". To run it by hand: `npm test` (preview copy) or `node tests/run.js --page index.html` (live copy).

**When a number is SUPPOSED to change** (new loan limit, new MI rate, a bug fix):

1. Make the change in `index.html`. If it's a guideline value, change it in `reference.js` too.
2. Run `npm test`. It lists every value that moved. Review that list.
3. Once the list is exactly what was intended, run `npm run test:update` to lock the new values, then commit `tests/expected.json` in the same commit.

**Known issues locked in on purpose** (each one should change only when it's deliberately fixed):

- (none) — B5 fixed in v8.30.7 (Q1).

**Rules the tests enforce (beyond the numbers):**

- B9 (fixed v8.30.2): the lender can't make a client link without a county or an actual tax bill. An old no-county link makes the client pick a location first (shown as "—" and "Enter your location to get started"), and Save Scenario is refused until they do.
- P1.4 (v8.30.3): the version number is set in ONE place, `version:` at the top of CONFIG in the page. The header and footer read it from there, the tests fail if a hand-typed version appears anywhere, and "Publish preview to live" refuses a change that still has the live version number.
- v8.30.4: FHA/USDA lender cards show the engine's monthly MI (B2). The loan limit is $832,750 and the jumbo warning reads it from CONFIG (B3). If the PDF library fails to load, the fallback shows plain text, never HTML (Q4).
- v8.30.5: every outside script (jsPDF, qrcode-generator) carries an SRI integrity hash; the tests fail if one is missing (Q8). Hashes were checked two ways: computed from the served files and matched against cdnjs's published values.
- v8.30.7 (Q1): one link reader (`readClientLink`). A default is used only when a value is missing, so real zeros stay zero (VA/USDA 0% down, 0% rate, $0 flood). Impossible values (text, negatives, unknown loan type or FICO tier, missing price/income/rate, 100% down) show a "This link has a problem" screen with no payment. VA/USDA down-payment sliders start at 0%. Test J checks 8 bad links, 4 zero cases and a normal link.
- v8.30.9 (Chris, Nov 9): the overall DTI status (badge, bar colour, email status, watermark) follows the BACK-END ratio only; front-end is still shown. All three DTI bars (lender, client, email) use one scale, `dtiBarMax()` = back-end max × 1.1. Moved on purpose: 6 scenarios went from "Approaching" to "looks great" (front over its guideline, back-end fine); no payment amounts changed.
- v8.32.0 (Q5, Chris Nov 9 — D4 option A, "safety first"): the Worker checks every county lookup (Pinellas, Hillsborough, Pasco, Manatee). The county record's street must match what was typed exactly (number, name, St/Ave/Dr, N/S/E/W) and the unit must be confirmed; Hillsborough/Pasco/Manatee also report whether the address came from the county at all. Otherwise `needs_confirmation` → the client sees "Is this the right property?" and nothing is filled until they tap "Yes". Tests: worker.test.mjs sections 12–13, run.js check M (both proven to fail on the old code).
- v8.33.0 (ADDR1, Chris Nov 9): Google address autocomplete in the tax lookup. Page → Worker `/address-suggest` + `/address-details` → Google Places API (New). Key only as Worker secret GOOGLE_PLACES_KEY; 4,000 Google calls/month cap (free allowance 5,000), then plain typing; 4+ letters and a short pause before asking; US only, Florida favoured. Picking fills street, city, county, unit; the Q5 exact-match check still runs on the lookup. Tests: worker.test.mjs section 14, run.js check N.
- v8.34.0 (Chris, Nov 9): the "?" button opens the full help guide again (an Oct 20 change had pointed it at the 3-page welcome). Guide now 12 pages: removed the non-existent Homestead box and "Download PDF", added the tax lookup + address suggestions and the Reset to Quote tab, honest wording on Share; readable in night mode. Test O.
- v8.35.0–8.35.1 (Chris, Nov 9): help guide v2 — 12 pages (8.35.1: even gold frame drawn by the page, insurance "ACTUAL" note, tax + lookup on one page, Flood/CDD page removed, clearer Reset picture), was 14 pages in the order a client works down the screen (numbers loaded → payment bar → price → down → term → HOA → insurance → tax → tax lookup → flood/CDD → Reset to Quote → save → share → call Chris), each with a highlighted screenshot from /help-img/. Old text kept in docs/help-guide-v1-set-aside.md. Test O checks the page order.
- v8.36.0 (Chris, Nov 9): the side tab is renamed "Back to My Quote" (was "Reset to Quote"); guide page 9 rewritten in plain words with a zoomed-out, dimmed screenshot + arrow; even spacing inside every gold frame; insurance page notes a quote switches back to an estimate if the price changes. Also fixed: the closed help panel's shadow was shading the right edge of the client screen all the time.
- v8.37.0–8.38.0 (UX Foundation, Chris Nov 9): Release A — bigger tap areas (ⓘ, ✎, ×), notch/home-bar spacing (viewport-fit=cover + safe-area insets on the floating buttons, tab, pinned bar, guide), steady (tabular) numbers everywhere, balanced headlines, reserved space for guide pictures. Release B — phone Back button closes the help guide / welcome popup instead of leaving the calculator; swipe the guide right to close (short swipes spring back); grey placeholder rows/card while address suggestions or a tax record load (no shimmer if "reduce motion" is on). Test P (proven to fail on Release A — Back used to leave the calculator).
