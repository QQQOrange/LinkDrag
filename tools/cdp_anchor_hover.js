'use strict';
const port = process.argv[2] || '9340';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page' && /127\.0\.0\.1:(8765|8766)/.test(t.url));
  if (!page) throw new Error('page not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result && r.result.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8765/index.html?anchor=' + Date.now() });
  await sleep(1400);
  const anchorDrag = await evaluate(`(async()=>{ const a=document.getElementById('imageLink'); const img=document.getElementById('testImage'); const r=img.getBoundingClientRect(); a.dispatchEvent(new MouseEvent('dragstart',{bubbles:true,cancelable:true,composed:true,clientX:r.left+50,clientY:r.top+50})); await new Promise(x=>setTimeout(x,1100)); const h=document.querySelector('[data-ldp-host]'); const w=h&&h.shadowRoot.querySelector('.window.image-mode'); return {opened:!!w,img:w&&w.querySelector('.image-el').getAttribute('src'),title:w&&w.querySelector('.title').textContent}; })()`);
  console.log('ANCHOR_TARGET_DRAG', JSON.stringify(anchorDrag));
  // Close it, reload, then hover a 16px icon inside a link: launcher must appear.
  await evaluate(`(()=>{ const h=document.querySelector('[data-ldp-host]'); Array.from(h.shadowRoot.querySelectorAll('[data-action="close"]')).forEach(b=>b.click()); return true; })()`);
  await sleep(800);
  await send('Page.navigate', { url: 'http://127.0.0.1:8765/index.html?hover=' + Date.now() });
  await sleep(1300);
  const hover = await evaluate(`(async()=>{ const a=document.createElement('a'); a.href='second.html'; a.id='iconLink'; a.innerHTML='<img id="tinyIcon" src="thumb.png" width="16" height="16"> icon link'; document.body.appendChild(a); const img=document.getElementById('tinyIcon'); const r=img.getBoundingClientRect(); img.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,composed:true,clientX:r.left+8,clientY:r.top+8})); await new Promise(x=>setTimeout(x,200)); const h=document.querySelector('[data-ldp-host]'); const b=h&&h.shadowRoot.querySelector('.ldp-launcher'); return {launcher:!!b,hidden:b&&b.hidden,title:b&&b.title}; })()`);
  console.log('TINY_ICON_LINK_HOVER', JSON.stringify(hover));
  ws.close();
})().catch(e => { console.error(e); process.exitCode = 1; });
