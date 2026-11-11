/* ============================================================
   christoclose-calc — serves the calculator at calc.christoclose.com
   ------------------------------------------------------------
   • Every page and file comes straight from the GitHub copy
     (christoclose.github.io/dti-calculator) — nothing is stored here.
   • Short client links (?s=XXXXXXXXXX) get their own text-message
     preview caption, e.g. "Sarah’s Home Payment Estimate"
     "$400K home · Pinellas · Nov 10". Only the client's FIRST name,
     the price, county and date are used — never income or debts.
   • Read-only: this Worker never writes or deletes anything.
   • Separate from christoclose-tax and christoclose-api (Tick by Tick).
   ============================================================ */

const GITHUB = 'https://christoclose.github.io/dti-calculator';
const SITE = 'https://calc.christoclose.com';
const LINK_ID_RE = /^[A-Za-z0-9]{10}$/;
const DEFAULT_IMAGE = GITHUB + '/og-image-1200x630-3.png';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',                 // nobody can show the calculator inside their own page
  'Referrer-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
};
const PASS_HEADERS = ['content-type', 'cache-control', 'last-modified', 'etag', 'expires'];

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', ...SECURITY_HEADERS } });
    }
    const url = new URL(request.url);
    if (url.protocol === 'http:') { url.protocol = 'https:'; return Response.redirect(url.toString(), 301); }

    // The page asks for its own files at /dti-calculator/... (fonts) — same files as /...
    let path = url.pathname;
    if (path === '/dti-calculator' || path.startsWith('/dti-calculator/')) path = path.slice('/dti-calculator'.length) || '/';
    if (path.includes('..') || path.includes('//') || path.includes('\\')) return notFound();
    if (path === '/preview') return Response.redirect(SITE + '/preview/' + url.search, 301);

    let upstream;
    try {
      upstream = await fetch(GITHUB + path, { method: request.method, redirect: 'manual', cf: { cacheTtl: 300 } });
    } catch (e) {
      return new Response('The calculator is having trouble loading. Please try again in a minute.', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });
    }

    const headers = new Headers(SECURITY_HEADERS);
    for (const h of PASS_HEADERS) { const v = upstream.headers.get(h); if (v) headers.set(h, v); }

    // GitHub redirects (e.g. a folder without its "/") must stay on calc.christoclose.com
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get('location') || '';
      const fixed = loc.startsWith(GITHUB) ? SITE + loc.slice(GITHUB.length) : loc.startsWith('/dti-calculator') ? SITE + loc.slice('/dti-calculator'.length) : null;
      if (!fixed) return notFound();
      return Response.redirect(fixed, upstream.status === 301 ? 301 : 302);
    }

    const type = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !type.includes('text/html') || request.method === 'HEAD') {
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    // HTML page: point the preview at this address, and caption short client links
    const id = url.searchParams.get('s') || '';
    let caption = null;
    if (LINK_ID_RE.test(id) && env.LOOKUP_KV) {
      try {
        const raw = await env.LOOKUP_KV.get('link:' + id);
        if (raw) caption = buildCaption(JSON.parse(raw).p || {});
      } catch (e) { caption = null; }
    }
    const pageUrl = SITE + path + (caption ? '?s=' + id : '');
    const html = rewriteMeta(await upstream.text(), caption, pageUrl);
    if (caption) headers.set('Cache-Control', 'private, no-store');   // each link's caption is its own
    headers.delete('etag'); headers.delete('last-modified');
    return new Response(html, { status: 200, headers });
  },
};

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });
}

// ─── Caption pieces (all cleaned — nothing from the link is trusted) ───
function firstName(nm) {
  const word = String(nm || '').trim().split(/\s+/)[0] || '';
  const clean = word.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ'’-]/g, '').slice(0, 20);
  if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(clean)) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function shortPrice(pp) {
  const n = Number(String(pp || '').replace(/[^0-9.]/g, ''));
  if (!isFinite(n) || n < 10000 || n > 100000000) return '';
  if (n >= 1000000) return '$' + (Math.round(n / 10000) / 100).toString() + 'M';
  return '$' + Math.round(n / 1000) + 'K';
}

function buildCaption(p) {
  const name = firstName(p.nm);
  const title = name ? name + '\u2019s Home Payment Estimate' : 'Your Home Payment Estimate';
  const parts = [];
  const price = shortPrice(p.pp);
  if (price) parts.push(price + ' home');
  const county = String(p.cn || '').replace(/[^A-Za-z .'-]/g, '').trim().slice(0, 30);
  if (county) parts.push(county);
  const date = String(p.ts || '').replace(/,?\s*\d{4}\s*$/, '').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 12);
  if (/^[A-Z][a-z]{2} \d{1,2}$/.test(date)) parts.push(date);
  const description = parts.length ? parts.join(' \u00b7 ') : 'Your personalized Housing Payment Calculator from Chris Greenidge at American Pacific Mortgage.';
  return { title, description };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setMeta(html, attr, key, value) {
  const re = new RegExp('<meta\\s+' + attr + '="' + key.replace(/[:]/g, '\\:') + '"\\s+content="[^"]*"\\s*/?>', 'i');
  const tag = '<meta ' + attr + '="' + key + '" content="' + esc(value) + '">';
  if (re.test(html)) return html.replace(re, () => tag);
  return html.replace(/<\/head>/i, () => tag + '\n</head>');
}

function rewriteMeta(html, caption, pageUrl) {
  html = setMeta(html, 'property', 'og:url', pageUrl);
  if (!caption) return html;
  html = setMeta(html, 'property', 'og:title', caption.title);
  html = setMeta(html, 'property', 'og:description', caption.description);
  html = setMeta(html, 'property', 'og:image', DEFAULT_IMAGE);
  html = setMeta(html, 'name', 'twitter:title', caption.title);
  html = setMeta(html, 'name', 'twitter:description', caption.description);
  html = html.replace(/<title>[^<]*<\/title>/i, () => '<title>' + esc(caption.title) + '</title>');
  return html;
}
