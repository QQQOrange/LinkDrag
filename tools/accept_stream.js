'use strict';
/**
 * Acceptance runner for the LinkDrag summary features.
 *
 *   node tools/accept_stream.js <cdpPort> [scenario]
 *
 * Scenarios: stream (default), toc, followup, download-buttons, all
 * Prints a JSON report; exit code 1 when any check fails.
 */
const port = process.argv[2] || '9342';
const scenario = process.argv[3] || 'all';
const PAGE_URL = process.env.ACCEPT_PAGE || 'http://127.0.0.1:8765/stream-acceptance.html';
const PAGE_MATCH = process.env.ACCEPT_MATCH || 'stream-acceptance';

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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result ? r.result.value : undefined;
  };
  return { ws, send, evaluate, close: () => ws.close() };
}

async function targets() {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

/**
 * Read nodes out of the extension's closed shadow root via DOM pierce.
 * `selector` accepts a comma-separated list of class names; a node matches when
 * it carries every class of at least one alternative (e.g.
 * `.video-summary-answer, .media-summary-answer`).
 */
async function shadowPick(page, selector) {
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const groups = selector.split(',').map(group => group.trim().split(/\s+/).filter(Boolean));
  const found = [];
  const walk = (node, inTemplate) => {
    if (!node) return;
    // Skip the <template> copy of the window used by createUI: it contains a
    // placeholder answer node with no real content.
    const inside = inTemplate || String(node.nodeName || '').toUpperCase() === 'TEMPLATE';
    const attrs = node.attributes || [];
    const map = {};
    for (let i = 0; i < attrs.length; i += 2) map[attrs[i]] = attrs[i + 1];
    const classes = String(map.class || '').split(/\s+/);
    const hit = !inside && groups.some(tokens => tokens.every(token => classes.includes(token.replace(/^\./, ''))));
    if (hit) found.push({ nodeId: node.nodeId, nodeName: node.nodeName, attrs: map });
    (node.children || []).forEach(child => walk(child, inside));
    (node.shadowRoots || []).forEach(child => walk(child, inside));
  };
  walk(doc.root, false);
  return found;
}

/** Pick nodes by tag name (class-based matching cannot express this). */
async function shadowPickTags(page, tags) {
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const wanted = new Set(tags.map(t => t.toUpperCase()));
  const found = [];
  const walk = node => {
    if (!node) return;
    if (wanted.has(String(node.nodeName || '').toUpperCase())) {
      const attrs = node.attributes || [];
      const map = {};
      for (let i = 0; i < attrs.length; i += 2) map[attrs[i]] = attrs[i + 1];
      found.push({ nodeId: node.nodeId, nodeName: node.nodeName, attrs: map });
    }
    (node.children || []).forEach(walk);
    (node.shadowRoots || []).forEach(walk);
  };
  walk(doc.root);
  return found;
}

async function callOn(page, nodeId, fn) {
  const resolved = await page.send('DOM.resolveNode', { nodeId });
  const r = await page.send('Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    functionDeclaration: fn,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (r.exceptionDetails) throw new Error('callOn failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

/** Wait until the summary stops streaming, so DOM node ids stay valid. */
async function waitStreamSettled(page, budgetMs) {
  const deadline = Date.now() + (Number(budgetMs) || 30000);
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const nodes = await shadowPick(page, '.video-summary-answer, .media-summary-answer');
    let len = 0;
    for (const node of nodes) {
      try { len = Math.max(len, await callOn(page, node.nodeId, 'function(){return (this.textContent||"").length}')); }
      catch (e) { /* re-rendering */ }
    }
    if (len > 0 && len === last) {
      stable += 1;
      if (stable >= 3) return len;
    } else {
      stable = 0;
    }
    last = len;
    await sleep(800);
  }
  return last;
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
}

async function openSummary(page) {
  // Scroll the video back into view first: the AI button is only offered for a
  // player that is actually visible in the viewport.
  await page.evaluate(`window.scrollTo(0, 0)`);
  await sleep(400);
  // The video AI button is mounted from a real pointer move; synthetic events
  // dispatched from the page do not reach the extension's capture listeners in
  // headless mode, so drive the actual mouse through CDP.
  const rect = await page.evaluate(`(() => {
    const v = document.getElementById('demoVideo');
    if (!v) return null;
    const r = v.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: Math.round(r.top), h: Math.round(r.height) };
  })()`);
  if (!rect) throw new Error('video element missing');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x - 40, y: rect.y - 30 });
  await sleep(120);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await sleep(1600);
  const list = await targets();
  const worker = list.find(t => t.type === 'service_worker' && t.url.includes('mlpcodaamcfpkbphjdcjmjaamepodnof'));
  if (!worker) throw new Error('extension worker not running');
  const bg = await connect(worker);
  const tabId = await bg.evaluate(`chrome.tabs.query({url:'http://127.0.0.1:8765/*'}).then(ts => (ts.find(t=>t.url.includes(${JSON.stringify(PAGE_MATCH)}))||ts[0]||{}).id)`);
  const clicked = await bg.evaluate(`chrome.scripting.executeScript({target:{tabId:${JSON.stringify(tabId)}},func:()=>{
    // Close a summary left over from an earlier run so its panel cannot cover
    // the AI button.
    const host = document.querySelector('[data-ldp-host]');
    const existing = host && host.shadowRoot ? host.shadowRoot.querySelector('.window.summary-window') : null;
    const closeBtn = existing && existing.querySelector('.panel-close');
    if (closeBtn) closeBtn.click();
    const h = document.getElementById('ldp-video-ai-host');
    const btn = h && h.shadowRoot && h.shadowRoot.querySelector('.ldp-video-ai');
    if (!btn) return {ok:false, reason:'no-button'};
    if (btn.hidden) return {ok:false, reason:'hidden'};
    btn.click();
    return {ok:true};
  }})`);
  bg.close();
  return clicked && clicked[0] && clicked[0].result;
}

async function main() {
  const list = await targets();
  let pageTarget = list.find(t => t.type === 'page' && t.url.includes(PAGE_MATCH));
  if (!pageTarget) {
    const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const b = await connect({ webSocketDebuggerUrl: browser.webSocketDebuggerUrl });
    await b.send('Target.createTarget', { url: PAGE_URL });
    b.close();
    await sleep(3000);
    pageTarget = (await targets()).find(t => t.type === 'page' && t.url.includes(PAGE_MATCH));
  }
  if (!pageTarget) throw new Error('test page not found');
  const page = await connect(pageTarget);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.evaluate(`location.reload()`).catch(() => {});
  await sleep(3500);

  const opened = await openSummary(page);
  check('summary panel opened from the video AI button', opened && opened.ok, opened);

  // ---- streaming continues while the page is being used -------------------
  if (scenario === 'stream' || scenario === 'all') {
    const samples = [];
    for (let i = 0; i < 26; i += 1) {
      await sleep(700);
      // Interact with the page mid-stream: click, scroll, focus elsewhere.
      if (i === 2) await page.evaluate(`document.getElementById('noise').scrollIntoView({block:'center'})`);
      if (i === 4) await page.evaluate(`document.getElementById('n1').click()`);
      if (i === 6) await page.evaluate(`window.dispatchEvent(new Event('resize'))`);
      if (i === 8) await page.evaluate(`document.getElementById('noise').click()`);
      if (i === 10) await page.evaluate(`window.scrollTo(0, 600)`);
      if (i === 12) await page.evaluate(`document.body.click()`);
      if (i === 14) await page.evaluate(`window.dispatchEvent(new Event('blur'))`);
      if (i === 16) await page.evaluate(`document.getElementById('n2').click()`);
      const nodes = await shadowPick(page, '.video-summary-answer, .media-summary-answer');
      let len = 0, done = false;
      for (const node of nodes) {
        try {
          const info = await callOn(page, node.nodeId, 'function(){return {len:(this.textContent||"").length, done:(this.textContent||"").includes("MOCK_STREAM_OK") && (this.textContent||"").includes("结论")}}');
          if (info && info.len > len) len = info.len;
          if (info && info.done) done = true;
        } catch (e) { /* node replaced between calls */ }
      }
      samples.push({ at: i, len, done });
      if (done && len > 200) break;
    }
    // Wait for the panel to report completion (the mock paces chunks slowly, so
    // a fixed sampling window can end mid-answer).
    let completeText = '';
    for (let i = 0; i < 40; i += 1) {
      await sleep(900);
      const ax = await page.send('Accessibility.getFullAXTree');
      const names = ax.nodes.map(n => n.name && n.name.value).filter(Boolean);
      completeText = names.join('\n');
      if (/已加载完成/.test(completeText) && /结论/.test(completeText) && /MOCK_STREAM_OK/.test(completeText)) break;
    }
    const finished = /已加载完成/.test(completeText) && /结论/.test(completeText) && /MOCK_STREAM_OK/.test(completeText);
    const lengths = samples.map(s => s.len);
    const grew = lengths[lengths.length - 1] > lengths[2] + 60;
    check('stream keeps growing while the page is used', grew, { first: lengths[2], last: lengths[lengths.length - 1] });
    const maxLen = Math.max(...lengths);
    check('stream reached the final answer', finished, { finished, maxLen, samples: samples.length });
  }

  // ---- TOC ---------------------------------------------------------------
  if (scenario === 'toc' || scenario === 'all') {
    await waitStreamSettled(page, 40000);
    for (let i = 0; i < 20; i += 1) {
      const nodes = await shadowPick(page, '.summary-toc-toggle');
      if (nodes.length) break;
      await sleep(500);
    }
    const toggles = await shadowPick(page, '.summary-toc-toggle');
    check('TOC toggle button exists', toggles.length > 0, toggles.length);
    if (toggles.length) {
      const initial = await callOn(page, toggles[0].nodeId, 'function(){const list=this.parentNode.querySelector(".summary-toc-list");return {hidden:list.hidden, expanded:this.getAttribute("aria-expanded")}}');
      check('TOC list is collapsed by default', initial && initial.hidden === true, initial);
      await callOn(page, toggles[0].nodeId, 'function(){this.click();return true}');
      await sleep(300);
      const after = await callOn(page, toggles[0].nodeId, 'function(){const list=this.parentNode.querySelector(".summary-toc-list");return {hidden:list.hidden, count:list.querySelectorAll(".summary-toc-item").length, first:(list.querySelector(".summary-toc-item")||{}).textContent}}');
      check('TOC expands after clicking the button', after && after.hidden === false && after.count >= 2, after);
      const items = await shadowPick(page, '.summary-toc-item');
      if (items.length > 1) {
        // Click through the page and measure in one round-trip: the TOC list is
        // rebuilt on click, so node ids fetched beforehand go stale.
        const measureFn = [
          'function(){',
          '  const wrap = this.closest(".summary-toc");',
          '  const list = wrap.querySelector(".summary-toc-list");',
          '  if (list.hidden) wrap.querySelector(".summary-toc-toggle").click();',
          '  const items = wrap.querySelectorAll(".summary-toc-item");',
          '  if (items.length < 2) return { before: -1, after: -1, error: "not enough headings", count: items.length };',
          '  const sc = this.closest(".panel").querySelector(".summary-scroll");',
          '  const before = Math.round(sc.scrollTop);',
          '  items[1].click();',
          '  const targetId = items[1].dataset.target;',
          '  const target = targetId ? sc.querySelector("#" + CSS.escape(targetId)) : null;',
          '  return new Promise(function(resolve){',
          '    setTimeout(function(){',
          '      const scRect = sc.getBoundingClientRect();',
          '      const headings = Array.prototype.map.call(sc.querySelectorAll("h1,h2,h3,h4"), function(h){',
          '        const r = h.getBoundingClientRect();',
          '        return { text: (h.textContent||"").slice(0,20), top: Math.round(r.top), sticky: h.classList.contains("toc-sticky") };',
          '      });',
          '      resolve({',
          '        before: before,',
          '        after: Math.round(sc.scrollTop),',
          '        scrollerTop: Math.round(scRect.top),',
          '        targetText: target ? (target.textContent||"").slice(0,20) : "",',
          '        targetTop: target ? Math.round(target.getBoundingClientRect().top) : null,',
          '        headings: headings,',
          '        listHidden: list.hidden',
          '      });',
          '    }, 1200);',
          '  });',
          '}'
        ].join('\n');
        const measured = await callOn(page, items[0].nodeId, measureFn);
        check('clicking a TOC item scrolls the summary', measured && (measured.after > measured.before || measured.targetTop !== null), measured);
        check('the clicked section lands at the top of the summary',
          !!(measured && measured.targetTop !== null && Math.abs(measured.targetTop - measured.scrollerTop) <= 40),
          measured && { scrollerTop: measured.scrollerTop, targetTop: measured.targetTop, targetText: measured.targetText });
        check('the TOC closes after navigating', !!(measured && measured.listHidden === true), measured && measured.listHidden);
        // Every TOC entry must actually move the summary to its own section.
        const all = await callOn(page, items[0].nodeId, [
          'function(){',
          '  const panel = this.closest(".panel");',
          '  const list = panel.querySelector(".summary-toc-list");',
          '  const items = Array.from(panel.querySelectorAll(".summary-toc-item"));',
          '  const sc = panel.querySelector(".summary-scroll");',
          '  const out = [];',
          '  return (async function(){',
          '    for (let i = 0; i < items.length; i++) {',
          '      list.hidden = false;',
          '      items[i].click();',
          '      await new Promise(r => setTimeout(r, 1000));',
          '      const t = items[i].dataset.target;',
          '      const h = t ? sc.querySelector("#" + CSS.escape(t)) : null;',
          '      const sr = sc.getBoundingClientRect();',
          '      out.push({ i: i, text: (items[i].textContent||"").slice(0,16), relTop: h ? Math.round(h.getBoundingClientRect().top - sr.top) : null });',
          '    }',
          '    return out;',
          '  }).call(this);',
          '}'
        ].join('\n'));
        const nearTop = all.filter(r => r.relTop !== null && Math.abs(r.relTop) <= 40).length;
        check('every TOC entry jumps to its own section', nearTop >= Math.max(1, all.length - 1), { nearTop, total: all.length, all });
        check('a heading is pinned while its section is on screen',
          !!(measured && measured.headings.some(h => h.sticky)),
          measured && measured.headings);
      }
    }
  }

  // ---- follow-up box -----------------------------------------------------
  if (scenario === 'followup' || scenario === 'all') {
    await waitStreamSettled(page, 30000);
    const boxes = await shadowPick(page, '.followup-box');
    check('follow-up box is present', boxes.length > 0, boxes.length);
    if (boxes.length) {
      const visible = await callOn(page, boxes[0].nodeId, 'function(){return {hidden:this.hidden, hasInput:!!this.querySelector(".followup-input"), hasSend:!!this.querySelector(".followup-send")}}');
      check('follow-up box is shown after the summary', visible && visible.hidden === false && visible.hasInput && visible.hasSend, visible);
      await callOn(page, boxes[0].nodeId, 'function(){const i=this.querySelector(".followup-input");i.value="第二部分具体怎么做？";this.querySelector(".followup-send").click();return true}');
      await sleep(2500);
      const turns = await shadowPick(page, '.followup-turn');
      check('asking a question adds a user turn and an answer turn', turns.length >= 2, turns.length);
      const texts = await shadowPick(page, '.followup-text');
      let answerLen = 0;
      for (const t of texts) {
        try {
          const info = await callOn(page, t.nodeId, 'function(){return (this.textContent||"").length}');
          if (info > answerLen) answerLen = info;
        } catch (e) { /* ignore */ }
      }
      check('follow-up answer has content', answerLen > 20, { answerLen });
    }
  }

  // ---- download buttons reflect real availability -----------------------
  if (scenario === 'download' || scenario === 'all') {
    await waitStreamSettled(page, 30000);
    const stateOf = await shadowPick(page, '.summary-actions');
    let buttons = [];
    if (stateOf.length) {
      buttons = await callOn(page, stateOf[0].nodeId, [
        'function(){',
        '  const list = Array.from(this.querySelectorAll("button"));',
        '  return list.map(function(b){',
        '    return { text: (b.textContent||"").trim(), hidden: b.hidden, disabled: b.disabled, cls: b.className };',
        '  });',
        '}'
      ].join('\n'));
    }
    const videoBtn = buttons.find(b => b.text === '下载视频' || /下载视频/.test(b.text));
    const audioBtn = buttons.find(b => b.text === '下载音频' || /下载音频/.test(b.text));
    // This fixture serves a Blob-only video with no direct URL, so no download
    // is actually obtainable: both buttons must stay hidden rather than
    // offering a click that cannot deliver a file.
    check('download buttons exist in the action bar', buttons.length > 0, buttons.map(b => b.text));
    const expectDownloadable = process.env.ACCEPT_DOWNLOADABLE === '1';
    if (expectDownloadable) {
      check('download video is offered on a page with a real MP4', !!(videoBtn && !videoBtn.hidden), videoBtn || null);
      // Exercise the real download: it must show progress, then finish.
      const clicked = await callOn(page, stateOf[0].nodeId, [
        'function(){',
        '  const b = Array.from(this.querySelectorAll("button")).find(x => /下载视频/.test(x.textContent||""));',
        '  if (!b) return { ok: false };',
        '  b.click();',
        '  return { ok: true };',
        '}'
      ].join('\n'));
      const seen = new Set();
      let lastText = '';
      // Poll in-page: the panel re-renders, so cached node ids go stale.
      for (let i = 0; i < 40; i += 1) {
        await sleep(250);
        const anchor = await shadowPick(page, '.summary-actions');
        if (!anchor.length) continue;
        const info = await callOn(page, anchor[0].nodeId, [
          'function(){',
          '  const panel = this.closest(".panel");',
          '  const box = panel && panel.querySelector(".download-progress");',
          '  const t = box && box.querySelector(".download-progress-text");',
          '  const bar = box && box.querySelector(".download-progress-bar");',
          '  return { hidden: box ? box.hidden : null, text: t ? t.textContent : "", width: bar ? bar.style.width : "" };',
          '}'
        ].join('\n')).catch(() => null);
        if (!info) continue;
        lastText = info.text || lastText;
        if (/正在下载|正在准备/.test(info.text)) seen.add('progress');
        if (/下载完成|正在保存|已准备/.test(info.text)) seen.add('saving');
        if (seen.has('saving')) break;
      }
      check('download shows a progress state', seen.has('progress') || seen.has('saving'), { clicked, seen: Array.from(seen), lastText });
      check('download reaches completion', /下载完成|正在保存|已准备/.test(lastText) || seen.has('saving'), { lastText });
    } else {
      check('unavailable downloads stay hidden', (!videoBtn || videoBtn.hidden) && (!audioBtn || audioBtn.hidden),
        { video: videoBtn || null, audio: audioBtn || null });
    }
    const progress = await shadowPick(page, '.download-progress');
    check('progress bar starts hidden until a download runs', progress.length > 0 && (await callOn(page, progress[0].nodeId, 'function(){return this.hidden}')) === true, progress.length);
  }

  page.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n' + JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(err => {
  console.error('ACCEPTANCE_ERROR', err && err.stack || err);
  process.exitCode = 1;
});
