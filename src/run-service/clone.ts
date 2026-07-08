import type { McpLaunch } from '../mcp.js';
import { cloneCall } from '../scenario/cloneClient.js';

/**
 * A leased clone instance ready for one run: its REST base URL, admin + bot
 * tokens, the user ids scenarios interpolate ($admin/$bot), any extra provisioned
 * refs ($team, ...), and how to launch its MCP server as the actor. `release()`
 * recycles/destroys it — the pool decides how.
 */
export interface CloneLease {
  baseUrl: string;
  adminToken: string;
  botToken: string;
  botUserId: string;
  adminUserId: string;
  /** Extra provisioned refs beyond bot/admin (e.g. `{ team }` for Linear's $team). */
  refs?: Record<string, string>;
  mcpLaunch: McpLaunch;
  release(): Promise<void>;
}

export interface ClonePool {
  acquire(clone: string): Promise<CloneLease>;
}

/** A short unique-ish suffix for provisioned identities (dev pool, one per run). */
function uniq(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Dev/local pool: one already-running clone per template, provisioned per acquire.
 * NO recycle (release is a no-op) — this exists to build and test the run path on a
 * laptop. The production pool (warm containers + recycle-per-run) implements the
 * same interface and swaps in behind it.
 *
 * Config via env, per clone:
 *   slack:  SLACK_CLONE_URL, SLACK_MCP_CMD, SLACK_MCP_ARGS, SLACK_MCP_CWD, DATABASE_URL
 *   linear: LINEAR_CLONE_URL, LINEAR_MCP_CMD, LINEAR_MCP_ARGS, LINEAR_MCP_CWD
 */
export class LocalClonePool implements ClonePool {
  async acquire(clone: string): Promise<CloneLease> {
    if (clone === 'slack') return this.acquireSlack();
    if (clone === 'linear') return this.acquireLinear();
    throw new Error(`no local clone configured for "${clone}"`);
  }

  /** Slack: mint a bot+admin via `admin/provision`; the MCP reads Postgres directly. */
  private async acquireSlack(): Promise<CloneLease> {
    const baseUrl = process.env.SLACK_CLONE_URL ?? 'http://localhost:3001/api';

    let prov = await cloneCall(baseUrl, 'admin/provision', null, {});
    if (!prov.ok) prov = await cloneCall(baseUrl, 'admin/provision', null, { reprovision: true });
    if (!prov.ok) throw new Error(`slack provision failed: ${prov.error}`);

    const tokens = prov.body.tokens as { bot: string; user: string };
    const botUser = prov.body.botUser as { id: string };
    const adminUser = prov.body.adminUser as { id: string };

    return {
      baseUrl,
      adminToken: tokens.user,
      botToken: tokens.bot,
      botUserId: botUser.id,
      adminUserId: adminUser.id,
      refs: {},
      mcpLaunch: {
        command: process.env.SLACK_MCP_CMD ?? 'bun',
        args: (process.env.SLACK_MCP_ARGS ?? 'src/index.ts').split(' ').filter(Boolean),
        cwd: process.env.SLACK_MCP_CWD,
        env: { SLACK_MCP_TOKEN: tokens.bot, DATABASE_URL: process.env.DATABASE_URL ?? '' },
      },
      release: async () => {},
    };
  }

  /**
   * Linear: no `admin/provision` and no seed — bootstrap a workspace. signup an
   * admin, create an org, RE-LOGIN so the token carries org context (a fresh
   * signup JWT does not), then create a team. There is no bot concept, so the
   * agent acts as the admin principal. Exposes the team id as `$team`. The MCP
   * reaches the clone over HTTP (LINEAR_API_URL + LINEAR_API_KEY) — no DB port.
   */
  private async acquireLinear(): Promise<CloneLease> {
    const baseUrl = process.env.LINEAR_CLONE_URL ?? 'http://localhost:3003/api';
    const email = `admin-${uniq()}@asym.local`;
    const password = 'playground-pw-123';

    const signup = await cloneCall(baseUrl, 'auth/signup', null, {
      email,
      password,
      name: 'Playground Admin',
    });
    if (!signup.ok) throw new Error(`linear signup failed: ${signup.error}`);
    const userId = (signup.body.user as { id: string } | undefined)?.id;
    const signupToken = signup.body.accessToken as string | undefined;
    if (!userId || !signupToken) throw new Error('linear signup returned no user/token');

    const org = await cloneCall(baseUrl, 'organization', signupToken, { name: 'Asym Playground' });
    if (!org.ok) throw new Error(`linear org create failed: ${org.error}`);

    // Re-login: the org association isn't in the signup token.
    const login = await cloneCall(baseUrl, 'auth/login', null, { email, password });
    if (!login.ok) throw new Error(`linear re-login failed: ${login.error}`);
    const token = login.body.accessToken as string | undefined;
    if (!token) throw new Error('linear re-login returned no token');

    const team = await cloneCall(baseUrl, 'teams', token, { name: 'Playground', key: 'PLG' });
    if (!team.ok) throw new Error(`linear team create failed: ${team.error}`);
    const teamId = (team.body as { id?: string }).id;
    if (!teamId) throw new Error('linear team create returned no id');

    return {
      baseUrl,
      adminToken: token,
      botToken: token,
      botUserId: userId,
      adminUserId: userId,
      refs: { team: teamId },
      mcpLaunch: {
        command: process.env.LINEAR_MCP_CMD ?? 'bun',
        args: (process.env.LINEAR_MCP_ARGS ?? 'src/index.ts').split(' ').filter(Boolean),
        cwd: process.env.LINEAR_MCP_CWD,
        env: { LINEAR_API_URL: baseUrl, LINEAR_API_KEY: token },
      },
      release: async () => {},
    };
  }
}
