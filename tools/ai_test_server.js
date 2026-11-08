'use strict';
const http = require('http');
const port = Number(process.argv[2] || 8767);
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
    if (req.method === 'GET' && /\/models\/?$/.test(req.url || '')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }));
      return;
    }
    if (req.method === 'POST' && /\/audio\/transcriptions\/?/.test(req.url || '')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ text: '这是来自音频链路的测试字幕。\n它应该能够生成可下载的 SRT 文件。' }));
      return;
    }
    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      const parts = [
        '**MOCK_AI_OK**\n\n',
        '| 指标 | 数值 | 说明 |\n',
        '|:---|---:|:--:|\n',
        '| 时长 | 12:30 | 中 |\n',
        '| 大小 | 42MB | 右 |\n\n',
        '- 第一项\n',
        '- [x] 已完成任务\n',
        '- [ ] 未完成任务\n\n',
        '![示意图](https://example.com/demo.png)\n\n',
        '`code` 和 [链接](https://example.com)。'
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= parts.length) {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const payload = { choices: [{ delta: { content: parts[i] } }] };
        res.write('data: ' + JSON.stringify(payload) + '\n\n');
        i += 1;
      }, 180);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: 'MOCK_AI_OK\n\n| 指标 | 数值 |\n|:---|---:|\n| 时长 | 12:30 |\n\n这是测试接口返回的摘要。'
        }
      }]
    }));
  });
});
server.listen(port, '127.0.0.1', () => console.log('AI mock listening on', port));
