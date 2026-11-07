'use strict';
const http = require('http');
const port = Number(process.argv[2] || 8768);
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    if (req.method === 'GET' && /\/models\/?$/.test(req.url || '')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
      return;
    }
    if (/\/audio\/transcriptions\/?$/.test(req.url || '')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: '这是语音转写测试文本。' }));
      return;
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 50507, message: 'Request failed:Unknown error.', data: null }));
  });
});
server.listen(port, '127.0.0.1', () => console.log('media fail mock listening on', port));
