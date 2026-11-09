'use strict';
/**
 * Diagnose the real download path on a page with a working public MP4.
 * Captures every console message and exception from the page while the
 * "下载视频" button is clicked, so a silent failure becomes visible.
 *
 *   node tools/accept_real_download.js <cdpPort>
 */
const { sleep, connectTo, listTargets, connectPage, pickShadows, callOn } = require('./cdp');

const port = process.argv[2] || '9348';
const PAGE = 'http://127.0.0.1:8765/real-download.html';
const MATCH = 'real-download';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)));
};

async function main() {
  let targets = await listTargets(port);
  if (!targets.find(t => t.type === 'page' && t.url.includes(MATCH))) {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const browser = await connectTo({ webSocketDebuggerUrl: version.webSocketDebuggerUrl });
    await browser.send('Target.createTarget', { url: PAGE });
    browser.close();
    await sleep(5000);
  }
  const page = await connectPage(port, MATCH);

  // Capture everything the page reports.
  const logs = [];
  page.send('Log.enable').catch(() => {});
  page.send('Runtime.enable').catch(() => {});
  const rawSend = page.send;
  // Poll console via Runtime is not possible after the fact; instead hook the
  // page's own console inside the content-script world through a listener.
  await page.evaluate(`(() => {
    window.__LPS_ERRORS__ = [];
    window.addEventListener('error', e => window.__LPS_ERRORS__.push('error: ' + (e.message || '')));
    window.addEventListener('unhandledrejection', e => window.__LPS_ERRORS__.push('rejection: ' + String((e.reason && e.reason.message) || e.reason || '')));
    return true;
  })()`);

  const state = await page.evaluate(`(() => {
    const v = document.querySelector('video');
    return { src: v && v.currentSrc, ready: v && v.readyState, w: v && v.videoWidth, label: (document.getElementById('state')||{}).textContent };
  })()`);
  check('public MP4 page is playable', !!(state && state.w > 0), state);

  await page.evaluate(`(() => { const v = document.querySelector('video'); if (v && v.play) v.play().catch(()=>{}); return true; })()`);
  await sleep(800);
  // The AI button is mounted lazily on pointer movement over the player.
  const box = await page.evaluate(`(() => {
    const v = document.querySelector('video');
    const r = v.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 140)) };
  })()`);
  if (box) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x - 60, y: box.y - 30 });
    await sleep(200);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(2200);
  }

  // Open the summary panel.
  const swTarget = (await listTargets(port)).find(t => t.type === 'service_worker' && t.url.includes('mlpcodaamcfpkbphjdcjmjaamepodnof'));
  let tabId = null;
  if (swTarget) {
    const bg = await connectTo(swTarget);
    await bg.send('Runtime.enable');
    const tabs = await bg.evaluate(`chrome.tabs.query({url:'http://127.0.0.1:8765/*'}).then(ts => ts.map(t => ({id:t.id,url:t.url})))`);
    const tab = (tabs || []).find(t => String(t.url).includes(MATCH));
    tabId = tab && tab.id;
    if (tabId) {
      const opened = await bg.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>{
        const h=document.getElementById('ldp-video-ai-host');
        const b=h&&h.shadowRoot&&h.shadowRoot.querySelector('.ldp-video-ai');
        if(!b) return {ok:false,reason:'no-button'};
        if(b.hidden) return {ok:false,reason:'hidden'};
        b.click(); return {ok:true};
      }})`);
      check('summary panel opened', !!(opened && opened[0] && opened[0].result && opened[0].result.ok), opened && opened[0] && opened[0].result);
    }
    bg.close();
  } else {
    check('summary panel opened', false, 'no worker');
  }

  // Wait until the download buttons settle.
  let buttons = [];
  for (let i = 0; i < 45; i += 1) {
    await sleep(900);
    const actions = await pickShadows(page, 'summary-actions');
    if (!actions.length) continue;
    buttons = (await callOn(page, actions[0].nodeId, [
      'function(){',
      '  return Array.prototype.map.call(this.querySelectorAll("button"), function(b){',
      '    return { text:(b.textContent||"").trim(), hidden:b.hidden, disabled:b.disabled, title:b.title||"" };',
      '  });',
      '}'
    ].join('\n'))) || [];
    const v = buttons.find(b => /下载视频/.test(b.text));
    if (v && !v.hidden) break;
  }
  const videoBtn = buttons.find(b => /下载视频/.test(b.text));
  check('下载视频 is offered for a direct MP4', !!(videoBtn && !videoBtn.hidden), videoBtn || buttons);

  if (videoBtn && !videoBtn.hidden) {
    // Click it and watch the progress box.
    const actions = await pickShadows(page, 'summary-actions');
    await callOn(page, actions[0].nodeId, [
      'function(){',
      '  const b = Array.prototype.find.call(this.querySelectorAll("button"), x => /下载视频/.test(x.textContent||""));',
      '  if (b) b.click();',
      '  return !!b;',
      '}'
    ].join('\n'));

    const seen = new Set();
    let last = '';
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      const boxes = await pickShadows(page, 'download-progress');
      if (!boxes.length) continue;
      const info = await callOn(page, boxes[0].nodeId, [
        'function(){',
        '  const t = this.querySelector(".download-progress-text");',
        '  const bar = this.querySelector(".download-progress-bar");',
        '  return { hidden: this.hidden, text: t ? t.textContent : "", width: bar ? bar.style.width : "", tone: this.dataset.tone || "" };',
        '}'
      ].join('\n')).catch(() => null);
      if (!info) continue;
      last = info.text || last;
      if (/正在下载|正在准备|已下载|正在连接/.test(info.text)) seen.add('progress');
      if (/已保存|下载完成|正在保存|已交给浏览器下载/.test(info.text)) seen.add('done');
      if (/失败/.test(info.text)) { seen.add('error'); break; }
      if (seen.has('done')) break;
    }
    check('download reports progress', seen.has('progress') || seen.has('done'), { seen: Array.from(seen), last });
    check('download reaches completion', seen.has('done'), { seen: Array.from(seen), last });

    const fs = require('node:fs');
    const dir = process.env.DOWNLOAD_DIR || 'D:\\Downloads';
    let saved = [];
    try {
      saved = fs.readdirSync(dir)
        .filter(name => /真实视频下载验收|mov_bbb/.test(name))
        .map(name => ({ name, size: fs.statSync(dir + '\\' + name).size }));
    } catch (e) { saved = []; }
    check('the file was written to disk', saved.some(f => f.size > 10000), saved);

    const errors = await page.evaluate('window.__LPS_ERRORS__ || []');
    check('no page-level errors during download', !errors.length, errors.slice(0, 4));

    const dlLogs = page.consoleText().filter(line => line.includes('[ldp-dl]'));
    console.log('CONTENT LOGS:\n' + (dlLogs.join('\n') || '(none)'));
  }

  if (!results.some(r => r.name === 'no page-level errors during download')) {
    const dlLogs = page.consoleText().filter(line => line.includes('[ldp-dl]'));
    console.log('CONTENT LOGS:\n' + (dlLogs.join('\n') || '(none)'));
  }
  page.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n' + JSON.stringify({ total: results.length, failed: failed.length }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(err => { console.error('REAL_DOWNLOAD_ERROR', err && err.stack || err); process.exitCode = 1; });
