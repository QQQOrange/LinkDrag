'use strict';
/**
 * Input-method acceptance for the follow-up composer.
 *
 * The complaint was that the field only accepted one specific input method.
 * This drives every realistic path a user or a dictation/IME tool can take:
 *   - real keystrokes (rawKeyDown + char)
 *   - Input.insertText (what several voice tools use)
 *   - document.execCommand('insertText')
 *   - real Ctrl+V paste through the browser clipboard
 *   - IME composition events (compositionstart/update/end)
 *   - direct value assignment + input event
 *
 *   node tools/accept_input.js <cdpPort> [urlPart]
 */
const { sleep, connectTo, listTargets, connectPage, pickShadows, callOn } = require('./cdp');

const port = process.argv[2] || '9345';
const pageMatch = process.argv[3] || 'stream-acceptance';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 240)));
}

async function grantClipboard() {
  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const browser = await connectTo({ webSocketDebuggerUrl: version.webSocketDebuggerUrl });
    await browser.send('Browser.grantPermissions', {
      origin: 'http://127.0.0.1:8765',
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
    }).catch(() => {});
    browser.close();
  } catch (e) { /* clipboard may still work without it */ }
}

async function composer(page) {
  const found = await pickShadows(page, 'followup-input');
  return found.length ? found[0].nodeId : null;
}

async function focusComposer(page) {
  const nodeId = await composer(page);
  if (!nodeId) return null;
  const rect = await callOn(page, nodeId, 'function(){const r=this.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)}}');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(150);
  return nodeId;
}

async function reset(page) {
  const nodeId = await composer(page);
  if (!nodeId) return;
  await callOn(page, nodeId, 'function(){this.value="";this.focus();return true}');
  await sleep(60);
}

async function valueOf(page) {
  const nodeId = await composer(page);
  return nodeId ? callOn(page, nodeId, 'function(){return this.value}') : null;
}

async function typeReal(page, text) {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    await page.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
      code: /[a-zA-Z]/.test(ch) ? 'Key' + ch.toUpperCase() : undefined
    });
    await page.send('Input.dispatchKeyEvent', {
      type: 'char', key: ch, text: ch, unmodifiedText: ch,
      windowsVirtualKeyCode: code, nativeVirtualKeyCode: code
    });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await sleep(20);
  }
  await sleep(200);
}

async function main() {
  await grantClipboard();
  const page = await connectPage(port, pageMatch);

  const nodeId = await focusComposer(page);
  check('composer can be focused by a real click', !!nodeId, nodeId);
  if (!nodeId) { page.close(); process.exitCode = 1; return; }

  const focused = await callOn(page, nodeId, 'function(){return this.matches(":focus")}');
  check('composer reports focus', focused === true, focused);
  const disabled = await callOn(page, nodeId, 'function(){return {disabled:this.disabled, readOnly:this.readOnly}}');
  check('composer is never disabled or read-only', disabled.disabled === false && disabled.readOnly === false, disabled);

  // 1. real keyboard
  await reset(page);
  await typeReal(page, '键盘输入');
  check('real keystrokes insert text', (await valueOf(page)) === '键盘输入', await valueOf(page));

  // 2. Input.insertText — used by several dictation tools
  await reset(page);
  const ins = await page.send('Input.insertText', { text: '听写写入' });
  await sleep(250);
  check('Input.insertText (dictation path) inserts text', (await valueOf(page)) === '听写写入', { value: await valueOf(page), ins });

  // 3. execCommand insertText
  await reset(page);
  const exec = await callOn(page, await composer(page), 'function(){return document.execCommand("insertText", false, "命令插入")}');
  await sleep(200);
  check('execCommand insertText inserts text', (await valueOf(page)) === '命令插入', { value: await valueOf(page), exec });

  // 4. real Ctrl+V
  await reset(page);
  const write = await page.evaluate(`navigator.clipboard.writeText('剪贴板粘贴').then(()=>'ok').catch(e=>'fail:'+e.name)`);
  await sleep(250);
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
  await sleep(900);
  const pasted = await valueOf(page);
  check('Ctrl+V paste inserts text', pasted === '剪贴板粘贴', { value: pasted, clipboard: write });

  // 5. IME composition
  await reset(page);
  const ime = await callOn(page, await composer(page), [
    'function(){',
    '  this.focus();',
    '  this.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));',
    '  this.value = "语音转文字";',
    '  this.dispatchEvent(new InputEvent("input", { bubbles: true, data: "语音转文字", inputType: "insertCompositionText", isComposing: true }));',
    '  this.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "语音转文字" }));',
    '  return this.value;',
    '}'
  ].join('\n'));
  await sleep(200);
  check('IME composition inserts text', (await valueOf(page)) === '语音转文字', { ime, value: await valueOf(page) });

  // 6. direct assignment (some screen readers / automation do this)
  await reset(page);
  await callOn(page, await composer(page), 'function(){this.value="直接赋值";this.dispatchEvent(new Event("input",{bubbles:true}));return true}');
  await sleep(200);
  check('direct value assignment is preserved', (await valueOf(page)) === '直接赋值', await valueOf(page));

  // 7. the draft survives a panel re-render
  await reset(page);
  await page.send('Input.insertText', { text: '重建后仍在' });
  await sleep(300);
  const survivor = await pickShadows(page, 'followup-box');
  const rebuilt = survivor.length && await callOn(page, survivor[0].nodeId, [
    'function(){',
    '  const win = this.closest(".window");',
    '  const retry = Array.from(win.querySelectorAll("button")).find(b => /重新总结/.test(b.textContent||""));',
    '  if (retry) retry.click();',
    '  return { clicked: !!retry };',
    '}'
  ].join('\n'));
  await sleep(2500);
  const after = await valueOf(page);
  check('text survives a panel re-render', after === '重建后仍在', { rebuilt, after });

  page.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n' + JSON.stringify({ total: results.length, failed: failed.length }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(err => { console.error('INPUT_ACCEPT_ERROR', err && err.stack || err); process.exitCode = 1; });
