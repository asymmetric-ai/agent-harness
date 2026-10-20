import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runScenarioSetup } from './runner.js';
import { SLACK_ALLOWLIST } from './slack.js';

for (const method of ['conversations.rename', 'conversations.archive']) {
  for (const noOp of [false, true]) test(`${method} ${noOp ? 'no-op fails' : 'requires observed transition'}`, async () => {
    const before = { id: 'C1', name: 'original', is_archived: false };
    const after = noOp ? before : { ...before, name: method.endsWith('rename') ? 'renamed' : before.name,
      is_archived: method.endsWith('archive') };
    const answers = [{ ok: true, channel: before }, { ok: true }, { ok: true, channel: after }];
    const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answers.shift())); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await runScenarioSetup({ id: 'test', clone: 'slack', agent_task: 'test', steps: [
        { method, args: { channel: 'C1', ...(method.endsWith('rename') ? { name: 'renamed' } : {}) } },
      ] }, { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, adminToken: 'admin',
        botUserId: 'bot', adminUserId: 'admin', allow: SLACK_ALLOWLIST });
      assert.equal(result.ok, !noOp);
      if (noOp) assert.equal(result.steps[0]!.error, 'channel_transition_unverified');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
