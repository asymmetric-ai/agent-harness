import type { AllowList } from './spec.js';

/**
 * Linear clone allow-list: the RPC methods a scenario may call during setup, with
 * their REST transport (verb + templated path) and arg schemas. Unlike Slack's
 * flat POST-per-method surface, Linear is RESTful — resources, verbs, and path
 * params — so each method carries its `verb`/`path`. `:param` segments are filled
 * from the arg of the same name (which may be an interpolation token like `$team`
 * or `$1.id`). Mirrors Linear's public REST shape, so publishing it leaks nothing.
 *
 * Provisioning (signup → org → team) is done by the pool and exposed as `$team`;
 * scenarios don't bootstrap the workspace themselves.
 */
export const LINEAR_ALLOWLIST: AllowList = {
  'issues.create': {
    verb: 'POST',
    path: 'issues',
    args: {
      title: { type: 'string', required: true },
      teamId: { type: 'string', required: true }, // usually $team
      description: { type: 'string' },
    },
  },
  'issues.update': {
    verb: 'PUT', // the clone's update route is PUT /issues/:id (not PATCH)
    path: 'issues/:id',
    args: {
      id: { type: 'string', required: true },
      title: { type: 'string' },
      description: { type: 'string' },
    },
  },
  'issues.delete': {
    // Note: a bare issue delete is soft — the row stays readable and writable, so
    // it does NOT produce drift on its own. Deleting the *team* does (see below).
    verb: 'DELETE',
    path: 'issues/:id',
    args: {
      id: { type: 'string', required: true },
    },
  },
  'teams.delete': {
    // Cascades: deleting a team removes its issues (GET/PUT then 404). This is the
    // drift the agent hits — an issue that vanished with its team.
    verb: 'DELETE',
    path: 'teams/:id',
    args: {
      id: { type: 'string', required: true },
    },
  },
  'issues.assign': {
    verb: 'POST',
    path: 'issues/:id/assign',
    args: {
      id: { type: 'string', required: true },
      assigneeId: { type: 'user-ref', required: true },
    },
  },
  'comments.create': {
    verb: 'POST',
    path: 'issues/:issueId/comments',
    args: {
      issueId: { type: 'string', required: true },
      body: { type: 'string', required: true },
    },
  },
};
