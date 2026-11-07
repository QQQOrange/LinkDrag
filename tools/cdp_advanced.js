'use strict';
const port = process.argv[2] || '9337';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page' && /127\.0\.0\.1:(8765|8766)/.test(t.url));
  if (!page) throw new Error('page not found');
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
  return { ws, send, evaluate, errors };
}

(async () => {
  const { ws, send, evaluate, errors } = await connect();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8765/index.html?adv=' + Date.now() });
  await sleep(1500);

  const closeAll = () => evaluate(`(() => { const h=document.querySelector('[data-ldp-host]'); const sr=h&&h.shadowRoot; const bs=sr?Array.from(sr.querySelectorAll('.window [data-action="close"]')):[]; bs.forEach(b=>b.click()); return bs.length; })()`);
  const winInfo = () => evaluate(`(() => { const h=document.querySelector('[data-ldp-host]'); const sr=h&&h.shadowRoot; return Array.from(sr?sr.querySelectorAll('.window'):[]).map(w=>({cls:w.className,title:(w.querySelector('.title')||{}).textContent||'',src:(w.querySelector('iframe')||{}).getAttribute?w.querySelector('iframe').getAttribute('src'):'',img:(w.querySelector('.image-el')||{}).getAttribute?w.querySelector('.image-el').getAttribute('src'):''})); })()`);

  console.log('CLOSE_INITIAL', await closeAll());
  await sleep(800);
  console.log('WINDOWS_AFTER_CLOSE', JSON.stringify(await winInfo()));

  // Open nested.html as a normal page preview.
  await evaluate(`(() => { const a=document.getElementById('nestedLink'); a.dispatchEvent(new MouseEvent('dragstart',{bubbles:true,cancelable:true,composed:true,clientX:300,clientY:300})); return true; })()`);
  await sleep(1800);
  const nestedPage = await evaluate(`(() => { const h=document.querySelector('[data-ldp-host]'); const sr=h&&h.shadowRoot; const w=sr&&sr.querySelector('.window:not(.image-mode)'); const f=w&&w.querySelector('iframe'); let doc=null; try{doc=f&&f.contentDocument;}catch(e){} return {window:!!w,frameSrc:f&&f.getAttribute('src'),sameOriginDoc:!!doc,childImage:!!(doc&&doc.getElementById('nestedImage')),title:w&&w.querySelector('.title').textContent}; })()`);
  console.log('NESTED_PAGE', JSON.stringify(nestedPage));

  // Drag the image from inside the preview iframe.  This crosses the child
  // content-script bridge and must create a nested image window in the top page.
  const childDispatch = await evaluate(`(() => { const h=document.querySelector('[data-ldp-host]'); const sr=h&&h.shadowRoot; const w=sr.querySelector('.window:not(.image-mode)'); const f=w.querySelector('iframe'); const doc=f.contentDocument; const img=doc.getElementById('nestedImage'); const ev=new MouseEvent('dragstart',{bubbles:true,cancelable:true,composed:true,clientX:200,clientY:200}); img.dispatchEvent(ev); return {found:!!img,prevented:ev.defaultPrevented}; })()`);
  console.log('CHILD_IMAGE_DISPATCH', JSON.stringify(childDispatch));
  await sleep(1800);
  console.log('WINDOWS_AFTER_NESTED_IMAGE', JSON.stringify(await winInfo()));

  // Reader mode on the nested page preview (uses the privileged background fetch).
  const readerClick = await evaluate(`(() => { const h=document.querySelector('[data-ldp-host]'); const sr=h&&h.shadowRoot; const w=Array.from(sr.querySelectorAll('.window')).find(x=>!x.classList.contains('image-mode')); const b=w&&w.querySelector('[data-action="read"]'); if(b)b.click(); return !!b; })()`);
  await sleep(2600);
  const reader = await evaluate(`(() => { const h=document.querySelector('[data-ldp-host]'); const sr=h&&h.shadowRoot; const w=Array.from(sr.querySelectorAll('.window')).find(x=>!x.classList.contains('image-mode')); const f=w&&w.querySelector('iframe'); let text=''; let doc=null; try{doc=f&&f.contentDocument; text=doc&&doc.body?doc.body.innerText.slice(0,200):'';}catch(e){} const toast=w&&w.querySelector('.toast').textContent; return {clicked:${'true'},src:f&&f.getAttribute('src'),blob:!!(f&&/^blob:/.test(f.getAttribute('src')||'')),text:text,toast:toast,hint:w&&w.querySelector('.hint-text').textContent}; })()`);
  console.log('READER', JSON.stringify(reader));

  // Settings panel must include the extension section.
  const settings = await evaluate(`(() => { const h=document.querySelector('[data-ldp-host]'); const sr=h&&h.shadowRoot; const w=sr.querySelector('.window:not(.image-mode)'); const b=w&&w.querySelector('[data-action="settings"]'); if(b)b.click(); const p=w&&w.querySelector('.panel'); return {clicked:!!b,visible:!!(p&&!p.hidden),hasExtension:!!(p&&p.textContent.includes('扩展集成')),hasImage:!!(p&&p.textContent.includes('拖拽图片时预览高清原图'))}; })()`);
  console.log('SETTINGS_PANEL', JSON.stringify(settings));

  console.log('EXCEPTIONS', errors.length);
  for (const e of errors.slice(0, 4)) console.log(JSON.stringify(e).slice(0, 1000));
  ws.close();
})().catch(err => { console.error('ADV_FAILED', err && err.stack || err); process.exitCode = 1; });
