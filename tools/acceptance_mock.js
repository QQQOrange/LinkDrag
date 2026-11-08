'use strict';
/**
 * Acceptance-test mock for LinkDrag.
 *
 * `/v1/chat/completions` streams a long structured Markdown answer slowly
 * (one chunk every `STREAM_DELAY` ms) so a test can interact with the page in
 * the middle of the stream and verify it never stalls.
 *
 * `/v1/audio/transcriptions` returns a fixed transcript.
 * `/v1/models` returns two models.
 */
const http = require('http');

const port = Number(process.argv[2] || 8767);
const STREAM_DELAY = Number(process.argv[3] || 260);

const CHUNKS = [
  '**MOCK_STREAM_OK**\n\n',
  '## 第一部分：问题从哪里来\n\n',
  '人们的痛苦常常来自一个内在审判者。\n\n',
  '## 第二部分：低容错率的代价\n\n',
  '| 维度 | 低容错 | 高容错 |\n',
  '|:---|:---:|---:|\n',
  '| 学习 | 回避 | 试错 |\n',
  '| 情绪 | 焦虑 | 稳定 |\n\n',
  '### 2.1 判错范围被放大\n\n',
  '错误的学习方法扩大了判错范围。\n\n',
  '## 第三部分：容错系统的做法\n\n',
  '- [x] 允许错误尽快出现\n',
  '- [ ] 把错误转化成分数\n\n',
  '## 结论\n\n',
  '真正的学习是反脆弱的。\n\n'
];

function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => resolve(raw));
  });
}

const server = http.createServer(async (req, res) => {
  const url = String(req.url || '');
  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }

  if (req.method === 'GET' && /\/models\/?$/.test(url)) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }));
    return;
  }

  if (req.method === 'POST' && /\/audio\/transcriptions\/?/.test(url)) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ text: '这是来自音频链路的测试字幕。\n它应该能够生成可下载的 SRT 文件。' }));
    return;
  }

  const action = String(body && body.messages ? '' : '');
  const isFollowup = /追问|followup/.test(JSON.stringify(body.messages || []).slice(0, 200000));
  void action;
  void isFollowup;

  if (body && body.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    // Ask the client to keep the connection open; the test asserts the stream
    // keeps producing chunks even while the page is being used.
    res.write(': keepalive\n\n');
    let i = 0;
    const timer = setInterval(() => {
      if (i >= CHUNKS.length) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const payload = { choices: [{ delta: { content: CHUNKS[i] } }] };
      res.write('data: ' + JSON.stringify(payload) + '\n\n');
      i += 1;
    }, STREAM_DELAY);
    req.on('close', () => clearInterval(timer));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    choices: [{
      message: {
        role: 'assistant',
        content: '**MOCK_AI_OK**\n\n## 第一部分：总结\n\n| 指标 | 数值 |\n|:---|---:|\n| 时长 | 12:30 |\n\n## 第二部分：要点\n\n- 要点一\n- 要点二\n\n## 第三部分：结论\n\n结论内容。'
      }
    }]
  }));
});

server.listen(port, '127.0.0.1', () => console.log('acceptance mock on', port, 'delay', STREAM_DELAY));
