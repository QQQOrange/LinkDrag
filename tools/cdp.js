'use strict';
/**
 * Minimal CDP helpers shared by the acceptance scripts.
 * The summary UI lives in a CLOSED shadow root, so everything must go through
 * the DOM domain with `pierce: true` — page-level querySelector cannot see it.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connectTo(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });
  /** Collected CDP events, so console output and errors are visible to tests. */
  const events = [];
  ws.addEventListener('message', raw => {
    const msg = JSON.parse(raw.data);
    if (msg.id) return;
    events.push({ method: msg.method, params: msg.params || {} });
  });
  const consoleText = () => events
    .filter(e => e.method === 'Runtime.consoleAPICalled')
    .map(e => (e.params.args || []).map(a => (a.value !== undefined ? String(a.value) : (a.description || ''))).join(' '));
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result ? r.result.value : undefined;
  };
  return { send, evaluate, close: () => ws.close(), events, consoleText };
}

async function listTargets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

async function connectPage(port, urlPart) {
  const targets = await listTargets(port);
  const page = targets.find(t => t.type === 'page' && String(t.url).includes(urlPart));
  if (!page) throw new Error('page target not found: ' + urlPart);
  const conn = await connectTo(page);
  await conn.send('Runtime.enable');
  await conn.send('Page.enable');
  await conn.send('DOM.enable');
  return conn;
}

/** Find every element with the given class inside nested (closed) shadow roots. */
async function pickShadows(page, cls) {
  const doc = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const found = [];
  const walk = (node, inTemplate) => {
    if (!node) return;
    const inside = inTemplate || String(node.nodeName || '').toUpperCase() === 'TEMPLATE';
    const attrs = node.attributes || [];
    const map = {};
    for (let i = 0; i < attrs.length; i += 2) map[attrs[i]] = attrs[i + 1];
    if (!inside && String(map.class || '').split(/\s+/).includes(cls)) found.push({ nodeId: node.nodeId });
    for (const child of node.children || []) walk(child, inside);
    for (const shadow of node.shadowRoots || []) walk(shadow, inside);
  };
  walk(doc.root, false);
  return found;
}

/** Run a function with `this` bound to the element; returns its value. */
async function callOn(page, nodeId, fn) {
  const resolved = await page.send('DOM.resolveNode', { nodeId });
  const r = await page.send('Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    functionDeclaration: fn,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error('callOn: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

/** Resolve the (possibly closed) shadow root host used by the panel UI. */
async function hostNode(page) {
  const nodes = await pickShadows(page, 'window');
  return nodes;
}

module.exports = { sleep, connectTo, listTargets, connectPage, pickShadows, callOn, hostNode };
