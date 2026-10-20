import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishAfterRelease } from './publication.js';
import { runScenario, type RunEvent } from './orchestrate.js';
import type { CloneLease } from './clone.js';
const pass: RunEvent = { kind: 'outcome', outcome: { state: 'pass', reason: 'verified', evidenceRefs: ['before', 'after'] } };

test('a passing outcome cannot be published until release verifies cleanup', async () => {
  const emitted: RunEvent[] = [];
  let finish!: () => void;
  const released = new Promise<void>(resolve => { finish = resolve; });
  const running = publishAfterRelease(() => released, async emit => { emit(pass); }, event => emitted.push(event));
  await Promise.resolve();
  assert.deepEqual(emitted, []);
  finish(); await running;
  assert.deepEqual(emitted, [pass]);
});
test('reset rejection replaces an otherwise passing outcome with Unknown', async () => {
  const emitted: RunEvent[] = [];
  await publishAfterRelease(async () => { throw Error('reset failed'); }, async emit => { emit(pass); }, event => emitted.push(event));
  assert.deepEqual(emitted, [{ kind: 'outcome', outcome: { state: 'unknown', reason: 'clone_reset_failed', evidenceRefs: [] } }]);
});
test('execution failure still releases the lease and cannot publish a pass', async () => {
  let released = false; const emitted: RunEvent[] = [];
  await assert.rejects(publishAfterRelease(async () => { released = true; }, async emit => {
    emit(pass); throw Error('execution failed');
  }, event => emitted.push(event)), /execution failed/);
  assert.equal(released, true); assert.deepEqual(emitted, []);
});
test('full scenario path refuses missing independent authority before any MCP/model launch', async () => {
  const emitted: RunEvent[] = [];
  const lease: CloneLease = { baseUrl: 'http://127.0.0.1:1', adminToken: 'fixture', botToken: 'fixture', botUserId: 'B', adminUserId: 'A',
    mcpLaunch: { command: 'must-never-launch', args: [] }, release: async () => {} };
  await runScenario({ id: 'missing-authority', clone: 'slack', intentId: 'unapproved', agent_task: 'Post update',
    steps: [{ method: 'conversations.create', args: { name: 'test' } }] }, lease,
  { provider: 'openai', apiKey: 'fixture', model: 'fixture', baseURL: 'http://127.0.0.1:1' }, {}, event => emitted.push(event));
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], { kind: 'outcome', outcome: { state: 'unknown', reason: 'independent_intent_unapproved', intentId: undefined, evidenceRefs: [] } });
});
