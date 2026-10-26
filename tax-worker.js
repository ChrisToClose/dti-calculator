// ChrisToClose DTI Calculator — Tax & Property Lookup Worker
// Requires secrets: ANTHROPIC_API_KEY, REALIE_API_KEY

export default {
  async fetch(request, env, ctx) {
    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ── /realie-lookup route ───────────────────────────────────────
    // Accepts JSON: { address, city, state, county (optional) }
    // Returns: tax data, new construction flag, year 2 estimate (server-side)
    if (url.pathname === '/realie-lookup' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { address, city, state, county } = body;

        if (!address || !state) {
          return new Response(JSON.stringify({ error: 'Address and state are required.' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Normalize city names to match Realie's database spellings
        const cityNormalized = city ? city
          .replace(/^St\.?\s+Pete(rsburg)?$/i, 'Saint Petersburg')
          .replace(/^St\.?\s+Petersburg$/i, 'Saint Petersburg')
          .replace(/^Ft\.?\s+Lauderdale$/i, 'Fort Lauderdale')
          .replace(/^Ft\.?\s+Myers$/i, 'Fort Myers')
          .replace(/^Ft\.?\s+Pierce$/i, 'Fort Pierce')
          .replace(/^Ft\.?\s+Walton\s+Beach$/i, 'Fort Walton Beach')
          .trim() : city;

        // Build Realie API query params
        // NOTE: Realie requires county whenever city is provided (400 otherwise)
        const params = new URLSearchParams();
        params.set('address', address);
        params.set('state', state);
        if (cityNormalized && county) {
          params.set('city', cityNormalized);
          params.set('county', county);
        } else if (county) {
          params.set('county', county);
        }
        // city alone (no county) is intentionally omitted — Realie returns 400

        const realieUrl = `https://app.realie.ai/api/public/property/address/?${params.toString()}`;

        const realieResponse = await fetch(realieUrl, {
          method: 'GET',
          headers: {
            'Authorization': env.REALIE_API_KEY,
            'Content-Type': 'application/json',
          },
        });

        if (!realieResponse.ok) {
          const errText = await realieResponse.text();
          console.error('Realie API error:', realieResponse.status, errText);
          let errDetail;
          try { errDetail = JSON.parse(errText); } catch(e) { errDetail = errText; }
          if (realieResponse.status === 400) {
            return new Response(JSON.stringify({ error: 'Invalid address format. Please check the address and try again.', _detail: String(errDetail).slice(0, 200) }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          if (realieResponse.status === 401 || realieResponse.status === 403) {
            return new Response(JSON.stringify({ error: 'API authentication error. Contact Chris.', _detail: String(errDetail).slice(0, 200) }), {
              status: 502,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          if (realieResponse.status === 404) {
            return new Response(JSON.stringify({ error: 'Property not found. Try including city and state in your search.', _detail: String(errDetail).slice(0, 200) }), {
              status: 404,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ error: 'Property lookup failed. Please try again.', _status: realieResponse.status, _detail: String(errDetail).slice(0, 200) }), {
            status: 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const property = await realieResponse.json();

        // ── Extract tax & valuation fields ──────────────────────────
        const taxInfo = property.taxInformation || {};
        const valuation = property.valuationInformation || {};
        const salesHistory = property.salesHistory || [];
        const buildings = (property.buildingInformation || {}).buildings || [];
        const primaryBuilding = buildings[0] || {};
        const propLocation = property.propertyLocation || {};
        const propId = property.propertyIdentification || {};

        // Current tax data
        const annualTax = taxInfo.taxAmount || null;
        const taxYear = taxInfo.taxYear || null;
        const totalAssessedValue = valuation.totalAssessedValue || null;
        const totalJustValue = valuation.totalJustValue || valuation.totalMarketValue || null;
        const taxableValue = valuation.taxableValue || null;
        const totalExemptionsValue = valuation.totalExemptionsValue || 0;
        const exemptions = valuation.exemptions || [];

        // Homestead detection
        const homesteadExemption = exemptions.find(e => e.exemptionType === 'Homestead');
        const isHomesteaded = !!homesteadExemption;
        const homesteadValue = homesteadExemption ? homesteadExemption.exemptionValue : 0;

        // Most recent arms-length sale
        const lastSale = salesHistory.find(s => s.armsLength === true) || salesHistory[0] || null;
        const lastSalePrice = lastSale ? lastSale.salePrice : null;
        const lastSaleDate = lastSale ? lastSale.saleDate : null;

        // ── New construction detection ──────────────────────────────
        const currentYear = new Date().getFullYear();
        const yearBuilt = primaryBuilding.actualYearBuilt || null;
        const buildingValue = primaryBuilding.buildingValue || valuation.totalBuildingValue || 0;
        const salePrice = lastSalePrice || 0;

        let isNewConstruction = false;
        let newConstructionReasons = [];

        // Signal 1: Built within last 2 years
        if (yearBuilt && yearBuilt >= currentYear - 2) {
          isNewConstruction = true;
          newConstructionReasons.push(`Year built: ${yearBuilt}`);
        }

        // Signal 2: Building value suspiciously low vs sale price (land-only on record)
        if (salePrice > 0 && buildingValue > 0 && buildingValue < salePrice * 0.20) {
          isNewConstruction = true;
          newConstructionReasons.push(`Building assessed at only ${Math.round(buildingValue / salePrice * 100)}% of sale price`);
        }
        // Also flag if building value is literally $0 or missing with a recent sale
        if (salePrice > 0 && (!buildingValue || buildingValue === 0)) {
          isNewConstruction = true;
          newConstructionReasons.push('No improvement value on record (land-only assessment)');
        }

        // Signal 3: No prior arms-length sales (builder/developer as prior owner)
        const armsLengthSales = salesHistory.filter(s => s.armsLength === true);
        if (armsLengthSales.length === 0 && salesHistory.length > 0) {
          isNewConstruction = true;
          newConstructionReasons.push('No prior arms-length sales on record');
        }

        // ── Year 2 tax estimate (server-side only, not shown to client) ─
        // Formula: (purchasePrice - homesteadExemption) × millageRate
        // Millage rate derived from current: taxAmount / taxableValue
        let year2Estimate = null;
        let millageRate = null;
        let year2Basis = null;

        if (annualTax && taxableValue && taxableValue > 0) {
          millageRate = annualTax / taxableValue; // as decimal (e.g. 0.018 = 18 mills)

          if (lastSalePrice && lastSalePrice > 0) {
            // New buyer will be assessed at purchase price minus exemptions if they homestead
            const buyerHomestead = 50000; // standard FL homestead exemption
            const newTaxableValue = Math.max(0, lastSalePrice - buyerHomestead);
            year2Estimate = Math.round(newTaxableValue * millageRate);
            year2Basis = `Reassessed at $${Math.round(lastSalePrice).toLocaleString()} purchase price, $50K homestead, mill rate ${(millageRate * 1000).toFixed(2)}`;
          }
        }

        // ── Assemble response ───────────────────────────────────────
        const result = {
          // Client-facing fields
          annual_tax: annualTax,
          tax_year: taxYear,
          assessed_value: totalAssessedValue,
          just_value: totalJustValue,
          taxable_value: taxableValue,
          address_confirmed: propLocation.fullAddress || property.address,
          county: propId.county || null,
          tax_record_link: taxInfo.taxRecordLink || null,

          // New construction flag (shown to client as warning)
          is_new_construction: isNewConstruction,
          new_construction_reasons: newConstructionReasons,

          // Homestead flag (shown to client)
          is_homesteaded: isHomesteaded,
          homestead_value: homesteadValue,
          all_exemptions: exemptions,

          // Year 2 estimate — for Chris's reference / future Airtable, not shown to client
          _internal: {
            year2_estimate: year2Estimate,
            year2_basis: year2Basis,
            millage_rate: millageRate,
            millage_per_thousand: millageRate ? parseFloat((millageRate * 1000).toFixed(4)) : null,
            last_sale_price: lastSalePrice,
            last_sale_date: lastSaleDate,
            building_value: buildingValue,
            year_built: yearBuilt,
            realie_parcel_id: property.realieParcelId || null,
            tax_history: taxInfo.taxHistory || [],
            assessment_history: property.assessmentHistory || [],
          },
        };

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

      } catch (err) {
        console.error('Realie lookup error:', err);
        return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
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

        // Convert file to base64
        const arrayBuffer = await file.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        const mediaType = file.type || 'image/jpeg';

        // Check file size (max 5MB)
        if (arrayBuffer.byteLength > 5 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: 'File too large. Please upload an image under 5MB.' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Call Claude API
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

        // Parse the JSON response from Claude
        let result;
        try {
          // Extract JSON if wrapped in markdown code blocks
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

    // ── All other routes — 404 ─────────────────────────────────────
    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};
