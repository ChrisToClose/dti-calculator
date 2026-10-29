/* ============================================================
   INDEPENDENT REFERENCE CALCULATOR (for tests only)
   Written separately from the calculator's own math (calcAll in
   index.html) so the two can check each other. If they disagree,
   one of them is wrong — investigate before changing either.

   The guideline numbers below are TODAY's (Oct 28, 2026) values.
   When a guideline changes on purpose (e.g. new loan limit),
   change it here AND in index.html in the same update.
   ============================================================ */

const RULES = {
  homesteadExemption: 50000,          // FL standard homestead exemption
  insuranceAnnualPctOfPrice: 0.005,   // default insurance estimate
  fhaUpfrontMip: 0.0175,              // financed into the loan
  fhaAnnualMip: 0.0055,               // on the total (financed) loan
  usdaUpfrontFee: 0.01,               // financed into the loan
  usdaAnnualFee: 0.0035,              // on the total (financed) loan
  rentalUsablePct: 0.75,              // 75% of gross rent counts
  conformingLimit: 832750,            // FHFA 2026 one-unit baseline (fixed B3, v8.30.4)
  // MGIC monthly PMI rates by FICO: [LTV <=90, LTV 90-<95, LTV 95+]
  pmi: {
    760: [0.0019, 0.0041, 0.0058], 740: [0.0026, 0.0051, 0.0071],
    720: [0.0037, 0.0065, 0.0087], 700: [0.0052, 0.0082, 0.0106],
    680: [0.0071, 0.0102, 0.0128], 660: [0.0091, 0.0122, 0.0150],
    640: [0.0110, 0.0145, 0.0175], 620: [0.0128, 0.0165, 0.0186],
  },
  // DTI limits: front warning, back warning, back maximum
  dti: {
    CONV: { frontWarn: 28, backWarn: 43, backMax: 50 },
    FHA:  { frontWarn: 31, backWarn: 43, backMax: 57 },
    VA:   { frontWarn: null, backWarn: 41, backMax: 50 },
    USDA: { frontWarn: 29, backWarn: 41, backMax: 46 },
  },
};

function monthlyPI(loan, annualRatePct, years) {
  const n = years * 12;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return loan / n;
  const growth = Math.pow(1 + r, n);
  return loan * r * growth / (growth - 1);
}

function reference(s) {
  if (!(s.income > 0)) return { error: 'income_zero' };

  const down = s.purchasePrice * s.downPct / 100;
  const baseLoan = s.purchasePrice - down;
  const ltv = 100 - s.downPct;

  let upfront = 0;
  if (s.loanType === 'FHA') upfront = baseLoan * RULES.fhaUpfrontMip;
  if (s.loanType === 'USDA') upfront = baseLoan * RULES.usdaUpfrontFee;
  const loan = baseLoan + upfront;

  const pi = monthlyPI(loan, s.rate, s.termYears);

  let tax = null;
  if (s.taxOverride != null) tax = s.taxOverride;
  else if (s.countyMillRate != null) {
    const taxable = s.homestead ? Math.max(s.purchasePrice - RULES.homesteadExemption, 0) : s.purchasePrice;
    tax = taxable * s.countyMillRate / 1000 / 12;
  }

  const ins = s.insOverride != null ? s.insOverride : s.purchasePrice * RULES.insuranceAnnualPctOfPrice / 12;

  let mi = 0;
  if (s.loanType === 'CONV' && s.downPct < 20) {
    if (s.pmiOverride != null && s.pmiOverride >= 0) mi = s.pmiOverride;
    else {
      const row = RULES.pmi[s.ficoVal] || RULES.pmi[760];
      const col = ltv <= 90 ? 0 : ltv < 95 ? 1 : 2;
      mi = baseLoan * row[col] / 12;
    }
  } else if (s.loanType === 'FHA') mi = loan * RULES.fhaAnnualMip / 12;
  else if (s.loanType === 'USDA') mi = loan * RULES.usdaAnnualFee / 12;

  const flood = s.floodActive ? (s.floodIns || 0) : 0;
  const cdd = s.cddActive ? (s.cddAnnual || 0) / 12 : 0;
  const hoa = s.hoa || 0;

  const housing = pi + (tax || 0) + ins + flood + hoa + mi + cdd;

  let shortfall = 0;
  if (s.rentalActive) {
    const net = (s.grossRent || 0) * RULES.rentalUsablePct - (s.departingPitia || 0);
    if (net < 0) shortfall = -net;
  }

  const front = housing / s.income * 100;
  const back = (housing + (s.otherDebts || 0) + shortfall) / s.income * 100;

  const t = RULES.dti[s.loanType];
  // Note: the front-end ratio is compared to the BACK maximum for "over" (today's rule).
  const frontStatus = t.frontWarn == null ? 'ok' : front < t.frontWarn ? 'ok' : front <= t.backMax ? 'warn' : 'over';
  const backStatus = back < t.backWarn ? 'ok' : back <= t.backMax ? 'warn' : 'over';
  const overall = [frontStatus, backStatus].includes('over') ? 'over'
    : [frontStatus, backStatus].includes('warn') ? 'warn' : 'ok';

  return {
    loanAmt: loan, ufmip: upfront, pi, monthlyTax: tax, monthlyIns: ins, monthlyMI: mi,
    housingPayment: housing, rentalShortfall: shortfall,
    frontDTI: front, backDTI: back, overallStatus: overall,
    isJumbo: loan > RULES.conformingLimit,
  };
}

module.exports = { reference, RULES };
