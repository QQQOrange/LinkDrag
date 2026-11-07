'use strict';
/* Minimal Chrome DevTools Protocol smoke test.  Run with the bundled Node:
 *   node tools/cdp_test.js 9336
 */
const port = process.argv[2] || '9336';
const BASE = 'http://127.0.0.1:' + port;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const targets = await (await fetch(BASE + '/json/list')).json();
  const page = targets.find(t => t.type === 'page' && /127\.0\.0\.1:8765\/index\.html/.test(t.url));
  const ext = targets.find(t => t.type === 'service_worker' && /background\.js/.test(t.url));
  if (!page) throw new Error('test page target not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  const logs = [];
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails);
    if (msg.method === 'Log.entryAdded') logs.push(msg.params.entry);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result ? r.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8765/index.html?smoke=' + Date.now() });
  await sleep(1800);

  const initial = await evaluate(`(() => {
    const h = document.querySelector('[data-ldp-host]');
    return { ready: !!window.__testReady, host: !!h, shadow: !!(h && h.shadowRoot), title: document.title };
  })()`);
  console.log('INITIAL', JSON.stringify(initial));

  // Drag the thumbnail image.  The content script must choose the 1600px
  // original (the wrapping <a> and the largest srcset candidate), not thumb.png.
  const dispatched = await evaluate(`(() => {
    const img = document.getElementById('testImage');
    const ev = new Event('dragstart', { bubbles: true, cancelable: true, composed: true });
    img.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, target: img.id };
  })()`);
  console.log('IMAGE_DRAG_EVENT', JSON.stringify(dispatched));
  await sleep(1800);
  const imageWindow = await evaluate(`(() => {
    const h = document.querySelector('[data-ldp-host]');
    const sr = h && h.shadowRoot;
    if (!sr) return { host: false };
    const wins = Array.from(sr.querySelectorAll('.window'));
    const w = wins.find(x => x.classList.contains('image-mode'));
    const img = w && w.querySelector('.image-el');
    return {
      count: wins.length,
      imageMode: !!w,
      className: w && w.className,
      title: w && w.querySelector('.title span, .title') && w.querySelector('.title').textContent,
      src: img && img.getAttribute('src'),
      naturalWidth: img && img.naturalWidth,
      naturalHeight: img && img.naturalHeight,
      ready: img && img.classList.contains('ready'),
      loaderHidden: w && w.querySelector('.loader').hidden,
      meta: w && w.querySelector('.image-meta').textContent,
      zoom: w && w.querySelector('.zoom-label').textContent
    };
  })()`);
  console.log('IMAGE_WINDOW', JSON.stringify(imageWindow));

  // Close the image window, then drag a normal link and check the iframe path.
  await evaluate(`(() => {
    const h = document.querySelector('[data-ldp-host]');
    const sr = h && h.shadowRoot;
    const w = sr && sr.querySelector('.window.image-mode');
    const btn = w && w.querySelector('[data-action="close"]');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(800);
  const linkEvent = await evaluate(`(() => {
    const a = document.getElementById('pageLink');
    const ev = new Event('dragstart', { bubbles: true, cancelable: true, composed: true });
    a.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented };
  })()`);
  console.log('LINK_DRAG_EVENT', JSON.stringify(linkEvent));
  await sleep(2000);
  const linkWindow = await evaluate(`(() => {
    const h = document.querySelector('[data-ldp-host]');
    const sr = h && h.shadowRoot;
    if (!sr) return { host: false };
    const wins = Array.from(sr.querySelectorAll('.window'));
    const w = wins.find(x => !x.classList.contains('image-mode'));
    const f = w && w.querySelector('iframe');
    return {
      count: wins.length,
      imageMode: w && w.classList.contains('image-mode'),
      title: w && w.querySelector('.title') && w.querySelector('.title').textContent,
      frameSrc: f && f.getAttribute('src'),
      loaderHidden: w && w.querySelector('.loader').hidden,
      hint: w && w.querySelector('.hint-text').textContent
    };
  })()`);
  console.log('LINK_WINDOW', JSON.stringify(linkWindow));

  console.log('PAGE_ERRORS', errors.length);
  for (const err of errors.slice(0, 5)) console.log(JSON.stringify(err).slice(0, 1200));
  console.log('LOG_ENTRIES', logs.length);
  for (const log of logs.filter(l => l.level === 'error').slice(0, 8)) console.log(JSON.stringify(log).slice(0, 1000));

  // Ask the extension worker for its own exceptions / version.
  if (ext) {
    const sws = new WebSocket(ext.webSocketDebuggerUrl);
    let sid = 0;
    const sp = new Map();
    const swErrors = [];
    sws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && sp.has(m.id)) { const p = sp.get(m.id); sp.delete(m.id); p(m.result); }
      if (m.method === 'Runtime.exceptionThrown') swErrors.push(m.params.exceptionDetails);
    };
    await new Promise((res, rej) => { sws.onopen = res; sws.onerror = rej; });
    const ssend = (method, params) => new Promise(res => { const id = ++sid; sp.set(id, res); sws.send(JSON.stringify({ id, method, params })); });
    await ssend('Runtime.enable', {});
    await sleep(300);
    const ver = await ssend('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().version', returnByValue: true });
    console.log('WORKER_VERSION', JSON.stringify(ver.result && ver.result.value));
    console.log('WORKER_ERRORS', swErrors.length);
    for (const err of swErrors.slice(0, 5)) console.log(JSON.stringify(err).slice(0, 1200));
    sws.close();
  }
  ws.close();
}

main().catch(err => { console.error('TEST_FAILED', err && err.stack || err); process.exitCode = 1; });
