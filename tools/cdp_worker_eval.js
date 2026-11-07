'use strict';
const port = process.argv[2] || '9337';
const expr = process.argv[3] || 'chrome.runtime.getManifest().version';
(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const sw = targets.find(t => t.type === 'service_worker' && /background\.js/.test(t.url));
  if (!sw) throw new Error('service worker not found');
  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails); };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  console.log(JSON.stringify(r.result && r.result.value, null, 2));
  if (r.exceptionDetails) console.error(JSON.stringify(r.exceptionDetails, null, 2));
  console.log('EXCEPTIONS', errors.length);
  ws.close();
})().catch(e => { console.error(e); process.exitCode = 1; });
