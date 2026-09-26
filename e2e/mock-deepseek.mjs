// Local mock DeepSeek provider used only by the review E2E projects so CI
// can exercise the real server adapter, config, fingerprint guards, and UI
// without any real API key. A test arms a single 429 response via
// GET /__arm429 (then the next chat completion fails once and the flag
// resets); by default every chat completion succeeds after a short delay so
// project run order never matters. No keys, no data leaving the machine.
import http from 'node:http';

let arm429 = false;

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  if (request.method === 'GET' && request.url === '/__arm429') {
    arm429 = true;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('armed');
    return;
  }
  if (request.method === 'POST' && request.url === '/chat/completions') {
    request.resume();
    request.on('end', () => {
      const respond = () => {
        if (arm429) {
          arm429 = false;
          response.writeHead(429, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'mock rate limited' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            model: 'simulated-model',
            choices: [
              { message: { content: '模拟回顾：近四周训练量稳定，建议保持当前节奏并注意睡眠。' } },
            ],
          }),
        );
      };
      setTimeout(respond, 600);
    });
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(3117, '127.0.0.1');
