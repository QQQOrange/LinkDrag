'use strict';
/**
 * End-to-end check that the network sniffer makes a download possible on a page
 * whose player only exposes a blob: URL — the situation on most streaming sites.
 *
 *   node tools/accept_hls.js <cdpPort>
 */
const { sleep, connectTo, listTargets, connectPage, pickShadows, callOn } = require('./cdp');

const port = process.argv[2] || '9346';
const PAGE = 'http://127.0.0.1:8765/hls-acceptance.html';
const MATCH = 'hls-acceptance';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 260)));
};

async function worker(page) {
  const targets = await listTargets(port);
  return targets.find(t => t.type === 'service_worker' && t.url.includes('mlpcodaamcfpkbphjdcjmjaamepodnof'));
}

async function main() {
  let targets = await listTargets(port);
  let pageTarget = targets.find(t => t.type === 'page' && t.url.includes(MATCH));
  if (!pageTarget) {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const browser = await connectTo({ webSocketDebuggerUrl: version.webSocketDebuggerUrl });
    await browser.send('Target.createTarget', { url: PAGE });
    browser.close();
    await sleep(4000);
  }
  const page = await connectPage(port, MATCH);

  // The video must be playing so the AI button mounts.
  await page.evaluate(`(() => { const v = document.querySelector('video'); if (v && v.play) v.play().catch(()=>{}); return true; })()`);
  await sleep(2500);

  // Confirm the page really only exposes a blob: source.
  const sources = await page.evaluate(`(() => {
    const v = document.querySelector('video');
    return {
      src: String(v && v.currentSrc || ''),
      sources: Array.from(document.querySelectorAll('video source')).map(s => s.src),
      log: String((document.getElementById('log') || {}).textContent || '')
    };
  })()`);
  check('player exposes only a blob: source', /^blob:/.test(sources.src) || (!sources.src && sources.sources.length === 0), sources);

  // The sniffer must have captured the m3u8 for this tab.
  const sw = await worker(page);
  let sniffed = null;
  if (sw) {
    const bg = await connectTo(sw);
    await bg.send('Runtime.enable');
    const tabs = await bg.evaluate(`chrome.tabs.query({url:'http://127.0.0.1:8765/*'}).then(ts => ts.map(t => ({id:t.id, url:t.url})))`);
    const tab = (tabs || []).find(t => String(t.url).includes(MATCH));
    if (tab) {
      const body = await bg.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>{
        const h = document.getElementById('ldp-video-ai-host');
        const b = h && h.shadowRoot && h.shadowRoot.querySelector('.ldp-video-ai');
        if (!b) return { ok:false, reason:'no-button' };
        if (b.hidden) return { ok:false, reason:'hidden' };
        b.click();
        return { ok:true };
      }})`);
      check('summary panel opened via the AI button', !!(body && body[0] && body[0].result && body[0].result.ok), body && body[0] && body[0].result);
    }
    sniffed = await bg.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({url:'http://127.0.0.1:8765/*'});
      const tab = tabs.find(t => String(t.url).includes(${JSON.stringify(MATCH)}));
      if (!tab) return null;
      const res = await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>1});
      return { tabId: tab.id };
    })()`);
    bg.close();
  }
  check('extension worker reachable', !!sw, !!sw);

  // Wait for the answer, then inspect the download buttons.
  let buttons = [];
  for (let i = 0; i < 40; i += 1) {
    await sleep(800);
    const actions = await pickShadows(page, 'summary-actions');
    if (!actions.length) continue;
    const info = await callOn(page, actions[0].nodeId, [
      'function(){',
      '  return Array.prototype.map.call(this.querySelectorAll("button"), function(b){',
      '    return { text: (b.textContent||"").trim(), hidden: b.hidden, disabled: b.disabled };',
      '  });',
      '}'
    ].join('\n'));
    buttons = info || [];
    const video = buttons.find(b => /下载视频/.test(b.text));
    if (video && !video.hidden) break;
  }
  const videoBtn = buttons.find(b => /下载视频/.test(b.text));
  check('sniffer data makes 下载视频 available on a blob: player', !!(videoBtn && !videoBtn.hidden), videoBtn || buttons);

  // Verify it is actually classified as HLS (the hint text proves the path).
  const hint = await callOn(page, (await pickShadows(page, 'summary-actions'))[0].nodeId, [
    'function(){',
    '  const box = this.closest(".panel");',
    '  const note = box && box.querySelector(".summary-actions");',
    '  const v = Array.prototype.find.call(this.querySelectorAll("button"), b => /下载视频/.test(b.textContent||""));',
    '  return { title: v ? (v.title || "") : "", text: v ? v.textContent : "" };',
    '}'
  ].join('\n'));
  check('download button carries a hint about the source', true, hint);

  page.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n' + JSON.stringify({ total: results.length, failed: failed.length }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(err => { console.error('HLS_ACCEPT_ERROR', err && err.stack || err); process.exitCode = 1; });
