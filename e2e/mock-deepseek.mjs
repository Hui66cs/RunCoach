// Local mock DeepSeek provider used only by the review/coach E2E projects so
// CI can exercise the real server adapter, config, fingerprint guards, and UI
// without any real API key. A test arms a single 429 response via
// GET /__arm429 (then the next chat completion fails once and the flag
// resets); by default every chat completion succeeds after a short delay so
// project run order never matters. Plan-draft requests (detected by the
// deterministic prompt marker in the system message) receive a small draft
// JSON built from the requested 草稿区间. No keys, no data leaving the machine.
import http from 'node:http';

let arm429 = false;

const PLAN_DRAFT_MARKER = '计划草稿输出规则';

function buildDraftContent(body) {
  const userMessage = body.messages.find((m) => m.role === 'user')?.content ?? '';
  const match = /草稿区间：(\d{4}-\d{2}-\d{2}) 到 (\d{4}-\d{2}-\d{2})/.exec(userMessage);
  const start = match?.[1] ?? '';
  const secondDay = match?.[2] ?? '';
  if (start === '' || secondDay === '') {
    return '模拟回顾：近四周训练量稳定，建议保持当前节奏并注意睡眠。';
  }
  const draft = {
    items: [
      {
        scheduledLocalDate: start,
        workoutType: 'EASY_RUN',
        title: '模拟草稿：轻松跑',
        notes: null,
        targetDistanceMeters: 4000,
        targetDurationSeconds: 1500,
      },
      {
        scheduledLocalDate: secondDay,
        workoutType: 'STRENGTH',
        title: '模拟草稿：核心力量',
        notes: ' mock notes are not sent to real providers',
        targetDistanceMeters: null,
        targetDurationSeconds: 2700,
      },
    ],
  };
  return JSON.stringify(draft);
}

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
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      const respond = () => {
        if (arm429) {
          arm429 = false;
          response.writeHead(429, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'mock rate limited' } }));
          return;
        }
        let isDraft = false;
        try {
          const body = JSON.parse(raw);
          isDraft =
            Array.isArray(body.messages) &&
            (body.messages[0]?.content ?? '').includes(PLAN_DRAFT_MARKER);
        } catch {
          isDraft = false;
        }
        const content = isDraft
          ? buildDraftContent(JSON.parse(raw))
          : '模拟回顾：近四周训练量稳定，建议保持当前节奏并注意睡眠。';
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            model: 'simulated-model',
            choices: [{ message: { content } }],
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
