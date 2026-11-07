'use strict';
const port = process.argv[2] || '9345';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page' && /127\.0\.0\.1:8765/.test(t.url));
  if (!page) throw new Error('page not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result && r.result.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8765/index.html?double=' + Date.now() });
  await sleep(1400);

  const script = `(async()=>{
    const h=()=>document.querySelector('[data-ldp-host]');
    const host=()=>h()&&h().shadowRoot;
    const closeAll=async()=>{ if(host()) Array.from(host().querySelectorAll('.window [data-action="close"]')).forEach(b=>b.click()); await new Promise(r=>setTimeout(r,900)); };
    const count=()=>host()?host().querySelectorAll('.window').length:0;
    const dragData=(url)=>{ const dt=new DataTransfer(); dt.setData('text/uri-list',url); dt.setData('text/plain',url); return dt; };
    await closeAll();
    // A: gesture opens on mousemove, then native dragstart/drop arrives.
    const a=document.getElementById('pageLink'); const ar=a.getBoundingClientRect();
    a.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,composed:true,button:0,buttons:1,clientX:ar.left+8,clientY:ar.top+8}));
    await new Promise(r=>setTimeout(r,220));
    a.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,cancelable:true,composed:true,button:0,buttons:1,clientX:ar.left+50,clientY:ar.top+8}));
    await new Promise(r=>setTimeout(r,120));
    const afterGesture=count();
    const dt=dragData(a.href);
    a.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,composed:true,dataTransfer:dt,clientX:ar.left+50,clientY:ar.top+8}));
    await new Promise(r=>setTimeout(r,80));
    window.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,composed:true,dataTransfer:dt,clientX:ar.left+50,clientY:ar.top+8}));
    await new Promise(r=>setTimeout(r,500));
    const afterDrop=count();
    await closeAll();
    // B: native dragstart only, then drop.
    const b=document.getElementById('pageLink'); const br=b.getBoundingClientRect(); const bdt=dragData(b.href);
    b.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,composed:true,dataTransfer:bdt,clientX:br.left+8,clientY:br.top+8}));
    await new Promise(r=>setTimeout(r,120));
    const nativeStart=count();
    window.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,composed:true,dataTransfer:bdt,clientX:br.left+8,clientY:br.top+8}));
    await new Promise(r=>setTimeout(r,500));
    const nativeDrop=count();
    await closeAll();
    // C: image dragstart then drop.
    const img=document.getElementById('testImage'); const ir=img.getBoundingClientRect(); const idt=dragData(img.src);
    img.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,composed:true,dataTransfer:idt,clientX:ir.left+8,clientY:ir.top+8}));
    await new Promise(r=>setTimeout(r,900));
    const imageStart=count();
    window.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,composed:true,dataTransfer:idt,clientX:ir.left+8,clientY:ir.top+8}));
    await new Promise(r=>setTimeout(r,400));
    const imageDrop=count();
    return {afterGesture,afterDrop,nativeStart,nativeDrop,imageStart,imageDrop};
  })()`;
  const out = await evaluate(script);
  console.log(JSON.stringify(out, null, 2));
  ws.close();
})().catch(e => { console.error(e); process.exitCode = 1; });
