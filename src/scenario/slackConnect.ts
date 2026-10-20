import { cloneCall, type CloneCallResult } from './cloneClient.js';

export const DISCONNECT_SHARED = 'admin.conversations.disconnectShared';

interface ConnectedChannel {
  id: string;
  context_team_id: string;
  is_ext_shared: boolean;
  shared_team_ids: string[];
}

function channelOf(result: CloneCallResult, id: string): ConnectedChannel | null {
  const channel = result.body.channel;
  if (!result.ok || !channel || typeof channel !== 'object') return null;
  const row = channel as Record<string, unknown>;
  if (row.id !== id || typeof row.context_team_id !== 'string' ||
      typeof row.is_ext_shared !== 'boolean' || !Array.isArray(row.shared_team_ids) ||
      !row.shared_team_ids.every((team) => typeof team === 'string')) return null;
  return row as unknown as ConnectedChannel;
}

const failure = (error: string): CloneCallResult => ({ ok: false, error, body: {} });

/**
 * This transition is deliberately narrow: a verified home + one external team
 * becomes a home-only channel. An acknowledgment alone cannot establish drift.
 * The backend must implement both methods; unsupported/partial fixtures fail
 * setup before any model run. These calls use the configured clone, never Slack.
 */
export async function disconnectSharedChannel(
  baseUrl: string,
  adminToken: string,
  args: Record<string, unknown>,
): Promise<CloneCallResult> {
  const id = args.channel_id;
  const leaving = args.leaving_team_ids;
  if (typeof id !== 'string' || !id.trim() || !Array.isArray(leaving) ||
      leaving.length !== 1 || typeof leaving[0] !== 'string' || !leaving[0].trim()) {
    return failure('connect_invalid_arguments');
  }
  const external = leaving[0];
  const before = channelOf(await cloneCall(baseUrl, 'conversations.info', adminToken, { channel: id }), id);
  if (!before || !before.is_ext_shared || before.context_team_id === external ||
      before.shared_team_ids.length !== 2 ||
      !before.shared_team_ids.includes(before.context_team_id) ||
      !before.shared_team_ids.includes(external)) {
    return failure('connect_fixture_unverified');
  }
  const changed = await cloneCall(baseUrl, DISCONNECT_SHARED, adminToken, args);
  if (!changed.ok) return changed;
  const after = channelOf(await cloneCall(baseUrl, 'conversations.info', adminToken, { channel: id }), id);
  if (!after || after.context_team_id !== before.context_team_id || after.is_ext_shared ||
      after.shared_team_ids.length !== 1 || after.shared_team_ids[0] !== before.context_team_id) {
    return failure('connect_transition_unverified');
  }
  return {
    ok: true,
    body: {
      ...changed.body,
      connect_transition: {
        channel_id: id,
        home_team_id: before.context_team_id,
        disconnected_team_id: external,
        before: { is_ext_shared: true, shared_team_ids: [...before.shared_team_ids] },
        after: { is_ext_shared: false, shared_team_ids: [...after.shared_team_ids] },
      },
    },
  };
}
