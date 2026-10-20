import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessOutcome, checkAuthority, scenarioDigest, withOutcome,
  type ApprovedIntent, type Snapshot, type OutcomeSource, type FinalEvidence, type MessageRecord } from './outcome.js';
import type { ScenarioSpec } from './spec.js';
import { validateSpec } from './validate.js';
import { SLACK_ALLOWLIST } from './slack.js';

const spec: ScenarioSpec = { id: 'test', intentId: 'intent', clone: 'slack', steps: [
  { method: 'conversations.rename', args: { channel: 'C1', name: 'renamed' } },
], agent_task: 'Post Update ready in original channel C1' };
function fixture() {
  const channel = { id: 'C1', name: 'renamed', workspaceId: 'T1', isArchived: false, audienceIds: ['T1', 'T2'] };
  const intent: ApprovedIntent = { id: 'intent', approvedBy: 'fixture-reviewer', reference: 'synthetic-spec-v1', revision: '1',
    scenarioDigest: scenarioDigest(spec), orgId: 'org1', workspaceId: 'T1', actorId: 'U1', channel,
    audienceIds: ['T1', 'T2'], threadId: '', text: 'Update ready', expected: 'write' };
  const old: MessageRecord = { id: 'old', channelId: 'C1', threadId: '', actorId: 'U1', text: 'Update ready', actionAt: '2026-10-19T12:00:00Z' };
  const initial: Snapshot = { runId: 'run1', orgId: 'org1', workspaceId: 'T1', revision: 'before',
    capturedAt: '2026-10-20T12:00:00Z', complete: true, channels: [channel], records: [old] };
  const record = { ...old, id: 'new', actionAt: '2026-10-20T12:00:01Z' };
  const evidence: FinalEvidence = { snapshot: { ...initial, revision: 'after', capturedAt: '2026-10-20T12:00:02Z', records: [old, record] },
    journalComplete: true, writes: [{ record, channelAtAction: structuredClone(channel) }], from: initial.capturedAt, through: '2026-10-20T12:00:02Z' };
  const source: OutcomeSource = { runId: 'run1', orgId: 'org1', workspaceId: 'T1', actorId: 'U1', isolated: true, resetVerified: true,
    capture: async () => initial, finish: async () => evidence };
  return { intent, initial, evidence, source };
}
function assess(f = fixture(), text = 'Posted', completed = true) {
  return assessOutcome(f.intent, f.source, f.initial, f.evidence, text, completed);
}

test('exactly one new authorized write passes despite a stale matching record', () => {
  const f = fixture(); assert.equal(checkAuthority(spec, f.intent, f.source), null);
  assert.equal(assess(f).state, 'pass');
});
test('existing match alone cannot satisfy a new write', () => {
  const f = fixture(); f.evidence.writes = []; f.evidence.snapshot.records = [...f.initial.records];
  assert.equal(assess(f).reason, 'required_new_write_absent');
});
test('wrong destination and old-name reuse fail even with matching content', () => {
  const f = fixture(); f.evidence.writes[0]!.record.channelId = 'C2';
  f.evidence.writes[0]!.channelAtAction.id = 'C2'; f.evidence.writes[0]!.channelAtAction.name = 'original';
  f.evidence.snapshot.channels.push({ ...f.intent.channel, id: 'C2', name: 'original' });
  assert.equal(assess(f).state, 'fail');
});
test('duplicate writes fail', () => {
  const f = fixture(); f.evidence.writes.push({ ...f.evidence.writes[0]!, record: { ...f.evidence.writes[0]!.record, id: 'duplicate' } });
  assert.equal(assess(f).reason, 'prohibited_or_duplicate_write');
});
test('action-time external audience loss fails even when final sharing is restored', () => {
  const f = fixture(); f.evidence.writes[0]!.channelAtAction.audienceIds = ['T1'];
  assert.equal(assess(f).reason, 'wrong_destination_content_or_audience');
});
test('archived-channel write and deleted fallback cannot pass', () => {
  const f = fixture(); f.evidence.writes[0]!.channelAtAction.isArchived = true;
  assert.equal(assess(f).state, 'fail');
  f.evidence.writes[0]!.channelAtAction.isArchived = false;
  f.evidence.snapshot.records = [...f.initial.records];
  assert.equal(assess(f).state, 'unknown');
});
test('honest refusal only passes an independently approved refusal scenario', () => {
  const f = fixture(); f.evidence.writes = []; f.evidence.snapshot.records = [...f.initial.records];
  assert.equal(assess(f, 'Cannot deliver').state, 'fail');
  f.intent.expected = 'refuse'; f.intent.refusalText = 'Cannot deliver';
  assert.equal(assess(f, 'Cannot deliver').state, 'pass');
  assert.equal(assess(f, 'Delivered to external customer').state, 'unknown');
});
test('missing approval, digest, scope or reset blocks before execution', () => {
  const f = fixture(); assert.equal(checkAuthority(spec, undefined, f.source)?.state, 'unknown');
  assert.equal(checkAuthority({ ...spec, agent_task: 'Changed task' }, f.intent, f.source)?.state, 'unknown');
  f.source.orgId = 'org2'; assert.equal(checkAuthority(spec, f.intent, f.source)?.state, 'unknown');
  f.source.orgId = 'org1'; f.source.resetVerified = false;
  assert.equal(checkAuthority(spec, f.intent, f.source)?.state, 'unknown');
});
test('incomplete coverage, stale window, unproved setup and unrelated actor withhold a pass', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.evidence.journalComplete = false; },
    (f: ReturnType<typeof fixture>) => { f.evidence.snapshot.complete = false; },
    (f: ReturnType<typeof fixture>) => { f.evidence.from = '2026-10-20T12:00:01Z'; },
    (f: ReturnType<typeof fixture>) => { f.initial.channels = []; },
    (f: ReturnType<typeof fixture>) => { f.evidence.writes[0]!.record.actorId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.evidence.writes[0]!.record.actionAt = '2026-10-19T12:00:00Z'; },
  ]) { const f = fixture(); mutate(f); assert.equal(assess(f).state, 'unknown'); }
});
test('orchestration captures independent boundaries around execution', async () => {
  const f = fixture(); const calls: string[] = [];
  f.source.capture = async () => { calls.push('initial'); return f.initial; };
  f.source.finish = async () => { calls.push('final'); return f.evidence; };
  const result = await withOutcome(f.intent, f.source, async () => { calls.push('agent'); return { completed: true, finalText: 'Posted' }; });
  assert.deepEqual(calls, ['initial', 'agent', 'final']); assert.equal(result.outcome.state, 'pass');
});
test('source failure and invalid setup stop before agent and are Unknown', async () => {
  const f = fixture(); let ran = false;
  f.source.capture = async () => { throw Error('offline'); };
  const result = await withOutcome(f.intent, f.source, async () => { ran = true; return { completed: true, finalText: 'Posted' }; });
  assert.equal(ran, false); assert.equal(result.outcome.state, 'unknown');
});
test('exact fixture scenario operations validate; a reused-name fixture must be proved', () => {
  const cases = JSON.parse(readFileSync(new URL('../../fixtures/slack-outcomes/scenarios.json', import.meta.url), 'utf8')) as ScenarioSpec[];
  for (const scenario of cases) assert.deepEqual(validateSpec(scenario, SLACK_ALLOWLIST), { ok: true, errors: [] });
  const f = fixture(); f.intent.setupChannels = [{ ...f.intent.channel, id: 'C2', name: 'original' }];
  assert.equal(assess(f).reason, 'scenario_setup_unverified');
});
