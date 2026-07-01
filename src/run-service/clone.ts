import type { McpLaunch } from '../mcp.js';
import { cloneCall } from '../scenario/cloneClient.js';

/**
 * A leased clone instance ready for one run: its REST base URL, admin + bot
 * tokens, the user ids scenarios interpolate ($admin/$bot), and how to launch its
 * MCP server as the bot. `release()` recycles/destroys it — the pool decides how.
 */
export interface CloneLease {
  baseUrl: string;
  adminToken: string;
  botToken: string;
  botUserId: string;
  adminUserId: string;
  mcpLaunch: McpLaunch;
  release(): Promise<void>;
}

export interface ClonePool {
  acquire(clone: string): Promise<CloneLease>;
}

/**
 * Dev/local pool: one already-running clone, provisioned per acquire. NO recycle
 * (release is a no-op) — this exists to build and test the run path end-to-end on
 * a laptop. The production pool (warm containers + recycle-per-run, per the eng
 * plan) implements the same interface and swaps in behind it.
 *
 * Config via env: SLACK_CLONE_URL, SLACK_MCP_CMD, SLACK_MCP_ARGS, SLACK_MCP_CWD,
 * DATABASE_URL. The closed clone provides the MCP launch command; the public
 * run-service only runs what it's told (keeps the closed/open boundary clean).
 */
export class LocalClonePool implements ClonePool {
  async acquire(clone: string): Promise<CloneLease> {
    if (clone !== 'slack') throw new Error(`no local clone configured for "${clone}"`);
    const baseUrl = process.env.SLACK_CLONE_URL ?? 'http://localhost:3001/api';

    let prov = await cloneCall(baseUrl, 'admin/provision', null, {});
    if (!prov.ok) prov = await cloneCall(baseUrl, 'admin/provision', null, { reprovision: true });
    if (!prov.ok) throw new Error(`clone provision failed: ${prov.error}`);

    const tokens = prov.body.tokens as { bot: string; user: string };
    const botUser = prov.body.botUser as { id: string };
    const adminUser = prov.body.adminUser as { id: string };

    return {
      baseUrl,
      adminToken: tokens.user,
      botToken: tokens.bot,
      botUserId: botUser.id,
      adminUserId: adminUser.id,
      mcpLaunch: {
        command: process.env.SLACK_MCP_CMD ?? 'bun',
        args: (process.env.SLACK_MCP_ARGS ?? 'src/index.ts').split(' ').filter(Boolean),
        cwd: process.env.SLACK_MCP_CWD,
        env: { SLACK_MCP_TOKEN: tokens.bot, DATABASE_URL: process.env.DATABASE_URL ?? '' },
      },
      release: async () => {},
    };
  }
}
