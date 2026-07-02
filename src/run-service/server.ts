import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LocalClonePool } from './clone.js';
import { runScenario, type RunEvent, type ModelConfig } from './orchestrate.js';
import { BudgetLedger, RateLimiter } from './budget.js';
import type { ScenarioSpec } from '../scenario/spec.js';

/**
 * The playground run-service. GET / serves the page; POST /run streams a run over
 * SSE. Safety (T6): a per-IP rate limit, a per-run token cap + wall-clock timeout,
 * abort-on-disconnect (reaps the run + lease), and a budget circuit-breaker on the
 * shared (our-money) key — when the token cap is reached, live runs on the server
 * key degrade to a `budget_exhausted` event instead of spending more. BYO-key runs
 * skip the budget meter (the visitor pays) but still get rate limits + caps.
 */
const pool = new LocalClonePool();
const PORT = parseInt(process.env.PORT ?? '4000', 10);
const PAGE = fileURLToPath(new URL('../../web/index.html', import.meta.url));

const SERVER_KEY = process.env.ASYM_PLAYGROUND_KEY ?? '';
const SERVER_MODEL = process.env.ASYM_PLAYGROUND_MODEL ?? 'anthropic/claude-sonnet-4.5';
const SERVER_BASE_URL = process.env.ASYM_PLAYGROUND_BASE_URL ?? 'https://openrouter.ai/api/v1';
const BUDGET_TOKENS = Number(process.env.ASYM_PLAYGROUND_BUDGET_TOKENS) || 2_000_000;
const BUDGET_FILE = process.env.ASYM_PLAYGROUND_BUDGET_FILE ?? './.playground-budget.json';
const MAX_RUN_TOKENS = Number(process.env.ASYM_PLAYGROUND_MAX_RUN_TOKENS) || 40_000;
const RUN_TIMEOUT_MS = Number(process.env.ASYM_PLAYGROUND_RUN_TIMEOUT_MS) || 120_000;
const RATE_MAX = Number(process.env.ASYM_PLAYGROUND_RATE_MAX) || 5;
const RATE_WINDOW_MS = Number(process.env.ASYM_PLAYGROUND_RATE_WINDOW_MS) || 60_000;

const ledger = new BudgetLedger(BUDGET_FILE, BUDGET_TOKENS);
const limiter = new RateLimiter(RATE_MAX, RATE_WINDOW_MS);

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

function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const raw = (Array.isArray(fwd) ? fwd[0] : fwd) || req.socket.remoteAddress || 'unknown';
  return raw.split(',')[0]!.trim();
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
      res.end(JSON.stringify({ ok: true, budgetRemaining: ledger.remaining(), budgetCap: ledger.cap() }));
      return;
    }
    if (req.method === 'POST' && req.url === '/run') {
      const ip = clientIp(req);
      if (!limiter.allow(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end('{"error":"rate limited — slow down"}');
        return;
      }

      const body = await readJson(req);
      const spec = body.spec as ScenarioSpec | undefined;
      if (!spec || typeof spec !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"missing spec"}');
        return;
      }

      const usingServerKey = !body.modelKey;
      const apiKey = (body.modelKey as string) || SERVER_KEY; // in-memory only; never logged
      if (!apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"no model key (paste one, or set ASYM_PLAYGROUND_KEY)"}');
        return;
      }
      const model: ModelConfig = {
        apiKey,
        model: (body.model as string) || SERVER_MODEL,
        baseURL: (body.baseURL as string) || SERVER_BASE_URL,
        provider: (body.provider as 'anthropic' | 'openai') || 'openai',
      };

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (e: RunEvent) => {
        if (!res.writableEnded) {
          try {
            res.write(`data: ${JSON.stringify(e)}\n\n`);
          } catch {
            /* client gone */
          }
        }
      };

      // Budget circuit-breaker: only the shared key spends our money.
      if (usingServerKey && !ledger.canRun()) {
        send({
          kind: 'budget_exhausted',
          message: 'The demo budget is spent for now. Paste your own model key to run live, or watch a curated replay.',
        });
        res.end();
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
      req.on('close', () => controller.abort()); // reap on disconnect

      let runTokens = 0;
      let lease;
      try {
        lease = await pool.acquire(spec.clone);
        await runScenario(
          spec,
          lease,
          model,
          { maxSteps: Number(body.maxSteps) || 6, maxTokens: MAX_RUN_TOKENS, signal: controller.signal },
          (e) => {
            if (e.kind === 'done') runTokens = e.tokens;
            send(e);
          },
        );
      } catch (err) {
        send({ kind: 'setup_failed', error: (err as Error).message });
      } finally {
        clearTimeout(timer);
        if (usingServerKey && runTokens > 0) ledger.record(runTokens);
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
  console.error(
    `playground run-service on http://localhost:${PORT} ` +
      `(budget ${ledger.remaining()}/${ledger.cap()} tokens, rate ${RATE_MAX}/${RATE_WINDOW_MS}ms)`,
  );
});
