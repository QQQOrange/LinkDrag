'use strict';
const port = process.argv[2] || '9343';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page' && /127\.0\.0\.1:(8765|8766)/.test(t.url));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result && r.result.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8765/index.html?reload=' + Date.now() });
  await sleep(1400);
  const out = await evaluate(`(async()=>{ const img=document.getElementById('testImage'); img.dispatchEvent(new MouseEvent('dragstart',{bubbles:true,cancelable:true,composed:true,clientX:150,clientY:150})); await new Promise(r=>setTimeout(r,1100)); const h=document.querySelector('[data-ldp-host]'); const w=h.shadowRoot.querySelector('.window.image-mode'); const el=w.querySelector('.image-el'); const before={src:el.getAttribute('src'),nw:el.naturalWidth,loader:w.querySelector('.loader').hidden}; w.querySelector('[data-action="reload"]').click(); await new Promise(r=>setTimeout(r,1100)); const after={src:el.getAttribute('src'),nw:el.naturalWidth,loader:w.querySelector('.loader').hidden,meta:w.querySelector('.image-meta').textContent}; return {before,after}; })()`);
  console.log(JSON.stringify(out, null, 2));
  ws.close();
})().catch(e => { console.error(e); process.exitCode = 1; });
