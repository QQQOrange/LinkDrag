'use strict';
const KEY = 'LPS_SIDE_PANEL';
const $ = id => document.getElementById(id);
const I18N = window.LinkDragI18N;
const tr = (zh, en) => (I18N && I18N.isEnglish && I18N.isEnglish() ? en : zh);
let current = null;

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function simpleMarkdown(source) {
  const lines = String(source || '').split(/\r?\n/);
  let html = '';
  let inList = false;
  const inline = text => escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { if (inList) { html += '</ul>'; inList = false; } continue; }
    const heading = line.match(/^#{1,3}\s+(.+)/);
    if (heading) { if (inList) { html += '</ul>'; inList = false; } html += '<h2>' + inline(heading[1]) + '</h2>'; continue; }
    const bullet = line.match(/^[-*]\s+(.+)/);
    if (bullet) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(bullet[1]) + '</li>'; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    html += '<p>' + inline(line) + '</p>';
  }
  if (inList) html += '</ul>';
  return html;
}

function render(data) {
  current = data || null;
  if (!current || (!current.answer && !current.status)) {
    $('empty').hidden = false; $('result').hidden = true; return;
  }
  $('empty').hidden = true; $('result').hidden = false;
  $('kind').textContent = current.kind || tr('总结', 'Summary');
  $('time').textContent = current.time ? new Date(current.time).toLocaleString() : '';
  $('title').textContent = current.title || tr('内容总结', 'Content summary');
  $('status').textContent = current.status || '';
  $('status').className = 'status' + (current.tone ? ' ' + current.tone : '');
  $('answer').innerHTML = simpleMarkdown(current.answer || '');
  $('source').textContent = current.source || '';
}

$('copy').addEventListener('click', async () => {
  if (!current || !current.answer) return;
  try { await navigator.clipboard.writeText(current.answer); $('copy').textContent = tr('已复制', 'Copied'); setTimeout(() => $('copy').textContent = tr('复制', 'Copy'), 1200); } catch (e) { /* ignore */ }
});

(async () => {
  if (I18N) await I18N.init();
  chrome.storage.local.get(KEY, value => render(value && value[KEY]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) render(changes[KEY].newValue);
  });
})();
