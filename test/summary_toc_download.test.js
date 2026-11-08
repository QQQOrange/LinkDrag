'use strict';
/**
 * Summary TOC (sticky headings + collapsible outline), download availability
 * gating and download progress.  The reader/DOM parts are exercised against a
 * minimal fake DOM so the real source is the code under test.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src/extension.content.js'), 'utf8');
const built = fs.readFileSync(path.join(ROOT, 'extension/content.js'), 'utf8');

function extract(name) {
  const sync = source.indexOf('  function ' + name + '(');
  const async = source.indexOf('  async function ' + name + '(');
  const start = [sync, async].filter(index => index >= 0).sort((a, b) => a - b)[0];
  assert.ok(start >= 0, name);
  const candidates = [source.indexOf('\n  function ', start + 10), source.indexOf('\n  async function ', start + 10)]
    .filter(index => index > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end).trimEnd();
}

test('summary TOC is built from headings and stays collapsed by default', () => {
  assert.match(source, /function bindSummaryToc/);
  assert.match(source, /const TOC_MIN_HEADINGS = 2/);
  assert.match(source, /list\.hidden = !open/);
  assert.match(source, /toggle\.addEventListener\('click'/);
  // Jumps go through scrollIntoView; offsetTop alone is relative to the
  // positioned answer card and used to land in the wrong place.
  assert.match(source, /function jumpToHeading/);
  assert.match(source, /scroller\.scrollTo\(\{ top: target, behavior: 'smooth' \}\)/);
  assert.match(source, /scroller\.scrollTop = target/);
  assert.match(source, /jumpToHeading\(root, node\)/);
});

test('active chapter drives the sticky heading', () => {
  assert.match(source, /toc-sticky/);
  assert.match(source, /toc-passed/);
  // Only the active chapter is sticky; making every heading sticky stacked them
  // on top of each other and made TOC jumps look like no-ops.
  assert.match(source, /\.summary-scroll \.markdown \.toc-sticky\{position:sticky;top:0/);
  assert.doesNotMatch(source, /\.markdown h1,\.summary-scroll \.markdown h2\{position:sticky/);
  assert.match(source, /nodeRect\.top - scrollerRect\.top <= 56/);
});

test('TOC refreshes for streamed and static answers', () => {
  const calls = (source.match(/refreshSummaryToc\(item\)/g) || []).length;
  assert.ok(calls >= 6, 'expected TOC refresh at every answer render, got ' + calls);
  assert.match(source, /item\.ui\.aiOut = out/);
  assert.match(source, /function refreshSummaryToc/);
});

test('download progress element exists in both summary panels', () => {
  assert.match(source, /function buildDownloadProgress/);
  assert.match(source, /function updateDownloadProgress/);
  assert.match(source, /function fetchBlobWithProgress/);
  assert.match(source, /function prepareAndSave/);
  const appended = (source.match(/scroll\.appendChild\(downloadProgress\.box\)/g) || []).length;
  assert.equal(appended, 2, 'video and media panels must both show progress');
  assert.match(source, /\.download-progress-bar\{display:block;width:0/);
});

test('download buttons only appear when the file is actually obtainable', () => {
  assert.match(source, /function setDownloadCapability/);
  assert.match(source, /function detectDownloadCapability/);
  assert.match(source, /button\.hidden = !available/);
  assert.match(source, /button\.disabled = !available/);
  // Both panels start hidden and probe the real capability afterwards.
  const hiddenInitial = (source.match(/videoDownload\.hidden = true;/g) || []).length;
  assert.equal(hiddenInitial, 2);
  const probes = (source.match(/detectDownloadCapability\(item\)/g) || []).length;
  assert.ok(probes >= 2, 'each summary panel must probe capability, got ' + probes);
});

test('prepareAndSave downloads fully before saving', () => {
  const fn = extract('prepareAndSave');
  assert.match(fn, /fetchBlobWithProgress/);
  assert.match(fn, /downloadBlob\(blob, opts\.filename\)/);
  assert.ok(fn.indexOf('fetchBlobWithProgress') < fn.indexOf('downloadBlob(blob'), 'download must finish before save');
  assert.doesNotMatch(fn, /mergeSeparateTracks/);
});

test('generated artifact carries the new TOC and progress code', () => {
  assert.match(built, /summary-toc-toggle/);
  assert.match(built, /download-progress-bar/);
  assert.match(built, /function detectDownloadCapability/);
});


test('follow-up text follows the summary font size control', () => {
  assert.match(source, /const SUMMARY_TEXT_SELECTOR = /);
  assert.match(source, /SUMMARY_TEXT_SELECTOR[\s\S]{0,200}followup-text/);
  // Every place that changes the size must apply the shared selector.
  const uses = (source.match(/querySelectorAll\(SUMMARY_TEXT_SELECTOR\)/g) || []).length;
  assert.ok(uses >= 2, 'theme pass and A± must both apply the shared selector, got ' + uses);
  assert.doesNotMatch(source, /querySelectorAll\('\.video-summary-answer,\.media-summary-answer,\.text-ai-answer,\.ai-answer'\)/);
  // CSS must not hard-code a fixed size for the composer.
  assert.match(source, /\.followup-text\{[^}]*font-size:var\(--summary-font-size,14px\)/);
  assert.match(source, /\.followup-input\{[^}]*font-size:var\(--summary-font-size,14px\)/);
  assert.match(source, /function summaryFontSizeValue/);
});


test('outline outside-click does not close on its own items inside a closed shadow root', () => {
  // Regression: a document-level pointerdown listener sees only the retargeted
  // host for events inside the closed shadow root, so clicking an outline entry
  // was treated as "outside" and closed the list on pointerdown — the entry
  // vanished before mouseup, so no click and no jump ever happened.
  assert.match(source, /const closeIfOutside = event =>/);
  assert.match(source, /const rootNode = \(\(\) => \{ try \{ return wrap\.getRootNode\(\); \}/);
  assert.match(source, /rootNode\.addEventListener\('pointerdown', closeIfOutside, true\)/);
  assert.match(source, /if \(host && \(target === host \|\| \(host\.contains && host\.contains\(target\)\)\)\) return;/);
});

test('summary panel rebuilds do not accumulate outline or composer nodes', () => {
  assert.match(source, /panel\.querySelectorAll\('\.summary-toc'\)\.forEach\(node => node\.remove\(\)\)/);
  assert.match(source, /panel\.querySelectorAll\('\.followup-box'\)\.forEach\(node => node\.remove\(\)\)/);
  assert.match(source, /item\._tocScrollTarget = root/);
});

test('the composer keeps drafts and focus across a re-render', () => {
  assert.match(source, /item\.followupDraft = input\.value/);
  assert.match(source, /input\.value = String\(item\.followupDraft \|\| ''\)/);
  assert.match(source, /item\.followupFocusWanted = true/);
  assert.match(source, /compositionend/);
  assert.doesNotMatch(source, /ui\.followupInput\.disabled = !!busy/);
});
