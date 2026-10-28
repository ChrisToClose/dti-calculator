# Math safety net

These tests make sure no change to `index.html` quietly changes a payment or DTI number.

**What runs:** 20 scenarios (CONV PMI tiers, PMI quote, FHA with flood + CDD, VA, USDA, rental shortfall, tax/insurance actuals, 15-yr, jumbo, no location, 0% rate, no income). For each one, the test checks:

1. **The math engine** (`calcAll`) still gives the locked numbers, to the cent.
2. **The independent reference math** (`reference.js`) agrees with the engine.
3. **The lender screen** shows exactly the locked values.
4. **The client link** built from the lender screen hasn't changed.
5. **The client screen** opened from that link shows exactly the locked values.
6. The lender and client screens agree on the payment and DTI.

**When it runs:** automatically on GitHub every time `index.html` or the tests change. See the **Actions** tab, "Math tests" (green check = no number changed). To run it by hand: `npm test`.

**When a number is SUPPOSED to change** (new loan limit, new MI rate, a bug fix):

1. Make the change in `index.html`. If it's a guideline value, change it in `reference.js` too.
2. Run `npm test`. It lists every value that moved. Review that list.
3. Once the list is exactly what was intended, run `npm run test:update` to lock the new values, then commit `tests/expected.json` in the same commit.

**Known issues locked in on purpose** (each one should change only when it's deliberately fixed):

- B2: FHA/USDA card shows `$NaN/mo` on the lender screen.
- B3: the loan limit is 726,200, and the jumbo warning text says $806,500 (2026 limit is 832,750).
- B5: VA/USDA 0% down becomes 5% on the client link.
- B9: a link with no county shows the client a DTI without property tax, marked "looks great".
