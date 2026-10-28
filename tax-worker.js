// ChrisToClose DTI Calculator — Tax & Property Lookup Worker
// Requires secrets: ANTHROPIC_API_KEY
// County PA APIs: Hillsborough (JSON), Pinellas (HTML), Pasco (HTML), Manatee (JSON)

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ── /realie-lookup route ───────────────────────────────────────
    // Accepts JSON: { address, city, state, county }
    // Routes to direct county PA APIs based on county field
    if (url.pathname === '/realie-lookup' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { address, city, state, county, unit } = body;

        if (!address || !state) {
          return new Response(JSON.stringify({ error: 'Address and state are required.' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const countyNorm = (county || '').toLowerCase().trim();

        let result;
        if (countyNorm.includes('hillsborough')) {
          result = await lookupHillsborough(address, city);
        } else if (countyNorm.includes('pinellas')) {
          result = await lookupPinellas(address, city, unit);
        } else if (countyNorm.includes('pasco')) {
          result = await lookupPasco(address, city);
        } else if (countyNorm.includes('manatee')) {
          result = await lookupManatee(address, city);
        } else {
          return new Response(JSON.stringify({
            error: `County "${county}" is not yet supported. Supported counties: Hillsborough, Pinellas, Pasco, Manatee.`
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

      } catch (err) {
        console.error('County PA lookup error:', err);
        return new Response(JSON.stringify({ error: err.message || 'Something went wrong. Please try again.' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── /tax-lookup route (existing — AI tax bill image reader) ───
    if (url.pathname === '/tax-lookup' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const file = formData.get('bill');

        if (!file) {
          return new Response(JSON.stringify({ error: 'No file uploaded.' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const arrayBuffer = await file.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        const mediaType = file.type || 'image/jpeg';

        if (arrayBuffer.byteLength > 5 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: 'File too large. Please upload an image under 5MB.' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5',
            max_tokens: 256,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: mediaType,
                      data: base64,
                    },
                  },
                  {
                    type: 'text',
                    text: `This is a Florida property tax bill. Find the total annual property tax amount owed.
Look for lines labeled "Total Tax", "Total Amount Due", "Net Taxes", "Total Ad Valorem", or similar.
Return ONLY a JSON object in this exact format, nothing else:
{"annual_tax": 4250.00, "confidence": "high", "note": "From Total Tax line"}
If you cannot find a clear annual tax amount, return:
{"annual_tax": null, "confidence": "low", "note": "Could not find annual tax amount"}`,
                  },
                ],
              },
            ],
          }),
        });

        if (!anthropicResponse.ok) {
          const errText = await anthropicResponse.text();
          console.error('Anthropic API error:', errText);
          return new Response(JSON.stringify({ error: 'AI service error. Please try again.' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const anthropicData = await anthropicResponse.json();
        const rawText = anthropicData.content[0].text.trim();

        let result;
        try {
          const jsonMatch = rawText.match(/\{[\s\S]*\}/);
          result = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Could not read tax bill. Please try a clearer photo.' }), {
            status: 422,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

      } catch (err) {
        console.error('Tax lookup error:', err);
        return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};

// ─────────────────────────────────────────────────────────────────
// HILLSBOROUGH COUNTY — gis.hcpafl.org JSON REST API
// ─────────────────────────────────────────────────────────────────
async function lookupHillsborough(address, city) {
  const searchUrl = `https://gis.hcpafl.org/CommonServices/property/search/BasicSearch?address=${encodeURIComponent(address)}&pagesize=40&page=1`;
  const searchResp = await fetch(searchUrl, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
  });
  if (!searchResp.ok) throw new Error(`Hillsborough search failed: ${searchResp.status}`);
  const searchData = await searchResp.json();

  const items = searchData.items || searchData.results || (Array.isArray(searchData) ? searchData : null);
  if (!items || items.length === 0) throw new Error('Property not found in Hillsborough County.');

  const parcel = items[0];
  const pin = parcel.pin || parcel.parcelId || parcel.id;
  if (!pin) throw new Error('Could not extract parcel PIN from Hillsborough search.');

  const detailUrl = `https://gis.hcpafl.org/CommonServices/property/search/ParcelData?pin=${encodeURIComponent(pin)}`;
  const detailResp = await fetch(detailUrl, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
  });
  if (!detailResp.ok) throw new Error(`Hillsborough detail fetch failed: ${detailResp.status}`);
  const detail = await detailResp.json();

  const pc = detail.propertyCard || detail;
  const valueSummary = detail.valueSummary || pc.valueSummary || [];

  const countyVal = valueSummary.find(v => v.sequence === 1 || v.seq === 1) || valueSummary[0] || {};
  const taxableVal = countyVal.taxableVal || countyVal.taxable || 0;
  const assessedVal = countyVal.assessedVal || countyVal.assessed || 0;
  const marketVal = countyVal.marketVal || countyVal.market || pc.totalMarketValue || 0;
  const totalTaxRate = pc.totalTaxRate || 0;

  const annualTax = totalTaxRate > 0 && taxableVal > 0
    ? Math.round(totalTaxRate * taxableVal / 1000 * 100) / 100
    : null;

  const exemptions = Array.isArray(countyVal.exemptions) ? countyVal.exemptions : [];
  const homesteadEx = exemptions.find(e => (e.exemptionType || e.type || '').toLowerCase().includes('homestead'));
  const isHomesteaded = !!homesteadEx || !!(pc.homestead);
  const homesteadValue = homesteadEx ? (homesteadEx.exemptionValue || homesteadEx.value || 50000) : 0;

  const salesHistory = detail.salesHistory || pc.salesHistory || [];
  const lastSale = salesHistory[0] || null;
  const lastSalePrice = lastSale ? (lastSale.salePrice || lastSale.price || pc.topSalePrice || null) : (pc.topSalePrice || null);
  const lastSaleDate = lastSale ? (lastSale.saleDate || lastSale.date || pc.topSaleDate || null) : (pc.topSaleDate || null);

  const currentYear = new Date().getFullYear();
  const yearBuilt = detail.buildings?.[0]?.yearBuilt || pc.yearBuilt || detail.yearBuilt || null;
  const buildingValue = pc.buildingValue || countyVal.buildingVal || 0;
  let isNewConstruction = false, newConstructionReasons = [];
  if (yearBuilt && yearBuilt >= currentYear - 2) {
    isNewConstruction = true; newConstructionReasons.push(`Year built: ${yearBuilt}`);
  }
  if (lastSalePrice > 0 && buildingValue > 0 && buildingValue < lastSalePrice * 0.20) {
    isNewConstruction = true; newConstructionReasons.push(`Building assessed at only ${Math.round(buildingValue / lastSalePrice * 100)}% of sale price`);
  }
  if (lastSalePrice > 0 && (!buildingValue || buildingValue === 0)) {
    isNewConstruction = true; newConstructionReasons.push('No improvement value on record (land-only assessment)');
  }

  let year2Estimate = null, year2Basis = null, millageRate = null;
  if (totalTaxRate > 0) {
    millageRate = totalTaxRate / 1000;
    if (lastSalePrice > 0) {
      const newTaxableValue = Math.max(0, lastSalePrice - 50000);
      year2Estimate = Math.round(newTaxableValue * millageRate);
      year2Basis = `Reassessed at $${Math.round(lastSalePrice).toLocaleString()} purchase price, $50K homestead, mill rate ${totalTaxRate.toFixed(4)}`;
    }
  }

  const siteAddress = pc.siteAddress || parcel.siteAddress || detail.siteAddress || address;
  const taxYear = pc.taxYear || detail.taxYear || currentYear - 1;

  return buildResponse({
    annualTax, taxYear, assessedVal, marketVal, taxableVal,
    addressConfirmed: siteAddress,
    county: 'Hillsborough',
    taxRecordLink: `https://www.hcpafl.org/property-search/parcel?pin=${pin}`,
    isNewConstruction, newConstructionReasons,
    isHomesteaded, homesteadValue, allExemptions: exemptions,
    year2Estimate, year2Basis, millageRate, millagePerThousand: totalTaxRate,
    lastSalePrice, lastSaleDate, buildingValue, yearBuilt,
    taxHistory: detail.taxHistory || [], assessmentHistory: detail.assessmentHistory || [],
  });
}

// ─────────────────────────────────────────────────────────────────
// PINELLAS COUNTY — egis.pinellas.gov PublicWebGIS Parcels layer (JSON)
// One query returns taxes, taxable value, exemptions, sales, site address.
// No pcpao.gov calls (that site 403s requests coming from the Worker).
// Tested 2026-10-28 in browser:
//   6306 Pelican Creek Xing → TAXES 5772, TAXABLE 320013, HOMESTEAD Yes
// Condo buildings share one SITE_ADDRESS; the unit lives in LEGAL
// ("UNIT 6306", "APT 1808"), so the unit # is used to pick the parcel.
// ─────────────────────────────────────────────────────────────────
const PINELLAS_PARCELS_URL = 'https://egis.pinellas.gov/gis/rest/services/PublicWebGIS/Parcels/MapServer/1/query';

const PIN_DIRECTIONS = { NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW' };
const PIN_DIR_SET = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);
const PIN_STREET_TYPES = {
  STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', DRIVE: 'DR', ROAD: 'RD', BOULEVARD: 'BLVD', LANE: 'LN',
  COURT: 'CT', CIRCLE: 'CIR', PLACE: 'PL', TERRACE: 'TER', CROSSING: 'XING', PARKWAY: 'PKWY',
  HIGHWAY: 'HWY', TRAIL: 'TRL', POINT: 'PT', COVE: 'CV', SQUARE: 'SQ', LOOP: 'LOOP', WAY: 'WAY',
  ISLE: 'IS', ISLAND: 'IS', HARBOR: 'HBR', RUN: 'RUN', PASS: 'PASS', PATH: 'PATH', ALLEY: 'ALY',
};

function pinNormalizeTokens(str) {
  return String(str || '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => PIN_DIRECTIONS[t] || PIN_STREET_TYPES[t] || t);
}

function pinEscapeSql(s) {
  return String(s).replace(/'/g, "''");
}

function pinEscapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pinFormatDate(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

async function lookupPinellas(address, city, unit) {
  // ── Parse the street address, pulling out any unit typed into it ──
  let rawAddr = String(address || '').trim();
  let unitNum = String(unit || '').trim();
  const inlineUnit = rawAddr.match(/\s+(?:APT|UNIT|STE|SUITE|#)\.?\s*#?\s*([A-Z0-9-]+)\s*$/i);
  if (inlineUnit) {
    if (!unitNum) unitNum = inlineUnit[1];
    rawAddr = rawAddr.slice(0, inlineUnit.index).trim();
  }
  unitNum = unitNum.replace(/^(?:APT|UNIT|STE|SUITE|#)\.?\s*#?\s*/i, '').trim().toUpperCase();

  const tokens = pinNormalizeTokens(rawAddr);
  if (tokens.length < 2 || !/^\d+[A-Z]?$/.test(tokens[0])) {
    throw new Error('Could not read that Pinellas address — please enter it like "6306 Pelican Creek Xing".');
  }
  const streetNum = tokens[0];
  const streetTokens = tokens.slice(1);
  // First word of the street name that isn't a direction (e.g. "W UNION ST" → UNION)
  const coreWord = streetTokens.find(t => !PIN_DIR_SET.has(t)) || streetTokens[0];
  const targetAddr = [streetNum, ...streetTokens].join(' ');

  // ── Query the county parcel layer ──
  const params = new URLSearchParams({
    where: `SITE_NUM='${pinEscapeSql(streetNum)}' AND SITE_ADDRESS LIKE '%${pinEscapeSql(coreWord)}%'`,
    outFields: 'PARCELID_DSP1,STRAP,TAXABLE_VALUE,HOMESTEAD_EXEMP,WIDOW_EXEMP,DISABILITY_EXEMP,TAX_EXEMP,AGRICULT_EXEMP,LAND_VALUE,IMP_VALUE,NEW_CONST_VALUE,TAXES,SALEDATE1,SALEPRICE1,SALEDATE2,SALEPRICE2,USE_CODE,LEGAL,SITE_ADDRESS,SITE_CITY,SITE_ZIP,HOMESTEAD',
    returnGeometry: 'false',
    resultRecordCount: '1000',
    f: 'json',
  });
  const resp = await fetch(`${PINELLAS_PARCELS_URL}?${params.toString()}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (ChrisToClose tax lookup)' },
  });
  if (!resp.ok) throw new Error(`Pinellas County records are not responding right now (status ${resp.status}). Please try again shortly.`);
  const data = await resp.json();
  if (data.error) throw new Error(`Pinellas County records returned an error: ${data.error.message || 'unknown error'}.`);

  let candidates = (data.features || []).map(f => f.attributes);
  if (candidates.length === 0) {
    throw new Error('Property not found in Pinellas County records. Check the street number and street name.');
  }

  // ── Narrow to the right street (handles N/S/E/W and St vs Street) ──
  const exact = candidates.filter(c => pinNormalizeTokens(c.SITE_ADDRESS).join(' ') === targetAddr);
  if (exact.length > 0) {
    candidates = exact;
  } else {
    const startsWith = candidates.filter(c => pinNormalizeTokens(c.SITE_ADDRESS).join(' ').startsWith(targetAddr));
    if (startsWith.length > 0) candidates = startsWith;
  }

  const distinctAddrs = [...new Set(candidates.map(c => c.SITE_ADDRESS))];
  if (distinctAddrs.length > 1 && city) {
    const cityNorm = pinNormalizeTokens(city).join(' ').replace(/^SAINT /, 'ST ');
    const byCity = candidates.filter(c => pinNormalizeTokens(c.SITE_CITY).join(' ').replace(/^SAINT /, 'ST ') === cityNorm);
    if (byCity.length > 0) candidates = byCity;
  }
  const remainingAddrs = [...new Set(candidates.map(c => c.SITE_ADDRESS))];
  if (remainingAddrs.length > 1) {
    throw new Error(`More than one Pinellas street matches: ${remainingAddrs.slice(0, 4).join('; ')}. Please enter the full street name including direction (N/S/E/W).`);
  }

  // ── Condo buildings: pick the unit ──
  if (unitNum) {
    const unitRe = new RegExp(`\\b(?:UNIT|APT|STE|SUITE|#)\\s*0*${pinEscapeRegex(unitNum.replace(/^0+(?=.)/, ''))}\\b`, 'i');
    const byUnit = candidates.filter(c => unitRe.test(c.LEGAL || ''));
    if (byUnit.length > 0) {
      candidates = byUnit;
    } else if (candidates.length > 1) {
      throw new Error(`Unit ${unitNum} was not found at ${remainingAddrs[0]}. Please double-check the unit number.`);
    }
    // One parcel and the unit wasn't in LEGAL (e.g. townhome with its own address) → use it.
  }
  if (candidates.length > 1) {
    throw new Error(`${remainingAddrs[0]} has ${candidates.length} units on record. Please enter the Unit / Apt # to get the right tax bill.`);
  }

  const p = candidates[0];

  // ── Values ──
  const num = v => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
  const annualTax = p.TAXES != null ? num(p.TAXES) : null;
  const taxableVal = p.TAXABLE_VALUE != null ? num(p.TAXABLE_VALUE) : null;
  const homesteadValue = num(p.HOMESTEAD_EXEMP);
  const isHomesteaded = String(p.HOMESTEAD || '').toUpperCase() === 'YES' || homesteadValue > 0;

  const allExemptions = [];
  if (homesteadValue > 0) allExemptions.push({ exemptionType: 'Homestead', exemptionValue: homesteadValue });
  if (num(p.WIDOW_EXEMP) > 0) allExemptions.push({ exemptionType: 'Widow/Widower', exemptionValue: num(p.WIDOW_EXEMP) });
  if (num(p.DISABILITY_EXEMP) > 0) allExemptions.push({ exemptionType: 'Disability', exemptionValue: num(p.DISABILITY_EXEMP) });
  if (num(p.TAX_EXEMP) > 0) allExemptions.push({ exemptionType: 'Other', exemptionValue: num(p.TAX_EXEMP) });
  if (num(p.AGRICULT_EXEMP) > 0) allExemptions.push({ exemptionType: 'Agricultural', exemptionValue: num(p.AGRICULT_EXEMP) });
  const totalExemptions = allExemptions.reduce((s, e) => s + e.exemptionValue, 0);

  // Assessed value = taxable value + exemptions (Florida definition)
  const assessedVal = taxableVal != null ? taxableVal + totalExemptions : null;
  const landVal = num(p.LAND_VALUE);
  const buildingValue = num(p.IMP_VALUE);
  const hasLandBuildingSplit = landVal + buildingValue > 0; // condos show 0 / 0
  const marketVal = hasLandBuildingSplit ? landVal + buildingValue : null;

  // Effective millage from the actual bill
  let millagePerThousand = null, millageRate = null;
  if (annualTax > 0 && taxableVal > 0) {
    millagePerThousand = Math.round((annualTax / taxableVal) * 1000 * 10000) / 10000;
    millageRate = millagePerThousand / 1000;
  }

  // Most recent sale
  const sales = [
    { date: p.SALEDATE1, price: num(p.SALEPRICE1) },
    { date: p.SALEDATE2, price: num(p.SALEPRICE2) },
  ].filter(s => s.date || s.price > 0).sort((a, b) => (b.date || 0) - (a.date || 0));
  const lastSalePrice = sales[0] && sales[0].price > 0 ? sales[0].price : null;
  const lastSaleDate = sales[0] ? pinFormatDate(sales[0].date) : null;

  // New construction flags
  let isNewConstruction = false;
  const newConstructionReasons = [];
  if (num(p.NEW_CONST_VALUE) > 0) {
    isNewConstruction = true;
    newConstructionReasons.push(`New construction value on record: $${num(p.NEW_CONST_VALUE).toLocaleString()}`);
  }
  if (hasLandBuildingSplit && lastSalePrice > 0) {
    if (buildingValue === 0) {
      isNewConstruction = true;
      newConstructionReasons.push('No building value on record (land-only assessment)');
    } else if (buildingValue < lastSalePrice * 0.20) {
      isNewConstruction = true;
      newConstructionReasons.push(`Building assessed at only ${Math.round(buildingValue / lastSalePrice * 100)}% of sale price`);
    }
  }

  // Year-2 estimate: reassessed at purchase price with $50K homestead
  let year2Estimate = null, year2Basis = null;
  if (millageRate && lastSalePrice > 0) {
    year2Estimate = Math.round(Math.max(0, lastSalePrice - 50000) * millageRate);
    year2Basis = `Reassessed at $${Math.round(lastSalePrice).toLocaleString()} purchase price, $50K homestead, effective mill rate ${millagePerThousand.toFixed(4)}`;
  }

  const unitMatch = (p.LEGAL || '').match(/\b(?:UNIT|APT)\s*([A-Z0-9-]+)/i);
  const unitLabel = unitNum ? ` UNIT ${unitNum}` : (unitMatch && candidates.length === 1 && unitMatch[1] !== streetNum ? ` UNIT ${unitMatch[1]}` : '');
  const addressConfirmed = `${p.SITE_ADDRESS}${unitLabel}, ${p.SITE_CITY || ''}, FL ${p.SITE_ZIP || ''}`.replace(/\s+,/g, ',').trim();

  return buildResponse({
    annualTax,
    taxYear: new Date().getFullYear() - 1,
    assessedVal,
    marketVal,
    taxableVal,
    addressConfirmed,
    county: 'Pinellas',
    taxRecordLink: p.STRAP ? `https://www.pcpao.gov/property-details?s=${encodeURIComponent(p.STRAP)}` : 'https://www.pcpao.gov/quick-search?qu=1',
    isNewConstruction,
    newConstructionReasons,
    isHomesteaded,
    homesteadValue,
    allExemptions,
    year2Estimate,
    year2Basis,
    millageRate,
    millagePerThousand,
    lastSalePrice,
    lastSaleDate,
    buildingValue: hasLandBuildingSplit ? buildingValue : null,
    yearBuilt: null,
    taxHistory: [],
    assessmentHistory: [],
  });
}

// ─────────────────────────────────────────────────────────────────
// PASCO COUNTY — search.pascopa.com (GET search → HTML scrape)
// ─────────────────────────────────────────────────────────────────
async function lookupPasco(address, city) {
  const addressParts = address.trim().match(/^(\d+)\s+(.+)$/);
  if (!addressParts) throw new Error('Could not parse Pasco address format.');
  const streetNum = addressParts[1];
  const streetName = addressParts[2];

  const searchUrl = `https://search.pascopa.com/default.aspx?pid=add&key=K%5CI&add1=${encodeURIComponent(streetNum)}&add2=${encodeURIComponent(streetName)}`;
  const searchResp = await fetch(searchUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' }
  });
  if (!searchResp.ok) throw new Error(`Pasco search failed: ${searchResp.status}`);
  const searchHtml = await searchResp.text();

  const parcelMatch = searchHtml.match(/href="[^"]*parcel\.aspx\?parcel=([^"&]+)"/i);
  if (!parcelMatch) throw new Error('Property not found in Pasco County.');
  const parcelId = parcelMatch[1];

  const detailUrl = `https://search.pascopa.com/parcel.aspx?parcel=${encodeURIComponent(parcelId)}`;
  const detailResp = await fetch(detailUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' }
  });
  if (!detailResp.ok) throw new Error(`Pasco detail fetch failed: ${detailResp.status}`);
  const html = await detailResp.text();

  let justValue = null;
  const justMatch = html.match(/(?:just\s*value|market\s*value)[^0-9$]*\$?\s*([0-9,]+)/i);
  if (justMatch) justValue = parseInt(justMatch[1].replace(/,/g, ''), 10);

  let assessedValue = null;
  const assessedMatch = html.match(/(?:assessed\s*value|assessed)[^0-9$]*\$?\s*([0-9,]+)/i);
  if (assessedMatch) assessedValue = parseInt(assessedMatch[1].replace(/,/g, ''), 10);

  let taxableValue = null;
  const taxableMatch = html.match(/(?:taxable\s*value|taxable)[^0-9$]*\$?\s*([0-9,]+)/i);
  if (taxableMatch) taxableValue = parseInt(taxableMatch[1].replace(/,/g, ''), 10);

  let annualTax = null;
  const taxMatch = html.match(/(?:total\s*(?:tax|ad\s*valorem)|ad\s*valorem\s*tax)[^0-9$]*\$?\s*([0-9,]+(?:\.[0-9]{2})?)/i);
  if (taxMatch) annualTax = parseFloat(taxMatch[1].replace(/,/g, ''));

  let millagePerThousand = null;
  const millMatch = html.match(/(?:millage|mill\s*rate)[^0-9]*([0-9]+\.[0-9]+)/i);
  if (millMatch) millagePerThousand = parseFloat(millMatch[1]);

  if (!annualTax && millagePerThousand && taxableValue) {
    annualTax = Math.round(millagePerThousand * taxableValue / 1000 * 100) / 100;
  }

  const isHomesteaded = /homestead\s*exemption[^<]*(?:yes|\$\s*25,000|\$\s*50,000)/i.test(html) ||
    html.match(/homestead[^<]{0,100}(?:\$25,000|\$50,000)/i) !== null;
  const homesteadValue = isHomesteaded ? 50000 : 0;

  const yearRawMatch = html.match(/20[0-9]{2}/);
  const taxYear = yearRawMatch ? parseInt(yearRawMatch[0]) : new Date().getFullYear() - 1;

  let yearBuilt = null;
  const ybMatch = html.match(/(?:year\s*built|yr\s*built)[^0-9]*((?:19|20)[0-9]{2})/i);
  if (ybMatch) yearBuilt = parseInt(ybMatch[1]);

  let buildingValue = null;
  const bvMatch = html.match(/(?:building|improvement)[^0-9$]*\$?\s*([0-9,]+)/i);
  if (bvMatch) buildingValue = parseInt(bvMatch[1].replace(/,/g, ''), 10);

  let lastSalePrice = null, lastSaleDate = null;
  const saleMatch = html.match(/(?:sale\s*price|sold\s*for)[^0-9$]*\$?\s*([0-9,]+)/i);
  if (saleMatch) lastSalePrice = parseInt(saleMatch[1].replace(/,/g, ''), 10);
  const saleDateMatch = html.match(/(?:sale\s*date)[^0-9]*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/i);
  if (saleDateMatch) lastSaleDate = saleDateMatch[1];

  let addressConfirmed = address;
  const addrMatch = html.match(/(?:site|property|situs)\s*address[^:]*:?\s*([^\n<]{5,60})/i);
  if (addrMatch) addressConfirmed = addrMatch[1].trim();

  const currentYear = new Date().getFullYear();
  let isNewConstruction = false, newConstructionReasons = [];
  if (yearBuilt && yearBuilt >= currentYear - 2) {
    isNewConstruction = true; newConstructionReasons.push(`Year built: ${yearBuilt}`);
  }
  if (lastSalePrice > 0 && buildingValue > 0 && buildingValue < lastSalePrice * 0.20) {
    isNewConstruction = true; newConstructionReasons.push(`Building assessed at only ${Math.round(buildingValue / lastSalePrice * 100)}% of sale price`);
  }

  let year2Estimate = null, year2Basis = null, millageRate = null;
  if (millagePerThousand) {
    millageRate = millagePerThousand / 1000;
    if (lastSalePrice > 0) {
      const newTaxableValue = Math.max(0, lastSalePrice - 50000);
      year2Estimate = Math.round(newTaxableValue * millageRate);
      year2Basis = `Reassessed at $${Math.round(lastSalePrice).toLocaleString()} purchase price, $50K homestead, mill rate ${millagePerThousand.toFixed(4)}`;
    }
  }

  return buildResponse({
    annualTax, taxYear, assessedVal: assessedValue, marketVal: justValue, taxableVal: taxableValue,
    addressConfirmed,
    county: 'Pasco',
    taxRecordLink: detailUrl,
    isNewConstruction, newConstructionReasons,
    isHomesteaded, homesteadValue,
    allExemptions: isHomesteaded ? [{ exemptionType: 'Homestead', exemptionValue: homesteadValue }] : [],
    year2Estimate, year2Basis, millageRate, millagePerThousand,
    lastSalePrice, lastSaleDate, buildingValue, yearBuilt,
    taxHistory: [], assessmentHistory: [],
  });
}

// ─────────────────────────────────────────────────────────────────
// MANATEE COUNTY — manateepao.gov JSON PHP endpoints
// ─────────────────────────────────────────────────────────────────
async function lookupManatee(address, city) {
  const searchBody = new URLSearchParams();
  searchBody.set('Address_include_field', 'on');
  searchBody.set('Address', address);
  if (city) {
    searchBody.set('City_include_field', 'on');
    searchBody.set('City', city);
  }
  searchBody.set('draw', '1');
  searchBody.set('start', '0');
  searchBody.set('length', '10');
  searchBody.set('columns[0][data]', '0');
  searchBody.set('columns[0][name]', '');
  searchBody.set('columns[0][searchable]', 'true');
  searchBody.set('columns[0][orderable]', 'false');
  searchBody.set('columns[0][search][value]', '');
  searchBody.set('columns[0][search][regex]', 'false');
  searchBody.set('order[0][column]', '0');
  searchBody.set('order[0][dir]', 'asc');
  searchBody.set('search[value]', '');
  searchBody.set('search[regex]', 'false');

  const searchResp = await fetch('https://www.manateepao.gov/wp-content/themes/frontier-child/models/pao-model-parcel-search-results.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://www.manateepao.gov/search/',
    },
    body: searchBody.toString(),
  });
  if (!searchResp.ok) throw new Error(`Manatee search failed: ${searchResp.status}`);
  const searchData = await searchResp.json();

  const rows = searchData.data || (Array.isArray(searchData) ? searchData : null);
  if (!rows || rows.length === 0) throw new Error('Property not found in Manatee County.');

  let parid = null;
  const firstRow = rows[0];
  for (const cell of firstRow) {
    if (typeof cell === 'string') {
      const match = cell.match(/parid=([0-9]+)/i);
      if (match) { parid = match[1]; break; }
      if (/^[0-9]{7,12}$/.test(cell.trim())) { parid = cell.trim(); break; }
    }
  }
  if (!parid) throw new Error('Could not extract Manatee parcel ID from search results.');

  const valueResp = await fetch(`https://www.manateepao.gov/wp-content/themes/frontier-child/models/pao-model-value-history.php?parid=${parid}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': `https://www.manateepao.gov/parcel/?parid=${parid}` }
  });
  if (!valueResp.ok) throw new Error(`Manatee value history fetch failed: ${valueResp.status}`);
  const valueData = await valueResp.json();

  const salesResp = await fetch(`https://www.manateepao.gov/wp-content/themes/frontier-child/models/pao-model-sales.php?parid=${parid}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': `https://www.manateepao.gov/parcel/?parid=${parid}` }
  });
  let salesData = { data: [] };
  if (salesResp.ok) { try { salesData = await salesResp.json(); } catch(e) {} }

  const cleanCell = (v) => {
    if (typeof v !== 'string') return String(v || '');
    return v.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/,/g, '').trim();
  };

  const valueRows = valueData.data || (Array.isArray(valueData) ? valueData : []);
  let annualTax = null, taxYear = null, justValue = null, assessedValue = null;
  let taxableValue = null, isHomesteaded = false, homesteadValue = 0;
  let taxHistory = [];

  if (valueRows.length > 0) {
    const latestRow = valueRows[0];
    const cells = Array.isArray(latestRow) ? latestRow : Object.values(latestRow);

    let yearIdx = -1, homesteadIdx = -1;
    const numericCells = [];

    cells.forEach((cell, idx) => {
      const clean = cleanCell(cell);
      if (/^20[0-9]{2}$/.test(clean)) yearIdx = idx;
      else if (/^(yes|no)$/i.test(clean)) homesteadIdx = idx;
      else {
        const numStr = clean.replace(/[,$\s]/g, '');
        if (/^[0-9]+(\.[0-9]+)?$/.test(numStr) && numStr.length > 0) {
          numericCells.push({ idx, val: parseFloat(numStr) });
        }
      }
    });

    if (yearIdx >= 0) taxYear = parseInt(cleanCell(cells[yearIdx]));
    if (homesteadIdx >= 0) {
      isHomesteaded = /yes/i.test(cleanCell(cells[homesteadIdx]));
      homesteadValue = isHomesteaded ? 50000 : 0;
    }

    numericCells.sort((a, b) => a.idx - b.idx);
    if (numericCells.length >= 6) {
      justValue = numericCells[2]?.val || null;
      taxableValue = numericCells[3]?.val || null;
      const adValorem = numericCells[4]?.val || 0;
      const nonAdValorem = numericCells[5]?.val || 0;
      annualTax = adValorem > 0 ? Math.round((adValorem + nonAdValorem) * 100) / 100 : null;
    } else if (numericCells.length >= 4) {
      justValue = numericCells[1]?.val || null;
      taxableValue = numericCells[2]?.val || null;
      annualTax = numericCells[3]?.val || null;
    }
    assessedValue = taxableValue;

    taxHistory = valueRows.slice(0, 5).map(row => {
      const rc = Array.isArray(row) ? row : Object.values(row);
      return rc.map(c => cleanCell(c)).join(' | ');
    });
  }

  if (!taxYear) taxYear = new Date().getFullYear() - 1;

  let lastSalePrice = null, lastSaleDate = null;
  const salesRows = salesData.data || (Array.isArray(salesData) ? salesData : []);
  if (salesRows.length > 0) {
    const sr = Array.isArray(salesRows[0]) ? salesRows[0] : Object.values(salesRows[0]);
    for (const cell of sr) {
      const clean = cleanCell(cell);
      if (!lastSalePrice && /^[0-9]{6,}$/.test(clean)) {
        lastSalePrice = parseInt(clean, 10);
      }
      if (!lastSaleDate && /[0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{4}/.test(clean)) {
        lastSaleDate = clean;
      }
    }
  }

  let isNewConstruction = false, newConstructionReasons = [];
  if (lastSalePrice > 0 && (!annualTax || annualTax === 0)) {
    isNewConstruction = true; newConstructionReasons.push('No tax record found (possible new construction)');
  }

  let millagePerThousand = null, millageRate = null;
  if (annualTax && taxableValue && taxableValue > 0) {
    millageRate = annualTax / taxableValue;
    millagePerThousand = parseFloat((millageRate * 1000).toFixed(4));
  }

  let year2Estimate = null, year2Basis = null;
  if (millageRate && lastSalePrice > 0) {
    const newTaxableValue = Math.max(0, lastSalePrice - 50000);
    year2Estimate = Math.round(newTaxableValue * millageRate);
    year2Basis = `Reassessed at $${Math.round(lastSalePrice).toLocaleString()} purchase price, $50K homestead, mill rate ${(millageRate * 1000).toFixed(4)}`;
  }

  let addressConfirmed = address;
  if (firstRow && firstRow.length > 1) {
    const addrCell = firstRow[1];
    if (typeof addrCell === 'string' && addrCell.length > 5) {
      addressConfirmed = addrCell.replace(/<[^>]+>/g, '').trim() || address;
    }
  }

  return buildResponse({
    annualTax, taxYear, assessedVal: assessedValue, marketVal: justValue, taxableVal: taxableValue,
    addressConfirmed,
    county: 'Manatee',
    taxRecordLink: `https://www.manateepao.gov/parcel/?parid=${parid}`,
    isNewConstruction, newConstructionReasons,
    isHomesteaded, homesteadValue,
    allExemptions: isHomesteaded ? [{ exemptionType: 'Homestead', exemptionValue: homesteadValue }] : [],
    year2Estimate, year2Basis, millageRate, millagePerThousand,
    lastSalePrice, lastSaleDate,
    buildingValue: null, yearBuilt: null,
    taxHistory, assessmentHistory: [],
  });
}

// ─────────────────────────────────────────────────────────────────
// Shared response builder — produces the shape index.html expects
// ─────────────────────────────────────────────────────────────────
function buildResponse({
  annualTax, taxYear, assessedVal, marketVal, taxableVal,
  addressConfirmed, county, taxRecordLink,
  isNewConstruction, newConstructionReasons,
  isHomesteaded, homesteadValue, allExemptions,
  year2Estimate, year2Basis, millageRate, millagePerThousand,
  lastSalePrice, lastSaleDate, buildingValue, yearBuilt,
  taxHistory, assessmentHistory,
}) {
  return {
    annual_tax: annualTax,
    tax_year: taxYear,
    assessed_value: assessedVal,
    just_value: marketVal,
    taxable_value: taxableVal,
    address_confirmed: addressConfirmed,
    county: county,
    tax_record_link: taxRecordLink,
    is_new_construction: isNewConstruction,
    new_construction_reasons: newConstructionReasons || [],
    is_homesteaded: isHomesteaded,
    homestead_value: homesteadValue || 0,
    all_exemptions: allExemptions || [],
    _internal: {
      year2_estimate: year2Estimate,
      year2_basis: year2Basis,
      millage_rate: millageRate,
      millage_per_thousand: millagePerThousand,
      last_sale_price: lastSalePrice,
      last_sale_date: lastSaleDate,
      building_value: buildingValue,
      year_built: yearBuilt,
      realie_parcel_id: null,
      tax_history: taxHistory || [],
      assessment_history: assessmentHistory || [],
    },
  };
}
