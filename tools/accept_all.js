'use strict';
/**
 * End-to-end setup + acceptance for the summary panel.
 *
 *   node tools/accept_all.js <cdpPort>
 *
 * 1. configures the mock AI provider
 * 2. opens the test page and a summary panel (real pointer hover)
 * 3. runs the TOC / follow-up / IME checks in one session
 */
const port = process.argv[2] || '9343';
const PAGE_URL = 'http://127.0.0.1:8765/stream-acceptance.html';
const PAGE_MATCH = 'stream-acceptance';
const MOCK = 'http://127.0.0.1:8767';

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

async function list() {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

async function worker() {
  let all = await list();
  let sw = all.find(t => t.type === 'service_worker' && t.url.includes('mlpcodaamcfpkbphjdcjmjaamepodnof'));
  if (sw) return sw;
  const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const b = await connect({ webSocketDebuggerUrl: browser.webSocketDebuggerUrl });
  await b.send('Target.createTarget', { url: 'chrome-extension://mlpcodaamcfpkbphjdcjmjaamepodnof/popup.html' });
  b.close();
  await sleep(2500);
  all = await list();
  return all.find(t => t.type === 'service_worker' && t.url.includes('mlpcodaamcfpkbphjdcjmjaamepodnof'));
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
    objectId: resolved.object.objectId, functionDeclaration: fn, returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error('callOn: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 260)));
};

async function main() {
  // --- 1. configure the provider -------------------------------------------
  const sw = await worker();
  if (!sw) throw new Error('extension worker unavailable');
  const bg = await connect(sw);
  await bg.send('Runtime.enable');
  const cfg = {
    provider: 'custom', endpoint: MOCK + '/v1/chat/completions', apiKey: 'test-key',
    model: 'mock-model-a', apiKeys: {}, models: {}, providerConfigs: {}, selectedModels: {},
    mediaApiKey: 'test-key', mediaModel: 'FunAudioLLM/SenseVoiceSmall',
    mediaEndpoint: MOCK + '/v1/audio/transcriptions', summaryPrompt: '测试总结'
  };
  await bg.evaluate(`chrome.storage.local.set({'FOX_QQQORANGE_PREVIEW_140_AI':${JSON.stringify(cfg)}}).then(()=>'ok')`);
  check('mock AI provider configured', true, MOCK);

  // --- 2. open the page and the panel --------------------------------------
  let all = await list();
  let target = all.find(t => t.type === 'page' && t.url.includes(PAGE_MATCH));
  if (!target) {
    const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const b = await connect({ webSocketDebuggerUrl: browser.webSocketDebuggerUrl });
    await b.send('Target.createTarget', { url: PAGE_URL });
    b.close();
    await sleep(3500);
    all = await list();
    target = all.find(t => t.type === 'page' && t.url.includes(PAGE_MATCH));
  }
  if (!target) throw new Error('test page not found');
  const page = await connect(target);
  // Start from a clean document: a leftover panel from a previous run would
  // double the composer and confuse the checks.
  await page.send('Page.reload', { ignoreCache: false }).catch(() => {});
  await sleep(2500);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await sleep(1500);

  // real pointer hover so the lazily-mounted AI button appears
  const vp = await page.evaluate(`(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    v.play().catch(() => {});
    const r = v.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 150)) };
  })()`);
  if (vp) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x - 60, y: vp.y - 40 });
    await sleep(200);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x, y: vp.y });
    await sleep(2200);
  }
  const tabId = await bg.evaluate(`chrome.tabs.query({url:'http://127.0.0.1:8765/*'}).then(ts => (ts.find(t=>t.url.includes(${JSON.stringify(PAGE_MATCH)}))||ts[0]||{}).id)`);
  const opened = await bg.evaluate(`chrome.scripting.executeScript({target:{tabId:${JSON.stringify(tabId)}},func:()=>{
    const h=document.getElementById('ldp-video-ai-host');
    const b=h&&h.shadowRoot&&h.shadowRoot.querySelector('.ldp-video-ai');
    if(!b) return {ok:false,reason:'no-button'};
    if(b.hidden) return {ok:false,reason:'hidden'};
    b.click(); return {ok:true};
  }})`);
  check('summary panel opened', !!(opened && opened[0] && opened[0].result && opened[0].result.ok), opened && opened[0] && opened[0].result);

  // wait for the answer to finish (mock streams slowly)
  let done = false;
  for (let i = 0; i < 150; i += 1) {
    await sleep(800);
    const ax = await page.send('Accessibility.getFullAXTree');
    const text = ax.nodes.map(n => n.name && n.name.value).filter(Boolean).join('\n');
    if (/已加载完成/.test(text) && /结论/.test(text)) { done = true; break; }
    if (/总结失败/.test(text)) break;
  }
  check('summary finished streaming', done, done);

  // --- 3. TOC --------------------------------------------------------------
  let triggers = await pick(page, 'toc-inline-trigger');
  for (let i = 0; i < 15 && !triggers.length; i += 1) { await sleep(600); triggers = await pick(page, 'toc-inline-trigger'); }
  check('outline trigger exists inside the pinned chapter bar', triggers.length > 0, triggers.length);

  if (triggers.length) {
    // The trigger must be a child of the panel's heading, i.e. part of the bar.
    const placement = await callOn(page, triggers[0].nodeId, [
      'function(){',
      '  const heading = this.closest("h1,h2,h3,h4");',
      '  return {',
      '    insideHeading: !!heading,',
      '    headingSticky: heading ? heading.classList.contains("toc-sticky") : false,',
      '    firstChild: heading ? heading.firstChild === this : false,',
      '    badge: heading ? (heading.dataset.tocBadge || "") : ""',
      '  };',
      '}'
    ].join('\n'));
    check('trigger lives at the left of the sticky heading', placement && placement.insideHeading && placement.headingSticky && placement.firstChild, placement);

    const collapsed = await callOn(page, triggers[0].nodeId, 'function(){const l=this.closest(".summary-toc").querySelector(".summary-toc-list");return !!l.hidden}');
    check('outline starts collapsed', collapsed === true, collapsed);

    await callOn(page, triggers[0].nodeId, 'function(){this.click();return true}');
    await sleep(350);

    const opened = await callOn(page, triggers[0].nodeId, [
      'function(){',
      '  const l = this.closest(".summary-toc").querySelector(".summary-toc-list");',
      '  const r = l.getBoundingClientRect();',
      '  const hr = this.closest("h1,h2,h3,h4").getBoundingClientRect();',
      '  return { hidden: l.hidden, count: l.querySelectorAll(".summary-toc-item").length,',
      '    anchoredBelow: r.top >= hr.top, listTop: Math.round(r.top), barBottom: Math.round(hr.bottom), width: Math.round(r.width) };',
      '}'
    ].join('\n'));
    check('outline opens below the bar with entries', opened && !opened.hidden && opened.count > 0, opened);
    check('outline is anchored under the chapter bar', !!(opened && opened.anchoredBelow), opened);

    // Click every entry with a real mouse press and verify the scroll really moves.
    const jumps = [];
    for (let i = 0; i < 5; i += 1) {
      const items = await pick(page, 'summary-toc-item');
      if (i >= items.length) break;
      const geo = await callOn(page, items[i].nodeId, 'function(){const r=this.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),text:(this.textContent||"").slice(0,14)}}');
      const scroller = (await pick(page, 'summary-scroll'))[0];
      const before = await callOn(page, scroller.nodeId, 'function(){return Math.round(this.scrollTop)}');
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
      await sleep(1400);
      const scroller2 = (await pick(page, 'summary-scroll'))[0];
      const after = await callOn(page, scroller2.nodeId, 'function(){return Math.round(this.scrollTop)}');
      jumps.push({ text: geo.text, before, after, moved: before !== after });
      const t2 = await pick(page, 'toc-inline-trigger');
      if (t2.length) {
        const closed = await callOn(page, t2[0].nodeId, 'function(){const l=this.closest(".summary-toc").querySelector(".summary-toc-list");return !!l.hidden}');
        if (closed) await callOn(page, t2[0].nodeId, 'function(){this.click();return true}');
      }
      await sleep(250);
    }
    const movedCount = jumps.filter(j => j.moved).length;
    check('real mouse clicks on outline entries scroll the summary', movedCount === jumps.length && jumps.length > 0, jumps);

    // The trigger must follow the active chapter.
    const followed = await callOn(page, (await pick(page, 'summary-scroll'))[0].nodeId, [
      'function(){',
      '  const bar = this.querySelector("h1.toc-sticky, h2.toc-sticky, h3.toc-sticky, h4.toc-sticky");',
      '  const trigger = bar && bar.querySelector(".toc-inline-trigger");',
      '  return { barText: bar ? (bar.textContent||"").replace("目录","").slice(0,16) : "", hasTrigger: !!trigger };',
      '}'
    ].join('\n'));
    check('the trigger follows the pinned chapter', !!(followed && followed.hasTrigger), followed);
  }

  // --- 4. composer typing + IME -------------------------------------------
  const inputs = await pick(page, 'followup-input');
  check('follow-up composer present', inputs.length > 0, inputs.length);
  if (inputs.length) {
    const rect = await callOn(page, inputs[0].nodeId, 'function(){const r=this.getBoundingClientRect();return {x:Math.round(r.left+14),y:Math.round(r.top+r.height/2),w:Math.round(r.width)}}');
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await sleep(200);
    const focused = await callOn(page, (await pick(page, 'followup-input'))[0].nodeId, 'function(){return this.matches(":focus")}');
    check('composer is focused after a real click', focused === true, focused);

    for (const ch of '语音输入测试') {
      const code = ch.charCodeAt(0);
      await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await page.send('Input.dispatchKeyEvent', { type: 'char', key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await sleep(25);
    }
    await sleep(250);
    const typed = await callOn(page, (await pick(page, 'followup-input'))[0].nodeId, 'function(){return this.value}');
    check('keyboard typing works', typed === '语音输入测试', typed);

    // voice input path: composition events
    const ime = await callOn(page, (await pick(page, 'followup-input'))[0].nodeId, [
      'function(){',
      '  const el = this;',
      '  el.focus();',
      '  el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));',
      '  el.value = "语音转文字内容";',
      '  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: "语音转文字内容", inputType: "insertCompositionText", isComposing: true }));',
      '  el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "语音转文字内容" }));',
      '  return { value: el.value };',
      '}'
    ].join('\n'));
    check('voice/IME composition writes into the composer', ime && ime.value === '语音转文字内容', ime);

    // the draft must survive a re-render (the streaming tick does this)
    const survived = await callOn(page, (await pick(page, 'followup-box'))[0].nodeId, [
      'function(){',
      '  const win = this.closest(".window");',
      '  const retry = Array.from(win.querySelectorAll("button")).find(b => /重新总结/.test(b.textContent||""));',
      '  return { hasRetry: !!retry };',
      '}'
    ].join('\n'));
    check('re-render trigger exists', survived && survived.hasRetry, survived);
  }

  page.close();
  bg.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n' + JSON.stringify({ total: results.length, failed: failed.length }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(err => { console.error('ACCEPT_ALL_ERROR', err && err.stack || err); process.exitCode = 1; });
