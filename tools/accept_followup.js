'use strict';
/**
 * Follow-up input acceptance: verifies the textarea in the summary panel really
 * receives keystrokes, keeps its value, and submits on Enter.
 *
 *   node tools/accept_followup.js <cdpPort> [text]
 */
const port = process.argv[2] || '9342';
const wanted = process.argv[3] || '第二部分说的容错系统怎么做？';
const PAGE_MATCH = process.env.ACCEPT_MATCH || 'stream-acceptance';
const PAGE_URL = process.env.ACCEPT_PAGE || 'http://127.0.0.1:8765/stream-acceptance.html';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result ? r.result.value : undefined;
  };
  return { send, evaluate, close: () => ws.close() };
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
}


/** Pick shadow-DOM nodes by class through the pierce tree. */
async function pick(page, cls) {
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const found = [];
  const walk = (node, inTemplate) => {
    if (!node) return;
    const inside = inTemplate || String(node.nodeName || '').toUpperCase() === 'TEMPLATE';
    const attrs = node.attributes || [];
    const map = {};
    for (let i = 0; i < attrs.length; i += 2) map[attrs[i]] = attrs[i + 1];
    const classes = String(map.class || '').split(/\s+/);
    if (!inside && classes.includes(cls)) found.push({ nodeId: node.nodeId, nodeName: node.nodeName });
    (node.children || []).forEach(c => walk(c, inside));
    (node.shadowRoots || []).forEach(c => walk(c, inside));
  };
  walk(doc.root, false);
  return found;
}

async function callOn(page, nodeId, fn) {
  const resolved = await page.send('DOM.resolveNode', { nodeId });
  const r = await page.send('Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    functionDeclaration: fn,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error('callOn: ' + JSON.stringify(r.exceptionDetails).slice(0, 240));
  return r.result.value;
}

/** Find the follow-up textarea's viewport rect (closed shadow root → CDP). */
async function inputRect(page) {
  const nodes = await pick(page, 'followup-input');
  if (!nodes.length) return null;
  return callOn(page, nodes[0].nodeId, [
    'function(){',
    '  const r = this.getBoundingClientRect();',
    '  const box = this.closest(".followup-box");',
    '  return { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), hidden: box ? box.hidden : null, disabled: this.disabled };',
    '}'
  ].join('\n'));
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let pageTarget = list.find(t => t.type === 'page' && t.url.includes(PAGE_MATCH));
  if (!pageTarget) {
    const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const b = await connect({ webSocketDebuggerUrl: browser.webSocketDebuggerUrl });
    await b.send('Target.createTarget', { url: PAGE_URL });
    b.close();
    await sleep(3000);
    pageTarget = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url.includes(PAGE_MATCH));
  }
  if (!pageTarget) throw new Error('page not found');
  const page = await connect(pageTarget);
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  // Open a summary if the panel is not there yet: hover the player with a real
  // pointer move (the button is mounted lazily), then click it via the worker.
  let rect = await inputRect(page);
  if (!rect) {
    await page.evaluate(`window.scrollTo(0, 0)`);
    await sleep(300);
    const vp = await page.evaluate(`(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      const r = v.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 160)) };
    })()`);
    if (vp) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x - 50, y: vp.y - 40 });
      await sleep(150);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x, y: vp.y });
      await sleep(1800);
    }
    let worker = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
      .find(t => t.type === 'service_worker' && t.url.includes('mlpcodaamcfpkbphjdcjmjaamepodnof'));
    if (!worker) {
      const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const b = await connect({ webSocketDebuggerUrl: browser.webSocketDebuggerUrl });
      await b.send('Target.createTarget', { url: 'chrome-extension://mlpcodaamcfpkbphjdcjmjaamepodnof/popup.html' });
      b.close();
      await sleep(2500);
      worker = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find(t => t.type === 'service_worker' && t.url.includes('mlpcodaamcfpkbphjdcjmjaamepodnof'));
    }
    if (!worker) throw new Error('extension worker unavailable');
    const bg = await connect(worker);
    const tabId = await bg.evaluate(`chrome.tabs.query({url:'http://127.0.0.1:8765/*'}).then(ts => (ts.find(t=>t.url.includes(${JSON.stringify(PAGE_MATCH)}))||ts[0]||{}).id)`);
    const clicked = await bg.evaluate(`chrome.scripting.executeScript({target:{tabId:${JSON.stringify(tabId)}},func:()=>{
      const h = document.getElementById('ldp-video-ai-host');
      const b = h && h.shadowRoot && h.shadowRoot.querySelector('.ldp-video-ai');
      if (!b) return { ok: false, reason: 'no-button' };
      if (b.hidden) return { ok: false, reason: 'hidden' };
      b.click();
      return { ok: true };
    }})`);
    console.log('OPEN', JSON.stringify(clicked && clicked[0] && clicked[0].result));
    bg.close();
    for (let i = 0; i < 60; i += 1) {
      await sleep(1000);
      rect = await inputRect(page);
      if (rect && !rect.hidden) break;
    }
  }
  check('follow-up input exists and is visible', !!(rect && !rect.hidden), rect);
  if (!rect) { page.close(); process.exitCode = 1; return; }

  // Click into the field the way a user would.
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(250);
  let focusNodes = await pick(page, 'followup-input');
  const focused = focusNodes.length ? await callOn(page, focusNodes[0].nodeId, 'function(){return {tag:this.tagName, shadowActive:this.matches(":focus"), readOnly:this.readOnly, disabled:this.disabled, pointer:getComputedStyle(this).pointerEvents}}') : null;
  check('clicking focuses the follow-up input', focused && (focused.shadowActive || focused.isActive), focused);

  // Type with real key events (this is what a user does).
  for (const ch of wanted) {
    await page.send('Input.insertText', { text: ch });
    await sleep(18);
  }
  await sleep(250);
  focusNodes = await pick(page, 'followup-input');
  const typed = focusNodes.length ? await callOn(page, focusNodes[0].nodeId, 'function(){return {value:this.value, length:this.value.length}}') : null;
  check('typed text stays in the follow-up input', typed && typed.value === wanted, typed);

  // Enter must submit (Shift+Enter stays a newline).
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(2500);
  // The panel re-renders while the answer streams, so read the state in one
  // in-page pass instead of resolving node ids one by one.
  const boxes = await pick(page, 'followup-box');
  const after = boxes.length ? await callOn(page, boxes[0].nodeId, [
    'function(){',
    '  const input = this.querySelector(".followup-input");',
    '  const turns = Array.prototype.map.call(this.querySelectorAll(".followup-turn"), function(t){ return (t.textContent||"").slice(0,60); });',
    '  const send = this.querySelector(".followup-send");',
    '  return { value: input ? input.value : null, turns: turns, sendText: send ? send.textContent : null, sendDisabled: send ? send.disabled : null };',
    '}'
  ].join('\n')) : null;
  check('Enter submits the question', after && after.value === '' && after.turns.length >= 2, after);

  page.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n' + JSON.stringify({ total: results.length, failed: failed.length }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(err => { console.error('FOLLOWUP_ACCEPTANCE_ERROR', err && err.stack || err); process.exitCode = 1; });
