import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The budget circuit-breaker for the shared (our-money) key. A persistent token
 * ledger with a hard cap: when spend reaches the cap, canRun() goes false and the
 * server degrades live runs to instant-replay / BYO-key instead of spending more.
 * File-backed so a restart doesn't reset the meter. BYO-key runs are NOT recorded
 * here (the visitor pays for those).
 */
export class BudgetLedger {
  constructor(
    private readonly file: string,
    private readonly capTokens: number,
  ) {}

  private read(): { spentTokens: number } {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return { spentTokens: 0 };
    }
  }

  private write(state: { spentTokens: number }): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(state));
  }

  spent(): number {
    return this.read().spentTokens;
  }

  cap(): number {
    return this.capTokens;
  }

  remaining(): number {
    return Math.max(0, this.capTokens - this.spent());
  }

  canRun(): boolean {
    return this.remaining() > 0;
  }

  record(tokens: number): void {
    const s = this.read();
    s.spentTokens += Math.max(0, Math.floor(tokens));
    this.write(s);
  }
}

/**
 * In-memory per-key (usually per-IP) sliding-window rate limiter. Bounds how often
 * one visitor can trigger a live run on a public surface.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
