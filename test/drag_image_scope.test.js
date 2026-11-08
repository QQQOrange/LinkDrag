'use strict';
/**
 * Regression checks for text-selection drags, image original resolution and
 * the scope/cursor of the floating video AI button.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src/extension.content.js'), 'utf8');
function extract(name) {
  const start = source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  const plainEnd = source.indexOf('\n  function ', start + 10);
  const asyncEnd = source.indexOf('\n  async function ', start + 10);
  const end = plainEnd >= 0 && (asyncEnd < 0 || plainEnd < asyncEnd) ? plainEnd : asyncEnd;
  assert.ok(end > start, name + ' end');
  return source.slice(start, end).trimEnd();
}

global.location = { hostname: 'www.douyin.com', href: 'https://www.douyin.com/jingxuan' };
global.window = {
  URL,
  innerWidth: 1280,
  innerHeight: 900,
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
};
const code = [
  'const isStr = v => typeof v === "string";',
  'selectionIntersectsElement',
  'normalizeImageUrl',
  'imageOriginalVariant',
  'imageOriginalVariants',
  'imageUrlsFromHtml',
  'isVideoSummaryEligible'
].map((name, index) => index === 0 ? name : extract(name)).join('\n');
const api = new Function(code + '\nreturn { selectionIntersectsElement, imageOriginalVariants, imageUrlsFromHtml, isVideoSummaryEligible };')();

test('selection detection only matches text inside the selected range', () => {
  const target = { nodeType: 1, parentElement: null };
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    containsNode: node => node === target
  };
  assert.equal(api.selectionIntersectsElement(selection, target), true);
  assert.equal(api.selectionIntersectsElement(selection, { nodeType: 1 }), false);
  assert.equal(api.selectionIntersectsElement({ isCollapsed: true, rangeCount: 0 }, target), false);
});

test('selected-text drags are excluded from drop previews', () => {
  assert.match(source, /window\.__LPS_TEXT_DRAG__ = false/);
  assert.match(source, /if \(!previewSource \|\| selectionTouchesEvent\(event\)\) \{[\s\S]*?__LPS_TEXT_DRAG__ = true/);
  assert.match(source, /target\.closest\('a\[href\],img'\)/);
  assert.match(source, /function hasUrlPayload\(dt\) \{\s*if \(!dt \|\| window\.__LPS_TEXT_DRAG__\) return false/);
  assert.match(source, /if \(window\.__LPS_TEXT_DRAG__\) \{[\s\S]*?return;/);
});

test('image URLs are upgraded from common thumbnail variants', () => {
  const variants = api.imageOriginalVariants('https://cdn.example/gallery/photo-300x200.jpg');
  assert.equal(variants[0], 'https://cdn.example/gallery/photo.jpg');
  assert.ok(api.imageOriginalVariants('https://cdn.example/gallery/photo_thumb.jpg').includes('https://cdn.example/gallery/photo.jpg'));
  assert.ok(api.imageOriginalVariants('https://cdn.example/thumb/photo.jpg').includes('https://cdn.example/photo.jpg'));
});

test('viewer-page metadata can provide the original image', () => {
  const html = `
    <meta content="https://cdn.example/full.jpg" property="og:image">
    <meta property="og:image:secure_url" content="https://cdn.example/full-secure.jpg">
    <meta name="twitter:image" content="https://cdn.example/twitter.jpg">
  `;
  const urls = api.imageUrlsFromHtml(html, 'https://site.example/photo/1');
  assert.deepEqual(urls, [
    'https://cdn.example/full.jpg',
    'https://cdn.example/full-secure.jpg',
    'https://cdn.example/twitter.jpg'
  ]);
  assert.match(source, /sourcePageUrl: sourcePageUrl/);
  assert.match(source, /upgradeImageViewerFromPage\(item, info\.sourcePageUrl\)/);
});

test('video AI eligibility ignores comment/notification videos and tiny players', () => {
  const base = {
    tagName: 'VIDEO',
    isConnected: true,
    getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600 }),
    closest(selector) {
      if (selector.indexOf('data-e2e*="comment"') >= 0) return this.__chrome || null;
      if (selector.indexOf('feed-active-video') >= 0) return this.__player || null;
      return null;
    }
  };
  const primary = Object.assign({}, base, { __player: { id: 'sliderVideo' } });
  assert.equal(api.isVideoSummaryEligible(primary), true);
  const commentVideo = Object.assign({}, base, { __player: { id: 'sliderVideo' }, __chrome: { className: 'comment-list' } });
  assert.equal(api.isVideoSummaryEligible(commentVideo), false);
  const tiny = Object.assign({}, base, { getBoundingClientRect: () => ({ width: 90, height: 60, left: 0, top: 0, right: 90, bottom: 60 }) });
  assert.equal(api.isVideoSummaryEligible(tiny), false);
  const card = Object.assign({}, base, { __player: { id: 'sliderVideo' }, getBoundingClientRect: () => ({ width: 320, height: 240, left: 0, top: 0, right: 320, bottom: 240 }) });
  assert.equal(api.isVideoSummaryEligible(card), false);
});

test('the AI button only appears for an eligible hovered/current player', () => {
  assert.doesNotMatch(source, /showVideoAI\(videos\[0\]\)/);
  assert.match(source, /if \(!isVideoSummaryEligible\(video\)\) \{ hideVideoAI\(\); return; \}/);
  assert.match(source, /if \(!videoAICurrent\) return;/);
  assert.match(source, /button\.style\.left = '-9999px'/);
  assert.match(source, /stable < 3/);
  assert.match(source, /videoAIShowToken\+\+/);
});

test('the summary header only shows a grab cursor when it is actually free-floating', () => {
  assert.match(source, /\.window\.summary-window \.panel-head\{cursor:default/);
  assert.match(source, /\.window\.summary-window\[data-summary-dock="free"\] \.panel-head\{cursor:grab\}/);
  assert.match(source, /\.window\.summary-window\[data-summary-dock="free"\] \.panel-head:active\{cursor:grabbing\}/);
});
