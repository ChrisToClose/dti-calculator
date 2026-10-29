/* ============================================================
   TEST SCENARIOS — each one is run through:
     1. the calculator's math engine (calcAll)
     2. the independent reference calculator (tests/reference.js)
     3. the LENDER screen, then the client link it builds,
        then the CLIENT screen opened from that link
   Anything not listed uses the lender view's starting values.
   ============================================================ */

const PINELLAS = { countyName: 'Pinellas', countyMillRate: 17.43 };
const HILLSBOROUGH = { countyName: 'Hillsborough', countyMillRate: 19.5 };

module.exports = [
  { id: 'conv-5-down-760-pinellas', note: 'The everyday case (matches the live test link)',
    in: { ...PINELLAS, loanType: 'CONV', purchasePrice: 400000, downPct: 5, rate: 7, income: 11000, otherDebts: 800 } },

  { id: 'conv-20-down-no-pmi-hoa', note: '20% down = no PMI; HOA; investor (no homestead)',
    in: { ...PINELLAS, loanType: 'CONV', purchasePrice: 550000, downPct: 20, rate: 6.5, income: 15000, otherDebts: 1200, hoa: 350, homestead: false } },

  { id: 'conv-10-down-680', note: 'PMI tier LTV 90 / FICO 680',
    in: { ...HILLSBOROUGH, loanType: 'CONV', purchasePrice: 325000, downPct: 10, rate: 6.875, income: 9000, otherDebts: 650, ficoVal: 680 } },

  { id: 'conv-7-down-700', note: 'PMI tier LTV 93 / FICO 700',
    in: { ...PINELLAS, loanType: 'CONV', purchasePrice: 300000, downPct: 7, rate: 7.125, income: 8000, otherDebts: 400, ficoVal: 700 } },

  { id: 'conv-3-down-620-over', note: 'PMI tier LTV 97 / FICO 620; DTI over limit',
    in: { ...PINELLAS, loanType: 'CONV', purchasePrice: 450000, downPct: 3, rate: 7.5, income: 7000, otherDebts: 1500, ficoVal: 620 } },

  { id: 'conv-pmi-override', note: 'Quoted PMI replaces the estimate',
    in: { ...PINELLAS, loanType: 'CONV', purchasePrice: 400000, downPct: 5, rate: 7, income: 11000, otherDebts: 800, pmiOverride: 95 } },

  { id: 'conv-tax-ins-actual', note: 'Actual tax bill + insurance quote replace estimates',
    in: { ...PINELLAS, loanType: 'CONV', purchasePrice: 400000, downPct: 10, rate: 6.75, income: 12000, otherDebts: 500, taxOverride: 481, insOverride: 310 } },

  { id: 'conv-15yr', note: '15-year term',
    in: { ...PINELLAS, loanType: 'CONV', purchasePrice: 350000, downPct: 25, termYears: 15, rate: 6.25, income: 14000, otherDebts: 300 } },

  { id: 'conv-jumbo', note: 'Loan above the 2026 conforming limit of $832,750 (B3 fixed v8.30.4)',
    in: { ...PINELLAS, loanType: 'CONV', purchasePrice: 1000000, downPct: 15, rate: 7.25, income: 30000, otherDebts: 2000 } },

  { id: 'fha-35-flood-cdd', note: 'FHA 3.5% down with flood insurance and a CDD',
    in: { ...HILLSBOROUGH, loanType: 'FHA', purchasePrice: 375000, downPct: 3.5, rate: 6.5, income: 9500, otherDebts: 700, floodActive: true, floodIns: 150, cddActive: true, cddAnnual: 1800 } },

  { id: 'fha-warn', note: 'FHA in the warning zone',
    in: { ...PINELLAS, loanType: 'FHA', purchasePrice: 300000, downPct: 3.5, rate: 6.75, income: 6500, otherDebts: 900 } },

  { id: 'va-5-down', note: 'VA (no monthly MI, no front-end limit)',
    in: { ...PINELLAS, loanType: 'VA', purchasePrice: 425000, downPct: 5, rate: 6.25, income: 10000, otherDebts: 1100 } },

  { id: 'va-0-down', note: 'VA 0% down (KNOWN ISSUE B5: client link turns 0% into 5%)',
    in: { ...PINELLAS, loanType: 'VA', purchasePrice: 425000, downPct: 0, rate: 6.25, income: 10000, otherDebts: 1100 } },

  { id: 'usda-0-down', note: 'USDA 0% down (KNOWN ISSUE B5 as above)',
    in: { ...HILLSBOROUGH, loanType: 'USDA', purchasePrice: 280000, downPct: 0, rate: 6.5, income: 7500, otherDebts: 350 } },

  { id: 'usda-5-down', note: 'USDA with down payment',
    in: { ...HILLSBOROUGH, loanType: 'USDA', purchasePrice: 280000, downPct: 5, rate: 6.5, income: 7500, otherDebts: 350 } },

  { id: 'rental-shortfall', note: 'Departing home rented: 75% of $2,000 rent vs $1,800 payment = $300 shortfall',
    in: { ...PINELLAS, loanType: 'CONV', purchasePrice: 500000, downPct: 10, rate: 6.875, income: 16000, otherDebts: 900, rentalActive: true, grossRent: 2000, departingPitia: 1800 } },

  { id: 'rental-covers', note: 'Rent covers the departing payment: no shortfall',
    in: { ...PINELLAS, loanType: 'CONV', purchasePrice: 500000, downPct: 10, rate: 6.875, income: 16000, otherDebts: 900, rentalActive: true, grossRent: 3000, departingPitia: 1800 } },

  { id: 'no-location', note: 'No county: lender cannot make a link; an old no-county link makes the client pick a location first (B9 fix, v8.30.2)',
    clientWaitsForLocation: true,
    in: { loanType: 'CONV', purchasePrice: 400000, downPct: 5, rate: 7, income: 11000, otherDebts: 800, countyName: null, countyMillRate: null } },

  { id: 'income-zero', note: 'No income: calculator refuses to compute', engineOnly: true,
    in: { ...PINELLAS, loanType: 'CONV', purchasePrice: 400000, downPct: 5, rate: 7, income: 0, otherDebts: 800 } },

  { id: 'rate-zero', note: 'Edge case: 0% rate', engineOnly: true,
    in: { ...PINELLAS, loanType: 'CONV', purchasePrice: 400000, downPct: 20, rate: 0, income: 11000, otherDebts: 800 } },
];
