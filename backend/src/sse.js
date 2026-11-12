// Server-sent events: pushes alerts, reports, ledger writes and clock ticks to
// both client apps without polling — on a long-running server (local `npm start`).
//
// A serverless function cannot hold a stream open or share memory across
// instances, so on Vercel /events answers 204. A 204 makes EventSource close
// for good, and the web client falls back to polling (web/src/shared/api.js).
import { config } from './config.js';

const clients = new Set();

export function sseHandler(req, res) {
  if (config.realtime !== 'sse') return res.status(204).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}

export function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
