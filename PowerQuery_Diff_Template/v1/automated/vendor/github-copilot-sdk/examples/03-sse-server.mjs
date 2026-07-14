// 03 — SSE streaming over HTTP (integration use case).
//
// A dependency-free node:http server that exposes:
//   GET /chat?prompt=...   → text/event-stream of `delta` events + final `message`
//   GET /usage             → JSON usage summary (tokens, tools, skills)
//
// Run:
//   node examples/03-sse-server.mjs [--cli-path ...] [--proxy ...] [--model <id>] [--token-budget <n>] ["default prompt"]
//   node examples/03-sse-server.mjs --model gpt-5-mini --effort low "What is 2 + 2?"
// Try:  curl -N 'localhost:3000/chat?prompt=Tell+me+a+short+joke'
//       curl -s localhost:3000/usage | jq

import http from 'node:http';
import { createHarness, formatSSE } from '../src/index.mjs';
import { parseCommonArgs, baseConfig } from './_shared.mjs';

const args = parseCommonArgs();
const PORT = Number(process.env.PORT) || 3000;
const harness = await createHarness({ config: baseConfig(args, { streaming: true }) });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/usage') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(harness.usageSummary(), null, 2));
    return;
  }

  if (url.pathname === '/chat') {
    // No built-in default: an empty `?prompt=` (or none) yields an empty message,
    // which the SDK rejects (EmptyPromptError) — surfaced below as an SSE `error`
    // event instead of silently answering filler. Pass ?prompt=... to chat.
    const prompt = url.searchParams.get('prompt') ?? args._[0] ?? '';
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    let id = 0;
    try {
      for await (const item of harness.stream(prompt)) {
        res.write(formatSSE({ id: ++id, event: item.type, data: item }));
      }
    } catch (err) {
      res.write(formatSSE({ event: 'error', data: { message: String(err?.message ?? err) } }));
    }
    res.end();
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`SSE server on :${PORT} — curl -N 'localhost:${PORT}/chat?prompt=hi'`);
});

const shutdown = async (code) => {
  server.close();
  await harness.stop().catch(() => {});
  process.exit(code);
};
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
