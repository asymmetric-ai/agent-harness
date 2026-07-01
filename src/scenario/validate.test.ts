import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from './validate.js';
import { SLACK_ALLOWLIST } from './slack.js';
import type { ScenarioSpec } from './spec.js';

const evictionSpec: ScenarioSpec = {
  id: 'bot-evicted-private-channel',
  clone: 'slack',
  seed: 'acme-corp',
  steps: [
    { method: 'conversations.create', args: { name: '#incidents', is_private: true } },
    { method: 'conversations.invite', args: { channel: '$1.channel.id', users: '$bot' } },
    { method: 'conversations.kick', args: { channel: '$1.channel.id', user: '$bot' } },
  ],
  agent_task: 'Post a standup summary to #incidents.',
};

test('the eviction spec validates', () => {
  const r = validateSpec(evictionSpec, SLACK_ALLOWLIST);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('unknown method is rejected', () => {
  const r = validateSpec(
    { ...evictionSpec, steps: [{ method: 'admin.deleteWorkspace', args: {} }] },
    SLACK_ALLOWLIST,
  );
  assert.equal(r.ok, false);
  assert.match(r.errors[0]!.message, /method not allowed/);
});

test('over the step cap is rejected', () => {
  const many = Array.from({ length: 13 }, () => ({
    method: 'chat.postMessage',
    args: { channel: '$1.channel.id', text: 'x' },
  }));
  const r = validateSpec({ ...evictionSpec, steps: many }, SLACK_ALLOWLIST);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /too many steps/.test(e.message)));
});

test('missing required arg is rejected', () => {
  const r = validateSpec(
    { ...evictionSpec, steps: [{ method: 'conversations.create', args: {} }] },
    SLACK_ALLOWLIST,
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /missing required arg: name/.test(e.message)));
});

test('unknown arg is rejected', () => {
  const r = validateSpec(
    { ...evictionSpec, steps: [{ method: 'conversations.create', args: { name: 'x', color: 'red' } }] },
    SLACK_ALLOWLIST,
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown arg: color/.test(e.message)));
});

test('bad interpolation token is rejected', () => {
  const r = validateSpec(
    { ...evictionSpec, steps: [{ method: 'conversations.invite', args: { channel: '$evil(1)', user: '$bot' } }] },
    SLACK_ALLOWLIST,
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /bad interpolation token/.test(e.message)));
});

test('over-long agent_task is rejected', () => {
  const r = validateSpec({ ...evictionSpec, agent_task: 'x'.repeat(501) }, SLACK_ALLOWLIST);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /agent_task too long/.test(e.message)));
});
