'use strict';
/**
 * Follow-up chat under a finished summary: context chain, request shape and UI.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src/extension.content.js'), 'utf8');
const built = fs.readFileSync(path.join(ROOT, 'extension/content.js'), 'utf8');
const background = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');

const block = (from, to) => {
  const start = source.indexOf(from);
  assert.ok(start >= 0, from);
  const end = to ? source.indexOf(to, start + from.length) : source.length;
  assert.ok(end > start, to || from);
  return source.slice(start, end);
};

test('follow-up box lives under the summary answer in every summary panel', () => {
  // The composer must sit OUTSIDE .summary-scroll: that container is clipped by
  // the panel's overflow:hidden, which previously made the textarea unusable.
  const appended = (source.match(/body\.appendChild\(buildFollowupBox\(item\)\)/g) || []).length;
  assert.equal(appended, 3, 'video, media and text-ai panels must all host the box');
  assert.ok(!/scroll\.appendChild\(buildFollowupBox/.test(source), 'composer must not live inside the scroller');
  assert.match(source, /function buildFollowupBox/);
  assert.match(source, /function syncFollowupVisibility/);
});

test('follow-up appears only once there is something to ask about', () => {
  const fn = block('  function syncFollowupVisibility(', '\n  function ');
  assert.match(fn, /summaryContextFor\(item\)/);
  assert.match(fn, /box\.hidden = !ready/);
  const panels = (source.match(/syncFollowupVisibility\(item\)/g) || []).length;
  assert.ok(panels >= 6, 'expected follow-up to be revealed after summaries, got ' + panels);
});

test('follow-up requests carry summary, source and recent history', () => {
  const fn = block('  async function askFollowup(', '\n  function buildFollowupBox');
  assert.match(fn, /action: 'followup'/);
  assert.match(fn, /summary: ctx\.summary/);
  assert.match(fn, /text: \(ctx\.source \|\| ctx\.summary\)/);
  assert.match(fn, /history: history\.slice\(-6\)/);
  assert.match(fn, /media: !!ctx\.media/);
  assert.match(fn, /FOLLOWUP_HISTORY_LIMIT/);
});

test('follow-up guards against double submit and empty context', () => {
  const fn = block('  async function askFollowup(', '\n  function buildFollowupBox');
  assert.match(fn, /if \(item\.followupBusy\)/);
  assert.match(fn, /先完成一次总结再追问/);
  assert.match(fn, /followupBusyUI\(item, true\)/);
  assert.match(source, /ui\.followupSend\.disabled = !!busy/);
});

test('background supports the followup action with a dedicated system prompt', () => {
  assert.match(background, /action === 'followup'/);
  assert.match(background, /总结追问助手/);
  assert.match(background, /【已有总结】/);
  assert.match(background, /【此前的追问与回答】/);
});

test('streamed follow-up answer renders as markdown', () => {
  const fn = block('  async function askFollowup(', '\n  function buildFollowupBox');
  assert.match(fn, /answerNode\.innerHTML = markdownToHtml/);
  assert.match(fn, /refreshSummaryToc/);
});

test('built artifact contains the follow-up UI', () => {
  assert.match(built, /followup-input-row/);
  assert.match(built, /继续追问/);
});
