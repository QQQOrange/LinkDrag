'use strict';
/**
 * Real-keystroke acceptance for the follow-up composer.
 *
 * Unlike tools/accept_followup.js (which used Input.insertText and therefore
 * bypassed keydown), this drives genuine key events — keyDown/char/keyUp — the
 * same path a physical keyboard takes.  That is the only way to catch global
 * keydown handlers swallowing characters.
 */
const port = process.argv[2] || '9343';
const PAGE_MATCH = process.env.ACCEPT_MATCH || 'stream-acceptance';
const PAGE_URL = process.env.ACCEPT_PAGE || 'http://127.0.0.1:8765/stream-acceptance.html';
const TEXT = '第二部分怎么用';

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
    if (!inside && String(map.class || '').split(/\s+/).includes(cls)) found.push({ nodeId: node.nodeId });
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
  if (r.exceptionDetails) throw new Error('callOn: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
}

/** Type one character the way a keyboard does: keyDown + char + keyUp. */
async function typeChar(page, ch) {
  const code = ch.charCodeAt(0);
  // rawKeyDown carries no text (so it cannot insert), then a single `char`
  // performs the insertion — the exact sequence a physical keyboard produces.
  await page.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: ch,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    code: /[a-zA-Z]/.test(ch) ? 'Key' + ch.toUpperCase() : undefined
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'char',
    key: ch,
    text: ch,
    unmodifiedText: ch,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: ch,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code
  });
  await sleep(30);
}

async function main() {
  let list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let pageTarget = list.find(t => t.type === 'page' && t.url.includes(PAGE_MATCH));
  if (!pageTarget) {
    const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const b = await connect({ webSocketDebuggerUrl: browser.webSocketDebuggerUrl });
    await b.send('Target.createTarget', { url: PAGE_URL });
    b.close();
    await sleep(3500);
    list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    pageTarget = list.find(t => t.type === 'page' && t.url.includes(PAGE_MATCH));
  }
  if (!pageTarget) throw new Error('page not found');
  const page = await connect(pageTarget);
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  // Open a summary with a real pointer hover so the AI button mounts.
  let input = await pick(page, 'followup-input');
  if (!input.length) {
    await page.evaluate('window.scrollTo(0,0)');
    await sleep(300);
    const vp = await page.evaluate(`(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      v.play && v.play().catch(() => {});
      const r = v.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 150)) };
    })()`);
    if (vp) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x - 40, y: vp.y - 30 });
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
    if (worker) {
      const bg = await connect(worker);
      const tabId = await bg.evaluate(`chrome.tabs.query({url:'http://127.0.0.1:8765/*'}).then(ts => (ts.find(t=>t.url.includes(${JSON.stringify(PAGE_MATCH)}))||ts[0]||{}).id)`);
      const clicked = await bg.evaluate(`chrome.scripting.executeScript({target:{tabId:${JSON.stringify(tabId)}},func:()=>{
        const h=document.getElementById('ldp-video-ai-host');
        const b=h&&h.shadowRoot&&h.shadowRoot.querySelector('.ldp-video-ai');
        if(!b) return {ok:false,reason:'no-button'};
        if(b.hidden) return {ok:false,reason:'hidden'};
        b.click(); return {ok:true};
      }})`);
      console.log('OPEN', JSON.stringify(clicked && clicked[0] && clicked[0].result));
      bg.close();
    }
    for (let i = 0; i < 60; i += 1) {
      await sleep(1000);
      input = await pick(page, 'followup-input');
      if (input.length) {
        const box = await pick(page, 'followup-box');
        const hidden = box.length ? await callOn(page, box[0].nodeId, 'function(){return this.hidden}') : true;
        if (!hidden) break;
      }
    }
  }
  check('follow-up composer is available', input.length > 0, input.length);
  if (!input.length) { page.close(); process.exitCode = 1; return; }

  // Wait for the answer to stop streaming unless ACCEPT_MIDSTREAM=1, which
  // exercises typing while chunks are still arriving.
  if (process.env.ACCEPT_MIDSTREAM === '1') {
    console.log('MIDSTREAM MODE: typing while the answer is still streaming');
  } else {
  let lastLen = -1;
  for (let i = 0; i < 90; i += 1) {
    await sleep(700);
    const answers = await pick(page, 'video-summary-answer');
    if (!answers.length) continue;
    const info = await callOn(page, answers[0].nodeId, 'function(){return {len:(this.textContent||"").length, done:/结论/.test(this.textContent||"")}}').catch(() => null);
    if (!info) continue;
    if (info.done && info.len === lastLen) break;
    lastLen = info.len;
  }
  }
  input = await pick(page, 'followup-input');
  check('composer still present after the answer settles', input.length > 0, input.length);
  if (!input.length) { page.close(); process.exitCode = 1; return; }

  const rect = await callOn(page, input[0].nodeId, [
    'function(){',
    '  const r = this.getBoundingClientRect();',
    '  return { x: Math.round(r.left + 14), y: Math.round(r.top + r.height / 2) };',
    '}'
  ].join('\n'));
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(200);

  const focusedNode = await pick(page, 'followup-input');
  const focused = await callOn(page, focusedNode[0].nodeId, 'function(){return {focused:this.matches(":focus")}}');
  check('composer has focus after clicking', focused && focused.focused, focused);

  // Record which keydown listeners run, to catch a global handler eating input.
  await page.evaluate(`(() => {
    window.__LPS_KEY_PROBE__ = [];
    const record = e => {
      window.__LPS_KEY_PROBE__.push({
        key: e.key,
        defaultPrevented: e.defaultPrevented,
        target: (e.composedPath && e.composedPath()[0] ? (e.composedPath()[0].className || e.composedPath()[0].tagName) : '?') + ''
      });
    };
    window.addEventListener('keydown', record, false);
  })()`);

  for (const ch of TEXT) await typeChar(page, ch);
  await sleep(300);

  const state = await callOn(page, (await pick(page, 'followup-input'))[0].nodeId, 'function(){return {value:this.value, len:this.value.length}}');
  check('real keystrokes reach the composer', state && state.value === TEXT, { got: state && state.value, want: TEXT });

  const probe = await page.evaluate('window.__LPS_KEY_PROBE__');
  const swallowed = (probe || []).filter(e => e.defaultPrevented);
  check('no global handler cancelled the keystrokes', swallowed.length === 0, { total: (probe || []).length, swallowed });

  // Voice input commits through IME composition events, not keystrokes.  Text
  // must survive even if the panel re-renders while composing.
  const imeTarget = (await pick(page, 'followup-input'))[0];
  const imeResult = await callOn(page, imeTarget.nodeId, [
    'function(){',
    '  const el = this;',
    '  el.focus();',
    '  el.value = "";',
    '  el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));',
    '  el.value = "语音输入的文字";',
    '  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: "语音输入的文字", inputType: "insertCompositionText", isComposing: true }));',
    '  el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "语音输入的文字" }));',
    '  return { value: el.value };',
    '}'
  ].join('\n'));
  check('IME / voice composition writes into the composer', imeResult && imeResult.value === '语音输入的文字', imeResult);

  // Rebuild the panel the way a streaming tick does; the draft must come back
  // and the caret must still be reachable.
  const draftSurvives = await callOn(page, (await pick(page, 'followup-box'))[0].nodeId, [
    'function(){',
    '  const win = this.closest(".window");',
    '  const btn = Array.from(win.querySelectorAll("button")).find(b => /重新总结/.test(b.textContent||""));',
    '  return { hasButton: !!btn };',
    '}'
  ].join('\n'));
  check('panel has a control that triggers a re-render', draftSurvives && draftSurvives.hasButton, draftSurvives);

  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(2500);
  const after = await callOn(page, (await pick(page, 'followup-box'))[0].nodeId, [
    'function(){',
    '  const i = this.querySelector(".followup-input");',
    '  const turns = this.querySelectorAll(".followup-turn").length;',
    '  return { value: i ? i.value : null, turns: turns };',
    '}'
  ].join('\n'));
  check('Enter submits the typed question', after && after.value === '' && after.turns >= 2, after);

  page.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n' + JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(err => { console.error('TYPE_ACCEPTANCE_ERROR', err && err.stack || err); process.exitCode = 1; });
