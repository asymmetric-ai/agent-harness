import { createHash } from 'node:crypto';
import type { CloneControl } from './asym.js';
import type { ChannelState, FinalEvidence, MessageRecord, OutcomeSource, Snapshot } from '../scenario/outcome.js';

const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
export const AUDIT_SCHEMA = 'harness_outcome';
export const auditSql = `
CREATE SCHEMA harness_outcome;
REVOKE ALL ON SCHEMA harness_outcome FROM PUBLIC;
CREATE TABLE harness_outcome.effects (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 operation text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(),
 record jsonb NOT NULL, channel jsonb NOT NULL
);
REVOKE ALL ON harness_outcome.effects FROM PUBLIC;
CREATE FUNCTION harness_outcome.record_effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $audit$
DECLARE r jsonb; c jsonb;
BEGIN
 r := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 PERFORM 1 FROM public.channels ch WHERE ch.id::text=r->>'channel_id' FOR SHARE;
 PERFORM 1 FROM harness_runtime.audience a WHERE a.channel_id=r->>'channel_id' FOR SHARE;
 SELECT to_jsonb(ch) INTO STRICT c FROM harness_runtime.channels ch WHERE ch.id::text=r->>'channel_id';
 PERFORM 1 FROM public.workspaces w WHERE w.id::text=c->>'workspace_id' OR w.id::text IN
   (SELECT jsonb_array_elements_text(c->'shared_team_ids')) FOR SHARE;
 c := c || jsonb_build_object('_audience_workspaces',(SELECT coalesce(jsonb_agg(w.id::text),'[]') FROM public.workspaces w
   WHERE w.id::text=c->>'workspace_id' OR w.id::text IN (SELECT jsonb_array_elements_text(c->'shared_team_ids'))));
 INSERT INTO harness_outcome.effects(operation,record,channel) VALUES(TG_OP,r,c);
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $audit$;
CREATE TRIGGER harness_outcome_message_effect AFTER INSERT OR UPDATE OR DELETE ON public.messages
FOR EACH ROW EXECUTE FUNCTION harness_outcome.record_effect();
`;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function requireSchema(control: CloneControl, id: string) {
  const columns = await control.query(id, "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'");
  const has = (table: string, col: string) => columns.some(r => r.table_name === table && r.column_name === col);
  const required: Record<string, string[]> = {
    channels: ['id', 'name', 'workspace_id', 'type', 'created_by', 'is_archived'],
    messages: ['id', 'channel_id', 'user_id', 'text', 'ts', 'thread_ts'],
    workspaces: ['id'], users: ['id', 'workspace_id'], channel_members: ['channel_id', 'user_id'],
  };
  if (Object.entries(required).some(([table, cols]) => cols.some(col => !has(table, col))))
    throw Error('clone_outcome_schema_unsupported');
}
export async function baseline(control: CloneControl, id: string): Promise<string> {
  // Credential/token data never leaves the clone. Compare the fixture semantics
  // and stable IDs across reset, excluding volatile provisioning secrets.
  const parts = await control.query(id, `SELECT jsonb_build_object(
    'workspaces',(SELECT coalesce(jsonb_agg(to_jsonb(w)-'created_at'-'updated_at' ORDER BY id),'[]') FROM workspaces w),
    'users',(SELECT coalesce(jsonb_agg(to_jsonb(u)-'password_hash'-'created_at'-'updated_at' ORDER BY id),'[]') FROM users u),
    'channels',(SELECT coalesce(jsonb_agg(to_jsonb(c)-'created_at'-'updated_at' ORDER BY id),'[]') FROM channels c),
    'messages',(SELECT coalesce(jsonb_agg(to_jsonb(m)-'created_at'-'updated_at' ORDER BY id),'[]') FROM messages m),
    'members',(SELECT coalesce(jsonb_agg(to_jsonb(cm)-'id'-'created_at'-'updated_at'-'joined_at' ORDER BY channel_id,user_id),'[]') FROM channel_members cm)
  ) AS state`);
  if (parts.length !== 1 || !parts[0]?.state) throw Error('clone_baseline_unavailable');
  return sha(parts[0].state);
}
function channel(row: Record<string, unknown>): ChannelState {
  const teams = row.shared_team_ids;
  const known = row._audience_workspaces;
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.workspace_id !== 'string' ||
      typeof row.is_archived !== 'boolean' || typeof row.is_ext_shared !== 'boolean' ||
      !Array.isArray(known) || !known.includes(row.workspace_id) || !Array.isArray(teams) ||
      teams.some(t => !known.includes(t)) || !teams.every(t => typeof t === 'string') || new Set(teams).size !== teams.length ||
      (row.is_ext_shared && (teams.length < 2 || !teams.includes(row.workspace_id))) ||
      (!row.is_ext_shared && teams.some(t => t !== row.workspace_id))) throw Error('channel_audience_unverified');
  return { id: row.id, name: row.name, workspaceId: row.workspace_id, isArchived: row.is_archived,
    audienceIds: row.is_ext_shared ? teams as string[] : [row.workspace_id] };
}
function message(row: Record<string, unknown>, actionAt?: string): MessageRecord {
  if (![row.id, row.channel_id, row.user_id, row.text, row.ts].every(x => typeof x === 'string')) throw Error('message_record_unverified');
  if(row.is_deleted===true)throw Error('deleted_record_not_delivery');
  const at = actionAt ?? new Date(Number(row.ts) * 1000).toISOString();
  return { id: row.id as string, channelId: row.channel_id as string, actorId: row.user_id as string,
    threadId: typeof row.thread_ts === 'string' ? row.thread_ts : '', text: row.text as string, actionAt: at };
}

export class DatabaseOutcomeSource implements OutcomeSource {
  readonly isolated = true;
  readonly resetVerified = true;
  private initial?: { snapshot: Snapshot; cursor: number };
  constructor(private control: CloneControl, private cloneId: string, public runId: string,
    public orgId: string, public workspaceId: string, public actorId: string, private auditFingerprint: string, private backendRevision = 'operator-supplied') {}
  static async install(control: CloneControl, id: string): Promise<string> {
    await control.write(id, auditSql);
    return this.auditFingerprint(control, id);
  }
  static async auditFingerprint(control: CloneControl, id: string): Promise<string> {
    const rows = await control.query(id, `SELECT pg_get_functiondef('harness_outcome.record_effect()'::regprocedure) AS definition,
      tgenabled FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND tgname='harness_outcome_message_effect'`);
    if (rows.length !== 1 || rows[0]?.tgenabled !== 'O' || typeof rows[0]?.definition !== 'string') throw Error('audit_trigger_unverified');
    return sha(rows);
  }
  private async read() {
    // Serialize with message/channel writers so a transaction cannot allocate a
    // journal sequence before capture and commit behind its high-water cursor.
    const sql = `BEGIN; LOCK TABLE public.messages,public.channels,public.workspaces,harness_runtime.audience IN SHARE ROW EXCLUSIVE MODE;
      SELECT 'OUTCOME_JSON:' || jsonb_build_object(
       'at',clock_timestamp(),'cursor',(SELECT coalesce(max(seq),0) FROM harness_outcome.effects),
       'channels',(SELECT coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('_audience_workspaces',(SELECT coalesce(jsonb_agg(w.id::text),'[]')
          FROM workspaces w WHERE w.id::text=c.workspace_id::text OR w.id::text IN (SELECT jsonb_array_elements_text(to_jsonb(c)->'shared_team_ids')))) ORDER BY id),'[]') FROM harness_runtime.channels c WHERE c.workspace_id=${literal(this.workspaceId)}),
       'records',(SELECT coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(m),'at',
          (SELECT at FROM harness_outcome.effects e WHERE operation='INSERT' AND e.record->>'id'=m.id::text ORDER BY seq DESC LIMIT 1)) ORDER BY id),'[]') FROM messages m WHERE coalesce((to_jsonb(m)->>'is_deleted')::boolean,false)=false AND EXISTS
          (SELECT 1 FROM public.channels scoped WHERE scoped.id=m.channel_id AND scoped.workspace_id=${literal(this.workspaceId)})),
       'effects',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY seq),'[]') FROM harness_outcome.effects e)
      )::text; COMMIT;`;
    const raw = await this.control.write(this.cloneId, sql);
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.startsWith('OUTCOME_JSON:'));
    if (lines.length !== 1) throw Error('database_snapshot_unavailable');
    const data = JSON.parse(lines[0]!.slice('OUTCOME_JSON:'.length));
    if (!Number.isSafeInteger(Number(data.cursor)) || !Array.isArray(data.channels) || !Array.isArray(data.records) || !Array.isArray(data.effects))
      throw Error('database_snapshot_invalid');
    const missing=await this.control.query(this.cloneId, 'SELECT count(*)::int AS missing FROM channels c LEFT JOIN harness_runtime.audience a ON a.channel_id=c.id WHERE a.channel_id IS NULL');
    if(missing[0]?.missing!==0)throw Error('audience_coverage_incomplete');
    const channels = data.channels.map(channel) as ChannelState[];
    // A dedicated clone may include the external fixture workspace but cannot
    // hide another home workspace's channels in a purported complete snapshot.
    if (channels.some(c => c.workspaceId !== this.workspaceId)) throw Error('workspace_scope_mismatch');
    const records = data.records.map((r: { row: Record<string, unknown>; at?: string }) => message(r.row, r.at ?? undefined));
    const snapshot: Snapshot = { runId: this.runId, orgId: this.orgId, workspaceId: this.workspaceId,
      revision: this.backendRevision + ':' + this.cloneId + ':' + sha(data), capturedAt: data.at, complete: true, channels, records };
    return { snapshot, cursor: Number(data.cursor), effects: data.effects as Array<{seq: number; operation: string; at: string; record: Record<string, unknown>; channel: Record<string, unknown>}> };
  }
  async capture() {
    if (this.initial) throw Error('snapshot_already_started');
    if (await DatabaseOutcomeSource.auditFingerprint(this.control, this.cloneId) !== this.auditFingerprint) throw Error('audit_changed');
    this.initial = await this.read(); return this.initial.snapshot;
  }
  async finish(): Promise<FinalEvidence> {
    if (!this.initial) throw Error('initial_snapshot_required');
    const final = await this.read();
    if (await DatabaseOutcomeSource.auditFingerprint(this.control, this.cloneId) !== this.auditFingerprint) throw Error('audit_changed');
    const events = final.effects.filter(e => Number(e.seq) > this.initial!.cursor);
    // Every mutation is retained. Inserts are writes; updates/deletes also
    // invalidate completeness if final-state comparison cannot account for them.
    const writes = events.filter(e => e.operation === 'INSERT').map(e => ({ record: message(e.record, e.at), channelAtAction: channel(e.channel) }));
    return { snapshot: final.snapshot, writes, journalComplete: events.every(e => e.operation === 'INSERT'),
      from: this.initial.snapshot.capturedAt, through: final.snapshot.capturedAt };
  }
}
export const sqlLiteral = literal;
