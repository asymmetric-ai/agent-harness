import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AsymCliControl, type CloneControl } from './asym.js';
import { DatabaseOutcomeSource, baseline, requireSchema, sqlLiteral } from './audit.js';
import { sharingSql, startGateway } from './gateway.js';
import { cloneCall } from '../scenario/cloneClient.js';
import type { CloneLease, ClonePool } from '../run-service/clone.js';
import type { ScenarioSpec } from '../scenario/spec.js';
import type { ApprovedIntent } from '../scenario/outcome.js';

export interface RuntimeOptions {
  control?: CloneControl;
  orgId: string;
  /** CLI state is operator-owned; request bodies cannot select a registry. */
  home?: string;
  executable?: string;
  runtimeExecutable?: string;
}
/** Fresh clone per run; no reuse of a pre-existing user's clone or database. */
export class AsymOutcomePool implements ClonePool {
  private control: CloneControl;
  constructor(private options: RuntimeOptions) {
    if (!options.orgId.trim()) throw Error('outcome_org_required');
    this.control = options.control ?? new AsymCliControl(options.executable, options.home);
  }
  async acquire(clone: string, spec?: ScenarioSpec): Promise<CloneLease> {
    if (clone !== 'slack' || !spec?.intentId || !['isolated-outcome-fixture-v1', 'isolated-connect-fixture-v1'].includes(spec.seed ?? ''))
      throw Error('approved_outcome_fixture_required');
    const instance = await this.control.create();
    let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
    try {
      await requireSchema(this.control, instance.id);
      // Official spin provisions principals; establish the unprovisioned seeded
      // baseline first, then independently verify another reset against it.
      await this.control.reset(instance.id);
      const before = await baseline(this.control, instance.id);
      await this.control.reset(instance.id);
      if (await baseline(this.control, instance.id) !== before) throw Error('initial_reset_unverified');
      const clean = await this.control.query(instance.id, "SELECT to_regnamespace('harness_outcome') IS NULL AS clean");
      if (clean[0]?.clean !== true) throw Error('initial_audit_state_not_clean');
      const provision = await cloneCall(instance.apiUrl, 'admin/provision', null, {});
      const tokens = provision.body.tokens as {bot?: string; user?: string} | undefined;
      const botId = (provision.body.botUser as {id?: string} | undefined)?.id;
      const adminId = (provision.body.adminUser as {id?: string} | undefined)?.id;
      if (!provision.ok || !tokens?.bot || !tokens.user || !botId || !adminId) throw Error('fixture_principals_unverified');
      const workspaceId=(provision.body.workspace as {id?:string}|undefined)?.id;
      if(!workspaceId)throw Error('fixture_workspace_unverified');
      const actors=await this.control.query(instance.id,`SELECT id,workspace_id FROM users WHERE id IN (${sqlLiteral(botId)},${sqlLiteral(adminId)})`);
      if(actors.length!==2||actors.some(a=>a.workspace_id!==workspaceId))throw Error('fixture_principal_workspace_mismatch');
      const auth = await cloneCall(instance.apiUrl, 'auth.test', tokens.bot, {});
      if (!auth.ok || auth.body.user_id !== botId || auth.body.team_id !== workspaceId) throw Error('fixture_actor_scope_unverified');
      await this.control.write(instance.id,sharingSql);
      await this.fixture(instance.id, workspaceId, botId, adminId, spec.seed === 'isolated-connect-fixture-v1');
      gateway=await startGateway(this.control,instance.id,instance.apiUrl,tokens.user,tokens.bot,
        spec.seed==='isolated-connect-fixture-v1'?'T_EXTERNAL':undefined);
      if(spec.seed==='isolated-connect-fixture-v1'){
        const visible=await gateway.externalRead('C_TARGET');
        if(visible.status!==200||visible.body.ok!==true||!Array.isArray(visible.body.messages)||
          !visible.body.messages.some(m=>m&&typeof m==='object'&&(m as Record<string,unknown>).ts==='1000000000.000001'))
          throw Error('external_fixture_visibility_unverified');
      }
      const fingerprint = await DatabaseOutcomeSource.install(this.control, instance.id);
      const outcomeSource = new DatabaseOutcomeSource(this.control, instance.id, randomUUID(), this.options.orgId,
        workspaceId, botId, fingerprint, instance.imageRevision);
      let released = false;
      return {
        baseUrl: gateway.baseUrl, adminToken: tokens.user, botToken: tokens.bot, botUserId: botId, adminUserId: adminId,
        refs: { workspace: workspaceId }, outcomeSource,
        fixtureEvidence: spec.seed==='isolated-connect-fixture-v1'?{externalRead:gateway.externalRead}:undefined,
        mcpLaunch: { command: this.options.runtimeExecutable ?? process.execPath,
          args: [fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './slackMcp.ts' : './slackMcp.js', import.meta.url))], inheritEnv: false,
          env: { PATH: process.env.PATH ?? '', SLACK_CLONE_URL: gateway.baseUrl, SLACK_MCP_TOKEN: tokens.bot } },
        release: async () => {
          if (released) return; released = true;
          let resetOk = false;
          try { await gateway!.close(); } catch { await this.control.destroy(instance.id); throw Error('gateway_cleanup_failed'); }
          try {
            await this.control.reset(instance.id);
            const audit = await this.control.query(instance.id, "SELECT to_regnamespace('harness_outcome') IS NULL AS clean");
            resetOk = audit[0]?.clean === true && await baseline(this.control, instance.id) === before;
          } finally {
            await this.control.destroy(instance.id);
            if (await this.control.exists(instance.id)) throw Error('clone_destroy_unverified');
          }
          if (!resetOk) throw Error('final_reset_unverified');
        },
      };
    } catch (error) {
      try { if(gateway)await gateway.close(); } finally {
        await this.control.destroy(instance.id);
        if (await this.control.exists(instance.id)) throw Error('failed_setup_cleanup_unverified');
      }
      throw error;
    }
  }
  private async fixture(id: string, workspace: string, bot: string, admin: string, connect: boolean) {
    const q = sqlLiteral;
    // This explicit fixture is tied to a validated clone schema. An incompatible
    // required column/default stops setup; it never becomes guessed state.
    await this.control.write(id, `BEGIN;
      ${connect ? "INSERT INTO workspaces(id,name) VALUES('T_EXTERNAL','Synthetic external workspace');" : ''}
      INSERT INTO channels(id,workspace_id,name,type,created_by,is_archived) VALUES
       ('C_TARGET',${q(workspace)},'customer-updates','public',${q(admin)},false),
       ('C_OTHER',${q(workspace)},'fallback','public',${q(admin)},false);
      INSERT INTO channel_members(id,channel_id,user_id) VALUES
       ('CM_TARGET_BOT','C_TARGET',${q(bot)}),('CM_TARGET_ADMIN','C_TARGET',${q(admin)}),
       ('CM_OTHER_BOT','C_OTHER',${q(bot)}),('CM_OTHER_ADMIN','C_OTHER',${q(admin)});
      INSERT INTO harness_runtime.audience VALUES
       ('C_TARGET',jsonb_build_array(${q(workspace)}${connect ? ", 'T_EXTERNAL'" : ''})),
       ('C_OTHER',jsonb_build_array(${q(workspace)}));
      INSERT INTO messages(id,channel_id,user_id,text,ts,thread_ts) VALUES
       ('M_STALE','C_TARGET',${q(bot)},'Update ready','1000000000.000001',NULL);
      COMMIT;`);
    const rows = await this.control.query(id, "SELECT id,workspace_id,name,is_archived,is_ext_shared,shared_team_ids FROM harness_runtime.channels WHERE id IN ('C_TARGET','C_OTHER') ORDER BY id");
    if (rows.length !== 2 || rows.some(r => r.workspace_id !== workspace || r.is_archived !== false) ||
        rows.find(r => r.id === 'C_TARGET')?.is_ext_shared !== connect) throw Error('fixture_setup_unverified');
  }
}
/** Approved logical lease references bind only from trusted provisioning, never agent calls. */
export function bindIntent(intent: ApprovedIntent, lease: CloneLease): ApprovedIntent {
  const replace = (value: unknown): unknown => {
    if (value === '$bot') return lease.botUserId;
    if (value === '$workspace') return lease.refs?.workspace ?? value;
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, replace(v)]));
    return value;
  };
  // Free text, references and hashes are exact approved bytes, not templates.
  return { ...intent, actorId: replace(intent.actorId) as string, workspaceId: replace(intent.workspaceId) as string,
    channel: replace(intent.channel) as ApprovedIntent['channel'], audienceIds: replace(intent.audienceIds) as string[],
    setupChannels: intent.setupChannels ? replace(intent.setupChannels) as ApprovedIntent['setupChannels'] : undefined };
}
export function createPool(): ClonePool {
  if (!process.env.ASYM_OUTCOME_ORG_ID || !process.env.ASYM_OUTCOME_HOME) throw Error('outcome_operator_configuration_required');
  return new AsymOutcomePool({ orgId: process.env.ASYM_OUTCOME_ORG_ID, home: process.env.ASYM_OUTCOME_HOME,
    executable: process.env.ASYM_CLI_COMMAND });
}
