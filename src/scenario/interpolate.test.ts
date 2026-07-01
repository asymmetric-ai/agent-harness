import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveValue, resolveArgs, type InterpContext } from './interpolate.js';

const ctx: InterpContext = {
  botUserId: 'U_BOT',
  adminUserId: 'U_ADMIN',
  stepResponses: [{ channel: { id: 'C123', name: '#incidents' } }],
};

test('literals pass through unchanged', () => {
  assert.equal(resolveValue('#incidents', ctx), '#incidents');
  assert.equal(resolveValue(true, ctx), true);
});

test('$bot and $admin resolve', () => {
  assert.equal(resolveValue('$bot', ctx), 'U_BOT');
  assert.equal(resolveValue('$admin', ctx), 'U_ADMIN');
});

test('$N.path digs into a prior step response', () => {
  assert.equal(resolveValue('$1.channel.id', ctx), 'C123');
  assert.equal(resolveValue('$1.channel.name', ctx), '#incidents');
});

test('out-of-range step throws loudly', () => {
  assert.throws(() => resolveValue('$2.channel.id', ctx), /step 2 has no response/);
});

test('missing path throws loudly (no silent undefined)', () => {
  assert.throws(() => resolveValue('$1.channel.topic', ctx), /resolved to undefined/);
});

test('resolveArgs resolves a whole arg map', () => {
  const out = resolveArgs({ channel: '$1.channel.id', user: '$bot', text: 'hi' }, ctx);
  assert.deepEqual(out, { channel: 'C123', user: 'U_BOT', text: 'hi' });
});
