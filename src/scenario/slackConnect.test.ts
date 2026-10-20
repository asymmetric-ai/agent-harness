import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { validateSpec } from './validate.js';
import { SLACK_ALLOWLIST } from './slack.js';
import { resolveArgs } from './interpolate.js';
import { runScenarioSetup } from './runner.js';
import type { ScenarioSpec } from './spec.js';

const spec: ScenarioSpec = {
  id: 'connect-lost', clone: 'slack',
  steps: [{ method: 'admin.conversations.disconnectShared',
    args: { channel_id: 'C1', leaving_team_ids: ['T_EXTERNAL'] } }],
  agent_task: 'Notify external workspace T_EXTERNAL in C1 only if it is still connected.',
};
const connected = { id: 'C1', context_team_id: 'T_HOME', is_ext_shared: true,
  shared_team_ids: ['T_HOME', 'T_EXTERNAL'] };
const disconnected = { ...connected, is_ext_shared: false, shared_team_ids: ['T_HOME'] };

async function fixture(
  answers: Array<unknown>,
  use: (baseUrl: string, calls: Array<{ path: string; body: unknown; auth: string | undefined }>) => Promise<void>,
) {
  const calls: Array<{ path: string; body: unknown; auth: string | undefined }> = [];
  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url ?? '', body: JSON.parse(raw || '{}'), auth: req.headers.authorization });
    const answer = answers.shift() ?? { ok: false, error: 'unexpected_call' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
function setup(baseUrl: string, scenario = spec) {
  return runScenarioSetup(scenario, { baseUrl, adminToken: 'fixture-admin',
    botUserId: 'U_BOT', adminUserId: 'U_ADMIN', allow: SLACK_ALLOWLIST });
}

test('Connect allows one explicit external workspace and rejects malformed targets', () => {
  assert.equal(validateSpec(spec, SLACK_ALLOWLIST).ok, true);
  for (const target of [undefined, null, '', 'T_EXTERNAL', [], [''], [1], ['T1', 'T2'], ['$evil()'], [['T1']]]) {
    const args: Record<string, unknown> = { channel_id: 'C1' };
    if (target !== undefined) args.leaving_team_ids = target;
    assert.equal(validateSpec({ ...spec, steps: [{ ...spec.steps[0]!, args }] }, SLACK_ALLOWLIST).ok, false);
  }
  for (const channel of [null, 1, [], '', ' ']) {
    assert.equal(validateSpec({ ...spec, steps: [{ method: spec.steps[0]!.method,
      args: { channel_id: channel, leaving_team_ids: ['T_EXTERNAL'] } }] }, SLACK_ALLOWLIST).ok, false);
  }
});

test('workspace IDs inside arrays resolve against prior fixture responses', () => {
  assert.deepEqual(resolveArgs({ leaving_team_ids: ['$1.external.id'] }, {
    botUserId: 'B', adminUserId: 'A', stepResponses: [{ external: { id: 'T_EXTERNAL' } }],
  }), { leaving_team_ids: ['T_EXTERNAL'] });
  assert.throws(() => resolveArgs({ leaving_team_ids: ['$2.external.id'] }, {
    botUserId: 'B', adminUserId: 'A', stepResponses: [],
  }), /has no response/);
});

test('verified two-team Connect disconnection retains audience and readback evidence', async () => {
  await fixture([{ ok: true, channel: connected }, { ok: true }, { ok: true, channel: disconnected }], async (url, calls) => {
    const result = await setup(url);
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((call) => call.path), ['/conversations.info', '/admin.conversations.disconnectShared', '/conversations.info']);
    assert.deepEqual(calls[1]!.body, spec.steps[0]!.args);
    assert.ok(calls.every((call) => call.auth === 'Bearer fixture-admin'));
    const evidence = result.responses[0]!.connect_transition as Record<string, unknown>;
    assert.equal(evidence.channel_id, 'C1');
    assert.equal(evidence.disconnected_team_id, 'T_EXTERNAL');
    assert.deepEqual(evidence.after, { is_ext_shared: false, shared_team_ids: ['T_HOME'] });
  });
});

test('unsupported info or ambiguous initial sharing stops before mutation', async () => {
  for (const answer of [
    { ok: false, error: 'unknown_method' },
    { ok: true, channel: disconnected },
    { ok: true, channel: { ...connected, id: 'C_OTHER' } },
    { ok: true, channel: { ...connected, context_team_id: 'T_EXTERNAL' } },
    { ok: true, channel: { ...connected, shared_team_ids: ['T_HOME', 'T_EXTERNAL', 'T_OTHER'] } },
    { ok: true, channel: { id: 'C1', is_ext_shared: true } },
  ]) {
    await fixture([answer], async (url, calls) => {
      const result = await setup(url);
      assert.equal(result.ok, false);
      assert.equal(result.steps[0]!.error, 'connect_fixture_unverified');
      assert.equal(calls.length, 1);
    });
  }
});

test('backend rejection stops setup and preserves the provider reason', async () => {
  await fixture([{ ok: true, channel: connected }, { ok: false, error: 'unknown_method' }], async (url, calls) => {
    const result = await setup(url);
    assert.equal(result.ok, false);
    assert.equal(result.steps[0]!.error, 'unknown_method');
    assert.equal(calls.length, 2);
  });
});

test('acknowledged no-op, missing readback or wrong final channel cannot pass setup', async () => {
  for (const answer of [
    { ok: true, channel: connected },
    { ok: false, error: 'channel_not_found' },
    { ok: true, channel: { ...disconnected, id: 'C_OTHER' } },
    { ok: true, channel: { ...disconnected, shared_team_ids: [] } },
    { ok: true, channel: { ...disconnected, context_team_id: 'T_OTHER' } },
  ]) {
    await fixture([{ ok: true, channel: connected }, { ok: true }, answer], async (url) => {
      const result = await setup(url);
      assert.equal(result.ok, false);
      assert.equal(result.steps[0]!.error, 'connect_transition_unverified');
    });
  }
});

test('failed transition stops later setup writes', async () => {
  await fixture([{ ok: true, channel: connected }, { ok: true }, { ok: true, channel: connected }], async (url, calls) => {
    const result = await setup(url, { ...spec, steps: [...spec.steps,
      { method: 'chat.postMessage', args: { channel: 'C_FALLBACK', text: 'must never execute' } }] });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.path !== '/chat.postMessage'));
  });
});
