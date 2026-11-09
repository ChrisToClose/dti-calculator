// ============================================================
// REALIE LAB — throwaway test Worker for the Realie bake-off (C6)
// Name: christoclose-realie-lab  (NEVER christoclose-tax or christoclose-api)
// Nothing on the calculator uses this. Delete it when the bake-off is done.
//
// Open in a browser:  https://christoclose-realie-lab.christoclose.workers.dev/
// Type a Pinellas address (+ unit) → shows Realie vs Pinellas County side by side.
//
// Secret:  REALIE_API_KEY  (pasted by Chris in Cloudflare — never in code or chat)
// Binding: LAB_KV — daily cap on Realie calls so nobody can run up the bill.
// Only tax-related fields are shown — no owner, mortgage or equity data.
// ============================================================

const REALIE_URL = 'https://app.realie.ai/api/public/property/address/';
const PINELLAS_PARCELS_URL = 'https://egis.pinellas.gov/gis/rest/services/PublicWebGIS/Parcels/MapServer/1/query';
const MAX_REALIE_CALLS_PER_DAY = 15;   // at $0.15 each past the free 25 → at most $2.25/day

const DIRS = { NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW' };
const DIR_SET = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);
const TYPES = {
  STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', DRIVE: 'DR', ROAD: 'RD', BOULEVARD: 'BLVD', LANE: 'LN',
  COURT: 'CT', CIRCLE: 'CIR', PLACE: 'PL', TERRACE: 'TER', CROSSING: 'XING', PARKWAY: 'PKWY',
  HIGHWAY: 'HWY', TRAIL: 'TRL', POINT: 'PT', COVE: 'CV', SQUARE: 'SQ', WAY: 'WAY', ISLE: 'IS', ISLAND: 'IS', HARBOR: 'HBR',
};
const norm = (s) => String(s || '').toUpperCase().replace(/[.,#]/g, ' ').split(/\s+/).filter(Boolean).map((t) => DIRS[t] || TYPES[t] || t);
const digits = (s) => String(s || '').replace(/\D/g, '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return new Response('Not allowed', { status: 405 });
    if (url.pathname === '/') return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (url.pathname === '/compare') return compare(url, env);
    return new Response('Not found', { status: 404 });
  },
};

async function compare(url, env) {
  const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const address = (url.searchParams.get('address') || '').trim().slice(0, 120);
  const unit = (url.searchParams.get('unit') || '').trim().replace(/^(APT|UNIT|STE|SUITE|#)\.?\s*/i, '').slice(0, 20);
  if (!/^\d+[A-Z]?\s+\S+/i.test(address)) return json({ error: 'Enter a street address like "4900 Brittany Dr S".' }, 400);
  if (!env.REALIE_API_KEY) return json({ error: 'REALIE_API_KEY secret is not set on christoclose-realie-lab.' }, 503);
  if (!env.LAB_KV) return json({ error: 'LAB_KV binding missing.' }, 503);

  // Daily cap (counts every Realie call)
  const dayKey = 'calls:' + new Date().toISOString().slice(0, 10);
  const used = parseInt(await env.LAB_KV.get(dayKey), 10) || 0;
  if (used >= MAX_REALIE_CALLS_PER_DAY) return json({ error: `Daily test cap of ${MAX_REALIE_CALLS_PER_DAY} Realie lookups reached. Try again tomorrow.` }, 429);
  await env.LAB_KV.put(dayKey, String(used + 1), { expirationTtl: 172800 });

  const [realie, county] = await Promise.all([realieLookup(address, unit, env.REALIE_API_KEY), pinellasLookup(address, unit)]);

  const verdict = {};
  if (realie.found && county.found) {
    verdict.sameParcel = digits(realie.parcelId) === digits(county.parcelId) || digits(realie.parcelId).endsWith(digits(county.strap)) || digits(county.strap) === digits(realie.oldParcelId);
    verdict.taxDifference = realie.taxAmount != null && county.taxes != null ? Math.round((realie.taxAmount - county.taxes) * 100) / 100 : null;
    verdict.homesteadMatches = realie.homestead === county.homestead;
  }
  return json({ query: { address, unit }, realie, county, verdict, realieCallsToday: used + 1 });
}

async function realieLookup(address, unit, key) {
  const q = new URLSearchParams({ state: 'FL', address });
  if (unit) q.set('unitNumberStripped', unit);
  const t0 = Date.now();
  let r, body;
  try {
    r = await fetch(REALIE_URL + '?' + q.toString(), { headers: { Authorization: key }, signal: AbortSignal.timeout(10000) });
    body = await r.json().catch(() => ({}));
  } catch (e) {
    return { found: false, error: 'Realie did not respond: ' + (e && e.message) };
  }
  const ms = Date.now() - t0;
  if (!r.ok) return { found: false, status: r.status, error: body.error || 'error', code: body.code || null, ms };
  const p = body.property || {};
  const pid = p.propertyIdentification || {};
  const loc = p.propertyLocation || {};
  const val = p.valuationInformation || {};
  const tax = p.taxInformation || {};
  const ex = Array.isArray(val.exemptions) ? val.exemptions : [];
  return {
    found: true, status: r.status, ms,
    parcelId: p.parcelId || pid.parcelId || null,
    oldParcelId: pid.oldParcelId || null,
    addressFull: loc.addressFull || null,
    unit: loc.unitNumberStripped || null,
    county: pid.county || null,
    taxAmount: tax.taxAmount ?? null,
    taxYear: tax.taxYear ?? null,
    homestead: ex.some((e) => /homestead/i.test(e.exemptionType || '')),
    exemptions: ex.map((e) => e.exemptionType),
    assessedValue: val.totalAssessedValue ?? null,
    taxableValue: val.taxableValue ?? null,
    marketValue: val.totalMarketValue ?? null,
    assessmentYear: val.assessmentYear ?? null,
    otherMatches: Array.isArray(body.otherResults) ? body.otherResults.length : null,
    shape: p.propertyIdentification ? 'v3 (nested)' : 'v2 (flat)',
  };
}

// Pinellas County parcel layer — STRICT: exact street match + unit from the legal description.
async function pinellasLookup(address, unit) {
  const tokens = norm(address);
  const num = tokens[0];
  const core = tokens.slice(1).find((t) => !DIR_SET.has(t)) || tokens[1];
  const target = tokens.join(' ');
  const q = new URLSearchParams({
    where: `SITE_NUM='${num.replace(/'/g, "''")}' AND SITE_ADDRESS LIKE '%${String(core).replace(/'/g, "''")}%'`,
    outFields: 'PARCELID_DSP1,STRAP,TAXABLE_VALUE,HOMESTEAD,HOMESTEAD_EXEMP,TAXES,SITE_ADDRESS,SITE_CITY,LEGAL',
    returnGeometry: 'false', resultRecordCount: '1000', f: 'json',
  });
  let data;
  try {
    const r = await fetch(PINELLAS_PARCELS_URL + '?' + q.toString(), { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (ChrisToClose realie lab)' }, signal: AbortSignal.timeout(10000) });
    data = await r.json();
  } catch (e) {
    return { found: false, error: 'County did not respond: ' + (e && e.message) };
  }
  let c = (data.features || []).map((f) => f.attributes).filter((a) => norm(a.SITE_ADDRESS).join(' ') === target);
  if (!c.length) return { found: false, error: 'No exact street match in county records' };
  if (unit) {
    const re = new RegExp(`\\b(?:UNIT|APT|STE|SUITE|#)\\s*0*${unit.replace(/^0+(?=.)/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const byUnit = c.filter((a) => re.test(a.LEGAL || ''));
    if (byUnit.length) c = byUnit;
  }
  if (c.length > 1) return { found: false, error: `${c.length} county parcels at this address — add the unit number` };
  const a = c[0];
  return {
    found: true,
    parcelId: a.PARCELID_DSP1 || null,
    strap: a.STRAP || null,
    address: a.SITE_ADDRESS + (unit ? ' #' + unit : '') + ', ' + (a.SITE_CITY || ''),
    taxes: a.TAXES != null ? Number(a.TAXES) : null,
    taxableValue: a.TAXABLE_VALUE != null ? Number(a.TAXABLE_VALUE) : null,
    homestead: String(a.HOMESTEAD || '').toUpperCase() === 'YES' || Number(a.HOMESTEAD_EXEMP) > 0,
    legal: (a.LEGAL || '').slice(0, 90),
  };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Realie bake-off (lab)</title>
<style>
body{font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#1B2A41;background:#F3F5F9}
h1{font-size:20px;color:#1B3A6B}.note{font-size:13px;color:#5a6a80}
form{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}input{padding:10px;border:1px solid #c8d0dc;border-radius:6px;font-size:15px}
#a{flex:1;min-width:220px}#u{width:90px}button{padding:10px 16px;background:#1B3A6B;color:#fff;border:0;border-radius:6px;font-weight:bold;font-size:15px}
table{width:100%;border-collapse:collapse;background:#fff;font-size:13px;margin-top:10px}th,td{border:1px solid #e1e6ee;padding:7px;text-align:left;vertical-align:top}
th{background:#2B7FA4;color:#fff}.ok{color:#1e8e4e;font-weight:bold}.bad{color:#c0392b;font-weight:bold}
</style></head><body>
<h1>Realie vs Pinellas County — bake-off (test only)</h1>
<p class="note">Pinellas addresses only. Each check uses 1 Realie lookup ($0.15 past the free 25). Capped at ${MAX_REALIE_CALLS_PER_DAY} per day. Only tax fields are shown.</p>
<form id="f"><input id="a" placeholder="Street address, e.g. 4900 Brittany Dr S" required><input id="u" placeholder="Unit"><button>Compare</button></form>
<table><thead><tr><th>#</th><th>Address</th><th>Same parcel?</th><th>Realie tax (year)</th><th>County TAXES</th><th>Diff</th><th>Homestead R / C</th><th>Notes</th></tr></thead><tbody id="rows"></tbody></table>
<p class="note">Tip: when done, use your browser's Print → Save as PDF on this page and send it to Claude.</p>
<script>
var n=0;
document.getElementById('f').addEventListener('submit',async function(e){e.preventDefault();
var a=document.getElementById('a').value,u=document.getElementById('u').value;
var tr=document.createElement('tr');tr.innerHTML='<td>'+(++n)+'</td><td colspan="7">Checking…</td>';document.getElementById('rows').appendChild(tr);
try{var r=await fetch('/compare?address='+encodeURIComponent(a)+'&unit='+encodeURIComponent(u));var d=await r.json();
if(d.error){tr.innerHTML='<td>'+n+'</td><td>'+esc(a+(u?' #'+u:''))+'</td><td colspan="6" class="bad">'+esc(d.error)+'</td>';return;}
var R=d.realie,C=d.county,V=d.verdict||{};
var sp=V.sameParcel===true?'<span class="ok">Yes</span>':V.sameParcel===false?'<span class="bad">NO</span>':'—';
var diff=V.taxDifference==null?'—':'<span class="'+(Math.abs(V.taxDifference)<=25?'ok':'bad')+'">'+(V.taxDifference>0?'+':'')+V.taxDifference.toFixed(2)+'</span>';
var notes=[];if(!R.found)notes.push('Realie: '+(R.status||'')+' '+(R.error||''));if(!C.found)notes.push('County: '+(C.error||''));
if(R.found){notes.push('Realie '+R.shape+', '+R.ms+'ms'+(R.otherMatches?', other matches: '+R.otherMatches:''));notes.push('Realie parcel '+R.parcelId+' | County '+(C.parcelId||'—'));}
tr.innerHTML='<td>'+n+'</td><td>'+esc((R.addressFull||C.address||a))+'</td><td>'+sp+'</td><td>'+(R.found&&R.taxAmount!=null?'$'+R.taxAmount.toFixed(2)+' ('+R.taxYear+')':'—')+'</td><td>'+(C.found&&C.taxes!=null?'$'+C.taxes.toFixed(2):'—')+'</td><td>'+diff+'</td><td>'+(R.found?(R.homestead?'Yes':'No'):'—')+' / '+(C.found?(C.homestead?'Yes':'No'):'—')+'</td><td>'+esc(notes.join(' · '))+'</td>';
}catch(err){tr.innerHTML='<td>'+n+'</td><td colspan="7" class="bad">'+esc(String(err))+'</td>';}});
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
</script></body></html>`;
