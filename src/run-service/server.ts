import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LocalClonePool } from './clone.js';
import { runScenario, type RunEvent, type ModelConfig } from './orchestrate.js';
import type { ScenarioSpec } from '../scenario/spec.js';

/**
 * The playground run-service: a small HTTP server that serves the page and
 * streams a run over SSE. POST /run { spec, modelKey?, model?, provider?, baseURL? }
 * → text/event-stream of RunEvents. Key handling: BYO from the request, else the
 * server's budgeted key from env (ASYM_PLAYGROUND_KEY). The key is used in-memory
 * for the run and never logged. Clone lifecycle is owned here: acquire per run,
 * release() in a finally (recycle) so a disconnect still cleans up.
 *
 * NOT here yet (T6): the budget circuit-breaker, per-IP rate limits, and full
 * abort-on-disconnect. This is the checkpoint server — correct, minimal, local.
 */
const pool = new LocalClonePool();
const PORT = parseInt(process.env.PORT ?? '4000', 10);
const PAGE = fileURLToPath(new URL('../../web/index.html', import.meta.url));

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = await readFile(PAGE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.method === 'POST' && req.url === '/run') {
      const body = await readJson(req);
      const spec = body.spec as ScenarioSpec | undefined;
      if (!spec || typeof spec !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"missing spec"}');
        return;
      }
      // BYO key, else the server's budgeted key. In-memory only; never logged.
      const apiKey = (body.modelKey as string) || process.env.ASYM_PLAYGROUND_KEY || '';
      if (!apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"no model key (paste one or set ASYM_PLAYGROUND_KEY)"}');
        return;
      }
      const model: ModelConfig = {
        apiKey,
        model: (body.model as string) || process.env.ASYM_PLAYGROUND_MODEL || 'anthropic/claude-sonnet-4.5',
        baseURL: (body.baseURL as string) || process.env.ASYM_PLAYGROUND_BASE_URL || 'https://openrouter.ai/api/v1',
        provider: (body.provider as 'anthropic' | 'openai') || 'openai',
      };

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (e: RunEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);

      let disconnected = false;
      req.on('close', () => {
        disconnected = true;
      });

      let lease;
      try {
        lease = await pool.acquire(spec.clone);
        await runScenario(spec, lease, model, { maxSteps: Number(body.maxSteps) || 6 }, (e) => {
          if (!disconnected) send(e);
        });
      } catch (err) {
        send({ kind: 'setup_failed', error: (err as Error).message });
      } finally {
        if (lease) await lease.release().catch(() => {});
        res.end();
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
});

server.listen(PORT, () => {
  console.error(`playground run-service on http://localhost:${PORT}`);
});
