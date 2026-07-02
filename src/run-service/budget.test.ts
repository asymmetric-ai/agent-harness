import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger, RateLimiter } from './budget.js';

const ledgerFile = join(tmpdir(), `asym-budget-test-${process.pid}.json`);
afterEach(() => {
  try {
    rmSync(ledgerFile);
  } catch {
    // ignore
  }
});

test('budget ledger records spend and computes remaining', () => {
  const l = new BudgetLedger(ledgerFile, 1000);
  assert.equal(l.remaining(), 1000);
  assert.equal(l.canRun(), true);
  l.record(400);
  assert.equal(l.spent(), 400);
  assert.equal(l.remaining(), 600);
  l.record(600);
  assert.equal(l.remaining(), 0);
  assert.equal(l.canRun(), false, 'cap reached → circuit open');
});

test('budget ledger persists across instances (survives restart)', () => {
  new BudgetLedger(ledgerFile, 1000).record(250);
  const fresh = new BudgetLedger(ledgerFile, 1000);
  assert.equal(fresh.spent(), 250);
});

test('rate limiter allows up to max then blocks within the window', () => {
  const rl = new RateLimiter(3, 60_000);
  assert.equal(rl.allow('1.2.3.4'), true);
  assert.equal(rl.allow('1.2.3.4'), true);
  assert.equal(rl.allow('1.2.3.4'), true);
  assert.equal(rl.allow('1.2.3.4'), false, '4th within window is blocked');
  assert.equal(rl.allow('5.6.7.8'), true, 'a different key is independent');
});
