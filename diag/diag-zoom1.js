/* TEMPORARY DIAGNOSTIC (branch diag-zoom1 only — never merged to main).
   Question: GitHub's test machine says the lender screen is 328px wide on a 320px phone. Which element
   sticks out, in which font, and does the page that is LIVE today do the same thing there?
   Prints facts only. Changes nothing. */
const path = require('path'), fs = require('fs'), http = require('http');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { return '(not available)'; } };
const r1 = (n) => Math.round(n * 10) / 10;

const measure = () => {
  const r1 = (n) => Math.round(n * 10) / 10;
  const W = document.documentElement.clientWidth;
  const out = Array.from(document.querySelectorAll('body *')).filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > W + 0.5 && r.left < W && getComputedStyle(e).position !== 'fixed';
  });
  const leaf = out.filter((e) => !out.some((o) => o !== e && e.contains(o)));
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : '');
  const inner = document.querySelector('.setup-header-inner');
  const shown = inner && inner.getBoundingClientRect().width > 0;
  return {
    W, scrollW: document.documentElement.scrollWidth,
    leaf: leaf.map((e) => { const r = e.getBoundingClientRect(); return `${name(e)} "${(e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 26)}" x ${r1(r.left)}-${r1(r.right)}`; }),
    hdr: shown ? Array.from(inner.children).map((k) => { const r = k.getBoundingClientRect(); return `${r1(r.left)}-${r1(r.right)} (w ${r1(r.width)}, top ${r1(r.top)})`; }) : null,
    hdrH: shown ? r1(inner.getBoundingClientRect().height) : null,
  };
};

(async () => {
  console.log('== the machine ==');
  let pwv = '?'; try { pwv = require('playwright/package.json').version; } catch (e) {}
  console.log('os:', sh('lsb_release -ds'), '| playwright', pwv, '| chromium', chromium.executablePath().split('/').slice(-3, -2)[0]);
  for (const f of ['Segoe UI', 'system-ui', '-apple-system', 'sans-serif', 'Bebas Neue', 'Raleway']) console.log(`  font asked "${f}" -> machine gives:`, sh(`fc-match -- "${f}"`));
  console.log('  families installed:', sh('fc-list : family | sort -u | tr "\\n" ";"').slice(0, 2500));

  /* a tiny local web server, so the page's own title fonts load the way they do on the real site */
  const types = { '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!p.startsWith('/dti-calculator/')) { res.writeHead(404); return res.end(); }
    p = p.slice('/dti-calculator/'.length); if (p === '' || p.endsWith('/')) p += 'index.html';
    const fp = path.join(ROOT, p);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(fp)] || 'application/octet-stream', 'access-control-allow-origin': '*' });
    fs.createReadStream(fp).pipe(res);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const PORT = server.address().port;

  const browser = await chromium.launch();
  const FIX = '.setup-header-inner { flex-wrap: wrap; row-gap: 6px; }';   // candidate only — measured, not shipped
  for (const mode of ['file (how the tests run: title fonts do not load)', 'http (title fonts load, like the real site)']) {
    const viaHttp = mode.startsWith('http');
    for (const file of ['index.html', 'preview/index.html']) {
      const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const ver = (html.match(/version:\s*['"]([\d.]+)['"]/) || [])[1];
      console.log(`\n== ${mode} · ${file} (v${ver}) ==`);
      for (const width of [320, 344, 360, 375, 390, 430]) {
        const ctx = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, timezoneId: 'America/New_York', locale: 'en-US' });
        await ctx.route('**/*', (r) => { const u = r.request().url(); return (u.startsWith('file:') || u.startsWith(`http://127.0.0.1:${PORT}/`)) ? r.continue() : r.abort(); });
        const page = await ctx.newPage();
        const base = viaHttp ? `http://127.0.0.1:${PORT}/dti-calculator/${file === 'index.html' ? '' : 'preview/'}` : 'file://' + path.join(ROOT, file);
        await page.goto(base);
        await page.waitForFunction(() => typeof calcAll === 'function' && typeof S === 'object');
        await page.evaluate(() => document.fonts.ready);
        const url = await page.evaluate(() => { S.clientName = 'Test'; S.income = 9000; S.otherDebts = 500; S.purchasePrice = 400000; S.rate = 6.5; setLocation('Pinellas', COUNTIES['Pinellas']); refreshAll(); return buildClientUrl(); });
        await page.evaluate(() => document.querySelectorAll('#setup-page .pencil-btn').forEach((b) => b.click()));
        const L = await page.evaluate(measure);
        let fonts = '';
        if (width === 320) {
          const cdp = await ctx.newCDPSession(page);
          await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
          const { root } = await cdp.send('DOM.getDocument');
          const used = [];
          for (const [label, sel] of [['brand', '.setup-header-inner > div:first-child > div:nth-child(1)'], ['title', '.setup-header-inner > div:first-child > div:nth-child(2)'], ['version', '.setup-header-inner .app-version'], ['badge', '.setup-header-badge'], ['a text box', '#income']]) {
            const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
            if (!nodeId) { used.push(`${label}: (not found)`); continue; }
            const { fonts: f } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
            used.push(`${label}: ${f.map((x) => x.familyName + (x.isCustomFont ? ' [site font]' : '')).join('+') || '(no text)'}`);
          }
          fonts = '\n      fonts really used -> ' + used.join(' | ');
        }
        await page.addStyleTag({ content: FIX });
        const F = await page.evaluate(measure);
        const client = await ctx.newPage();
        await client.goto(viaHttp ? url.replace(/^file:\/\/[^?]*/, base) : url);
        let C = null;
        try {
          await client.waitForFunction(() => document.getElementById('client-page').style.display === 'block', null, { timeout: 8000 });
          await client.evaluate(() => ['client-price-pencil', 'client-ins-pencil', 'client-tax-pencil', 'tax-lookup-toggle'].forEach((id) => { const e = document.getElementById(id); if (e) e.click(); }));
          C = await client.evaluate(measure);
        } catch (e) { C = { W: width, scrollW: 'client screen did not open: ' + e.message.split('\n')[0], leaf: [] }; }
        console.log(`  ${width}px  LENDER page is ${L.scrollW} wide${L.scrollW > L.W ? '  <-- SCROLLS SIDEWAYS' : ''}` + (L.leaf.length ? `\n      sticks out: ${L.leaf.join(' ; ')}` : '') +
          `\n      header row: ${L.hdr ? L.hdr.join(' | ') : '(hidden)'}  height ${L.hdrH}` + fonts +
          `\n      with the candidate fix: page ${F.scrollW} wide${F.scrollW > F.W ? '  <-- STILL SCROLLS' : ''}; header row: ${F.hdr ? F.hdr.join(' | ') : '(hidden)'}  height ${F.hdrH}` + (F.leaf.length ? `\n      still sticks out: ${F.leaf.join(' ; ')}` : '') +
          `\n      CLIENT page is ${C.scrollW} wide${C.scrollW > C.W ? '  <-- SCROLLS SIDEWAYS' : ''}` + (C.leaf.length ? `\n      sticks out: ${C.leaf.join(' ; ')}` : ''));
        await ctx.close();
      }
    }
  }
  await browser.close(); server.close();
})().catch((e) => { console.error('DIAGNOSTIC CRASHED:', e); process.exit(1); });
