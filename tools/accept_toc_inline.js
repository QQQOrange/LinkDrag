'use strict';
/**
 * The outline icon must sit INSIDE the pinned chapter bar, immediately left of
 * the current chapter title, and open the outline right below that bar.
 *
 *   node tools/accept_toc_inline.js <cdpPort>
 */
const { sleep, connectTo, listTargets, connectPage, pickShadows, callOn } = require('./cdp');

const port = process.argv[2] || '9356';
const PAGE = 'http://127.0.0.1:8765/stream-acceptance.html';
const MATCH = 'stream-acceptance';
const MOCK = 'http://127.0.0.1:8767';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 300)));
};

async function configure() {
  let targets = await listTargets(port);
  let sw = targets.find(t => t.type === 'service_worker' && t.url.includes('mlpcodaamcfpkbphjdcjmjaamepodnof'));
  if (!sw) {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const b = await connectTo({ webSocketDebuggerUrl: version.webSocketDebuggerUrl });
    await b.send('Target.createTarget', { url: 'chrome-extension://mlpcodaamcfpkbphjdcjmjaamepodnof/popup.html' });
    b.close();
    await sleep(2500);
    targets = await listTargets(port);
    sw = targets.find(t => t.type === 'service_worker' && t.url.includes('mlpcodaamcfpkbphjdcjmjaamepodnof'));
  }
  if (!sw) return false;
  const bg = await connectTo(sw);
  await bg.send('Runtime.enable');
  const cfg = {
    provider: 'custom', endpoint: MOCK + '/v1/chat/completions', apiKey: 'test-key',
    model: 'mock-model-a', apiKeys: {}, models: {}, providerConfigs: {}, selectedModels: {},
    mediaApiKey: 'test-key', mediaModel: 'FunAudioLLM/SenseVoiceSmall',
    mediaEndpoint: MOCK + '/v1/audio/transcriptions', summaryPrompt: '测试总结'
  };
  await bg.evaluate(`chrome.storage.local.set({'FOX_QQQORANGE_PREVIEW_140_AI':${JSON.stringify(cfg)}}).then(()=>'ok')`);
  bg.close();
  return true;
}

async function openPanel() {
  const targets = await listTargets(port);
  const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  let pageTarget = targets.find(t => t.type === 'page' && t.url.includes(MATCH));
  if (!pageTarget) {
    const b = await connectTo({ webSocketDebuggerUrl: browser.webSocketDebuggerUrl });
    await b.send('Target.createTarget', { url: PAGE });
    b.close();
    await sleep(4000);
  }
  const page = await connectPage(port, MATCH);
  await page.send('Page.reload', { ignoreCache: false }).catch(() => {});
  await sleep(2500);
  const vp = await page.evaluate(`(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    v.play().catch(() => {});
    const r = v.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 140)) };
  })()`);
  if (vp) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x - 50, y: vp.y - 30 });
    await sleep(200);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x, y: vp.y });
    await sleep(2200);
  }
  const main = await fetch(`http://127.0.0.1:${port}/json/version`);
  const workerTargets = await listTargets(port);
  const sw = workerTargets.find(t => t.type === 'service_worker' && t.url.includes('mlpcodaamcfpkbphjdcjmjaamepodnof'));
  if (sw) {
    const bg = await connectTo(sw);
    await bg.send('Runtime.enable');
    const tabs = await bg.evaluate(`chrome.tabs.query({url:'http://127.0.0.1:8765/*'}).then(ts => ts.map(t => ({id:t.id,url:t.url})))`);
    const tab = (tabs || []).find(t => String(t.url).includes(MATCH));
    if (tab) {
      await bg.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>{
        const h=document.getElementById('ldp-video-ai-host');
        const b=h&&h.shadowRoot&&h.shadowRoot.querySelector('.ldp-video-ai');
        if(!b||b.hidden) return false;
        b.click(); return true;
      }})`);
    }
    bg.close();
  }
  void main;
  return page;
}

async function main() {
  check('mock AI provider configured', await configure());
  const page = await openPanel();

  // wait for the answer
  let done = false;
  for (let i = 0; i < 150; i += 1) {
    await sleep(800);
    const ax = await page.send('Accessibility.getFullAXTree');
    const text = ax.nodes.map(n => n.name && n.name.value).filter(Boolean).join('\n');
    if (/已加载完成/.test(text) && /结论/.test(text)) { done = true; break; }
    if (/总结失败/.test(text)) break;
  }
  check('summary finished streaming', done, done);

  let triggers = await pickShadows(page, 'toc-inline-trigger');
  for (let i = 0; i < 20 && !triggers.length; i += 1) { await sleep(600); triggers = await pickShadows(page, 'toc-inline-trigger'); }
  check('outline icon exists', triggers.length > 0, triggers.length);
  if (!triggers.length) { page.close(); process.exitCode = 1; return; }

  const geom = await callOn(page, triggers[0].nodeId, [
    'function(){',
    '  const win = this.closest(".window");',
    '  const bar = win.querySelector("h1.toc-sticky, h2.toc-sticky, h3.toc-sticky, h4.toc-sticky");',
    '  const t = this.getBoundingClientRect();',
    '  const b = bar.getBoundingClientRect();',
    '  const titleText = (bar.textContent || "").replace(/\\s+/g, "").slice(0, 10);',
    '  return {',
    '    hidden: this.hidden,',
    '    bar: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],',
    '    icon: [Math.round(t.left), Math.round(t.top), Math.round(t.width)],',
    '    sameRow: t.top >= b.top - 2 && t.bottom <= b.bottom + 2,',
    '    leftOfTitle: t.left >= b.left && t.left - b.left < 30,',
    '    title: titleText',
    '  };',
    '}'
  ].join('\n'));
  check('icon is inside the pinned bar, in front of the chapter title',
    !!(geom && !geom.hidden && geom.sameRow && geom.leftOfTitle), geom);

  // real mouse click on the icon
  const pt = await callOn(page, triggers[0].nodeId, 'function(){const r=this.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await sleep(500);

  const list = await pickShadows(page, 'summary-toc-list');
  const open = list.length ? await callOn(page, list[0].nodeId, [
    'function(){',
    '  const r = this.getBoundingClientRect();',
    '  const win = this.closest(".window");',
    '  const bar = win.querySelector("h1.toc-sticky, h2.toc-sticky, h3.toc-sticky, h4.toc-sticky");',
    '  const b = bar.getBoundingClientRect();',
    '  return { hidden: this.hidden, count: this.querySelectorAll(".summary-toc-item").length,',
    '    below: r.top >= b.bottom - 6, gap: Math.round(r.top - b.bottom), width: Math.round(r.width) };',
    '}'
  ].join('\n')) : null;
  check('clicking the icon opens the outline right below the bar',
    !!(open && !open.hidden && open.count > 0 && open.below), open);

  // pick the third entry with a real click and verify the jump
  const items = await pickShadows(page, 'summary-toc-item');
  if (items.length > 2) {
    const scroller = (await pickShadows(page, 'summary-scroll'))[0];
    const before = await callOn(page, scroller.nodeId, 'function(){return Math.round(this.scrollTop)}');
    const ip = await callOn(page, items[2].nodeId, 'function(){const r=this.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ip.x, y: ip.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ip.x, y: ip.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ip.x, y: ip.y, button: 'left', clickCount: 1 });
    await sleep(1500);
    const scroller2 = (await pickShadows(page, 'summary-scroll'))[0];
    const after = await callOn(page, scroller2.nodeId, 'function(){return Math.round(this.scrollTop)}');
    const listNow = await pickShadows(page, 'summary-toc-list');
    const closed = listNow.length ? await callOn(page, listNow[0].nodeId, 'function(){return this.hidden}') : true;
    check('clicking an entry jumps and closes the outline', after !== before && closed === true, { before, after, closed });
  }

  // the icon must follow the active chapter bar
  const followed = await callOn(page, (await pickShadows(page, 'summary-scroll'))[0].nodeId, [
    'function(){',
    '  const win = this.closest(".window");',
    '  const bar = this.querySelector("h1.toc-sticky, h2.toc-sticky, h3.toc-sticky, h4.toc-sticky");',
    '  if (!bar) return { ok: false };',
    '  const icon = win.querySelector(".toc-inline-trigger");',
    '  const b = bar.getBoundingClientRect();',
    '  const t = icon.getBoundingClientRect();',
    '  return { ok: !icon.hidden && t.top >= b.top - 2 && t.bottom <= b.bottom + 2,',
    '    iconTop: Math.round(t.top), barTop: Math.round(b.top), barText: (bar.textContent||"").replace(/\\s+/g,"").slice(0,10) };',
    '}'
  ].join('\n'));
  check('icon stays with the pinned chapter after a jump', !!(followed && followed.ok), followed);

  page.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n' + JSON.stringify({ total: results.length, failed: failed.length }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(err => { console.error('TOC_INLINE_ERROR', err && err.stack || err); process.exitCode = 1; });
