import type { AllowList } from './spec.js';

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
    args: {
      channel: { type: 'channel-ref', required: true },
      user: { type: 'user-ref', required: true },
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
};

/** Registry of per-clone allow-lists. Add stripe/linear/... as clones go live. */
export const ALLOWLISTS: Record<string, AllowList> = {
  slack: SLACK_ALLOWLIST,
};
