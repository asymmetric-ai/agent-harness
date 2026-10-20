import { cloneCall, type CloneCallResult } from './cloneClient.js';

/** Verify rename/archive against stable channel identity, not an RPC acknowledgment. */
export async function mutateChannelState(baseUrl: string, token: string, method: string,
  args: Record<string, unknown>): Promise<CloneCallResult> {
  const id = args.channel;
  const failure = (error: string): CloneCallResult => ({ ok: false, error, body: {} });
  if (typeof id !== 'string' || !id.trim()) return failure('channel_identity_required');
  const read = async () => {
    const result = await cloneCall(baseUrl, 'conversations.info', token, { channel: id });
    const c = result.body.channel as Record<string, unknown> | undefined;
    return result.ok && c?.id === id && typeof c.name === 'string' && typeof c.is_archived === 'boolean' ? c : null;
  };
  const before = await read();
  if (!before) return failure('channel_pre_state_unverified');
  if (method === 'conversations.archive' && before.is_archived) return failure('channel_already_archived');
  if (method === 'conversations.rename' && (typeof args.name !== 'string' || args.name === before.name))
    return failure('channel_rename_requires_new_name');
  const changed = await cloneCall(baseUrl, method, token, args);
  if (!changed.ok) return changed;
  const after = await read();
  if (!after || (method === 'conversations.archive'
    ? after.is_archived !== true || after.name !== before.name
    : after.name !== args.name || after.is_archived !== before.is_archived))
    return failure('channel_transition_unverified');
  return { ok: true, body: { ...changed.body, channel_transition: { before, after } } };
}
