'use strict';
const port = process.argv[2] || '9337';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page' && /127\.0\.0\.1:/.test(t.url));
  if (!page) throw new Error('page target not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails); };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result && r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8766/' });
  await sleep(1200);
  await evaluate(`(() => { const a=document.getElementById('xfoLink'); a.dispatchEvent(new MouseEvent('dragstart',{bubbles:true,cancelable:true,composed:true,clientX:100,clientY:100})); return true; })()`);
  await sleep(5200);
  const result = await evaluate(`(() => {
    const h=document.querySelector('[data-ldp-host]'); const sr=h&&h.shadowRoot;
    const w=sr&&sr.querySelector('.window');
    const f=w&&w.querySelector('iframe');
    return {
      window: !!w,
      srcAttr: f && f.getAttribute('src'),
      blob: !!(f && /^blob:/.test(f.getAttribute('src')||'')),
      title: w && w.querySelector('.title').textContent,
      hint: w && w.querySelector('.hint-text').textContent,
      loaderHidden: w && w.querySelector('.loader').hidden,
      progress: w && w.querySelector('.progress-bar').style.width
    };
  })()`);
  console.log('XFO_SNAPSHOT', JSON.stringify(result));
  console.log('EXCEPTIONS', errors.length);
  for (const e of errors.slice(0, 4)) console.log(JSON.stringify(e).slice(0, 1200));
  ws.close();
})().catch(err => { console.error('XFO_FAILED', err && err.stack || err); process.exitCode = 1; });
