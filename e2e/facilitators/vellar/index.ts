/**
 * External-facilitator proxy for the x402-foundation e2e suite.
 *
 * The suite starts every facilitator as a local process listening on a port it
 * assigns. To exercise a HOSTED facilitator instead, it needs something local
 * to start that forwards to the real service — hence this file. It adds no
 * behaviour: every request is relayed unchanged, so what the suite measures is
 * the deployed facilitator, not this shim.
 *
 * Target defaults to the live deployment; override with VELLAR_FACILITATOR_URL.
 */
import { createServer } from 'node:http';

const TARGET = (
  process.env.VELLAR_FACILITATOR_URL ?? 'https://vellar-facilitator.onrender.com'
).replace(/\/$/, '');
const PORT = Number(process.env.PORT ?? 4030);

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);

  try {
    const upstream = await fetch(TARGET + (req.url ?? '/'), {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    res.end(text);
  } catch (err) {
    // A 502 here means the hosted service was unreachable — distinguishable
    // from a facilitator-level refusal, which arrives as a real status code.
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy_upstream_failure', detail: String(err) }));
  }
}).listen(PORT, () => console.log(`vellar proxy -> ${TARGET} on :${PORT}`));
