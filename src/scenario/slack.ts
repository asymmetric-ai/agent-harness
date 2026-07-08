import type { AllowList } from './spec.js';
import { LINEAR_ALLOWLIST } from './linear.js';

/**
 * Slack clone allow-list: the only RPC methods a scenario may call, with their
 * arg schemas. Mirrors the real Slack Web API surface (public knowledge), so
 * publishing it leaks no implementation fidelity. Keep this the single source of
 * truth for what paste-your-own can do against the Slack clone.
 */
export const SLACK_ALLOWLIST: AllowList = {
  'conversations.create': {
    args: {
      name: { type: 'string', required: true },
      is_private: { type: 'boolean' },
    },
  },
  'conversations.invite': {
    // Slack invite takes `users` (a user id or comma-separated list), not `user`.
    args: {
      channel: { type: 'channel-ref', required: true },
      users: { type: 'user-ref', required: true },
    },
  },
  'conversations.kick': {
    args: {
      channel: { type: 'channel-ref', required: true },
      user: { type: 'user-ref', required: true },
    },
  },
  'chat.postMessage': {
    args: {
      channel: { type: 'channel-ref', required: true },
      text: { type: 'string', required: true },
    },
  },
  // ---- richer drift: mutate state the agent is later asked to act on ----
  'conversations.archive': {
    // Archive a channel → later posts fail with `is_archived` (distinct from eviction).
    args: {
      channel: { type: 'channel-ref', required: true },
    },
  },
  'conversations.rename': {
    args: {
      channel: { type: 'channel-ref', required: true },
      name: { type: 'string', required: true },
    },
  },
  'chat.delete': {
    // Delete a message → later references to its `ts` fail with `message_not_found`.
    args: {
      channel: { type: 'channel-ref', required: true },
      ts: { type: 'string', required: true },
    },
  },
};

/** Registry of per-clone allow-lists. Add stripe/notion/... as clones go live. */
export const ALLOWLISTS: Record<string, AllowList> = {
  slack: SLACK_ALLOWLIST,
  linear: LINEAR_ALLOWLIST,
};
