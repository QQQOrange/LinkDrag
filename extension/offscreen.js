'use strict';

function wavChunk(buffer, sampleRate, startFrame, endFrame) {
  const channels = 1;
  // startFrame/endFrame are output-timeline positions (16 kHz).  Converting
  // source offsets to output frames *and then* applying the source/output rate
  // ratio again made every chunk after the first run too fast and end in
  // silence.
  const frames = Math.max(0, Math.floor(endFrame) - Math.floor(startFrame));
  const out = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(out);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * 2, true);
  let offset = 44;
  const sourceRate = buffer.sampleRate;
  const channel = buffer.getChannelData(0);
  const start = Math.max(0, Math.floor(startFrame));
  for (let i = 0; i < frames; i++) {
    const sourceIndex = Math.min(buffer.length - 1, Math.floor((start + i) * sourceRate / sampleRate));
    const sample = channel[sourceIndex] || 0;
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7FFF, true);
    offset += 2;
  }
  return new Blob([out], { type: 'audio/wav' });
}

function blobToDataUrl(blob) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve('');
    reader.readAsDataURL(blob);
  });
}

async function transcribeAudioFile(dataUrl, endpoint, key, model) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return { ok: false, reason: 'bad-data' };
  const bytes = Uint8Array.from(atob(dataUrl.slice(comma + 1)), char => char.charCodeAt(0));
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model || 'FunAudioLLM/SenseVoiceSmall');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240000);
  try {
    const res = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form, signal: controller.signal });
    const raw = await res.text();
    if (!res.ok) return { ok: false, reason: 'http', detail: 'HTTP ' + res.status + (raw ? '：' + raw.slice(0, 180) : '') };
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    const text = String((data && data.text) || (!data ? raw : '') || '').trim();
    return text ? { ok: true, text } : { ok: false, reason: 'empty-asr' };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network', detail: e && e.message ? String(e.message).slice(0, 160) : '' };
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeRemote(request) {
  const url = String(request && request.url || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'invalid-url' };
  // Validate credentials before downloading a potentially huge media file.
  const endpoint = String(request.endpoint || '').replace(/\/chat\/completions\/?$/i, '/audio/transcriptions');
  const key = String(request.key || '');
  const model = String(request.model || 'FunAudioLLM/SenseVoiceSmall');
  if (!endpoint || !key) return { ok: false, reason: 'missing-config' };
  const headers = {};
  if (/bilibili|bilivideo/i.test(url)) {
    headers.Referer = 'https://www.bilibili.com/';
    headers.Origin = 'https://www.bilibili.com';
    headers.Accept = '*/*';
  }
  let res;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  try {
    res = await fetch(url, { credentials: 'include', redirect: 'follow', headers, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network', detail: e && e.message ? String(e.message).slice(0, 160) : '' };
  }
  if (!res.ok) { clearTimeout(timer); return { ok: false, reason: 'http', detail: '媒体 HTTP ' + res.status }; }
  let bytes;
  try {
    bytes = await res.arrayBuffer();
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network', detail: '媒体读取失败' };
  } finally {
    clearTimeout(timer);
  }
  if (bytes.byteLength > 120 * 1024 * 1024) return { ok: false, reason: 'too-large', detail: '音频超过 120MB' };
  let audio;
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    let context;
    // Long podcasts can be 30–60 minutes.  Decoding them at 48 kHz creates a
    // huge AudioBuffer; 16 kHz is all the ASR pipeline needs and cuts memory
    // to one third.
    try { context = new AudioCtor({ sampleRate: 16000 }); }
    catch (e) { context = new AudioCtor(); }
    audio = await context.decodeAudioData(bytes.slice(0));
    try { context.close(); } catch (e) { /* ignore */ }
  } catch (e) {
    return { ok: false, reason: 'decode', detail: e && e.message ? String(e.message).slice(0, 160) : '无法解码音频' };
  }
  const sampleRate = 16000;
  const chunkSeconds = Number(request.chunkSeconds) || 300;
  const totalFrames = Math.ceil(audio.duration * sampleRate);
  const chunkFrames = Math.max(1, Math.round(sampleRate * chunkSeconds));
  const totalChunks = Math.ceil(totalFrames / chunkFrames);
  if (!totalChunks || !Number.isFinite(totalChunks)) return { ok: false, reason: 'empty-audio' };
  const parts = new Array(totalChunks);
  let nextChunk = 0;
  let failure = null;
  const worker = async () => {
    while (!failure) {
      const index = nextChunk++;
      if (index >= totalChunks) return;
      const start = index * chunkFrames;
      const end = Math.min(totalFrames, start + chunkFrames);
      const chunk = await blobToDataUrl(wavChunk(audio, sampleRate, start, end));
      if (!chunk) {
        failure = { reason: 'encode', detail: '第 ' + (index + 1) + ' 段编码失败' };
        return;
      }
      const one = await transcribeAudioFile(chunk, endpoint, key, model);
      if (!one.ok) {
        failure = { reason: 'asr', detail: '第 ' + (index + 1) + '/' + totalChunks + ' 段：' + (one.detail || one.reason || '转写失败') };
        return;
      }
      parts[index] = one.text;
    }
  };
  // Two in-flight chunks keep the ASR endpoint busy without flooding it.  The
  // old sequential loop made a 36-minute video wait for every 5-minute upload
  // one after another even when the provider accepted concurrent requests.
  const concurrency = Math.min(2, totalChunks);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (failure) return { ok: false, reason: failure.reason, detail: failure.detail };
  return { ok: true, text: parts.join('\n'), chunks: totalChunks, duration: audio.duration };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'ldp-offscreen' || message.type !== 'transcribe') return false;
  transcribeRemote(message.request || {}).then(sendResponse, error => {
    sendResponse({ ok: false, reason: 'exception', detail: error && error.message ? error.message : String(error) });
  });
  return true;
});
