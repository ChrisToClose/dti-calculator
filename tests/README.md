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

- B2: FHA/USDA card shows `$NaN/mo` on the lender screen.
- B3: the loan limit is 726,200, and the jumbo warning text says $806,500 (2026 limit is 832,750).
- B5: VA/USDA 0% down becomes 5% on the client link.

**Rules the tests enforce (beyond the numbers):**

- B9 (fixed v8.30.2): the lender can't make a client link without a county or an actual tax bill. An old no-county link makes the client pick a location first (shown as "—" and "Enter your location to get started"), and Save Scenario is refused until they do.
- P1.4 (v8.30.3): the version number is set in ONE place, `version:` at the top of CONFIG in the page. The header and footer read it from there, the tests fail if a hand-typed version appears anywhere, and "Publish preview to live" refuses a change that still has the live version number.
