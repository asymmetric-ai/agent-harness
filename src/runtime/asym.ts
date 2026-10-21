import { spawn } from 'node:child_process';

export interface CloneInstance { id: string; apiUrl: string; imageRevision: string; }
export interface CloneControl {
  create(): Promise<CloneInstance>;
  query(id: string, sql: string): Promise<Record<string, unknown>[]>;
  write(id: string, sql: string): Promise<string>;
  reset(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  exists(id: string): Promise<boolean>;
}
/** argv/stdin transport; no shell interpolation, raw output or credentials in errors. */
export async function command(executable: string, args: string[], input = '', env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(Error('clone_command_timeout')); }, 120_000);
    child.stdout.on('data', data => {
      size += data.length;
      if (size > 16_000_000) { child.kill(); reject(Error('clone_evidence_too_large')); }
      else output += data;
    });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(Error('clone_command_unavailable')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(Error('clone_command_failed')); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Official @asymmetric-ai/cli 0.2 lifecycle and query contract. Owns only freshly-created IDs. */
export class AsymCliControl implements CloneControl {
  private owned = new Set<string>();
  private databases = new Map<string,string>();
  constructor(private executable = 'asym', private home?: string, private dockerExecutable = 'docker') {}
  private run(args: string[], input = '') {
    return command(this.executable, args, input, { ...process.env, ...(this.home ? { ASYM_HOME: this.home } : {}) });
  }
  private own(id: string) { if (!this.owned.has(id)) throw Error('clone_not_owned'); }
  async create(): Promise<CloneInstance> {
    const rows = JSON.parse(await this.run(['spin', 'slack', '--mode', 'api', '--seed', 'acme-corp', '--json']));
    if (!Array.isArray(rows) || rows.length !== 1) throw Error('clone_creation_unverified');
    const row = rows[0];
    if (typeof row.id !== 'string' || !/^slack-[a-z0-9-]+$/i.test(row.id)) throw Error('clone_identity_unverified');
    this.owned.add(row.id);
    try {
      const expectedDatabase = 'clone_' + row.id.replaceAll('-', '_');
      if (row.database !== expectedDatabase) throw Error('clone_database_identity_unverified');
      this.databases.set(row.id,expectedDatabase);
      const url = new URL(row.endpoints?.api);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || row.expose === true ||
          typeof row.imageDigest !== 'string' || !/@sha256:[a-f0-9]{64}$/.test(row.imageDigest)) throw Error('clone_origin_or_revision_unverified');
      return { id: row.id, apiUrl: url.href.replace(/\/$/, ''), imageRevision: row.imageDigest };
    } catch { await this.destroy(row.id); throw Error('clone_origin_or_revision_unverified'); }
  }
  async query(id: string, sql: string) {
    this.own(id); const rows = JSON.parse(await this.run(['query', id, '--json'], sql));
    if (!Array.isArray(rows)) throw Error('clone_query_invalid');
    return rows as Record<string, unknown>[];
  }
  async write(id: string, sql: string) { this.own(id); return this.run(['query', id, '--write'], sql); }
  async reset(id: string) { this.own(id); await this.run(['reset', id]); }
  async destroy(id: string) { this.own(id); await this.run(['destroy', id]); }
  async exists(id: string) {
    this.own(id); const registry = JSON.parse(await this.run(['status', '--json']));
    // CLI 0.2 returns the versioned registry, not a bare clone array.
    if (!registry || registry.version !== 2 || !Array.isArray(registry.clones) ||
        registry.clones.some((row: unknown) => !row || typeof row !== 'object' || typeof (row as {id?: unknown}).id !== 'string'))
      throw Error('clone_registry_invalid');
    if (registry.clones.some((row: {id: string}) => row.id === id)) return true;
    // CLI0.2 removes registry entries even if its Compose/drop commands fail.
    // Independently verify physical teardown; never infer it from registry alone.
    const containers = await command(this.dockerExecutable,['ps','-aq','--filter',`label=asym.clone=${id}`]);
    if (containers.trim()) return true;
    const database = this.databases.get(id);
    if (!database) throw Error('clone_database_identity_unverified');
    const postgres = (await command(this.dockerExecutable,['ps','-q','--filter',
      'label=com.docker.compose.project=asym-shared','--filter','label=com.docker.compose.service=postgres'])).trim().split(/\s+/).filter(Boolean);
    if (postgres.length !== 1) throw Error('clone_database_absence_unverified');
    const present = (await command(this.dockerExecutable,['exec',postgres[0]!, 'psql','-U','postgres','-d','postgres','-tAc',
      `SELECT 1 FROM pg_database WHERE datname='${database}'`])).trim();
    if (present !== '' && present !== '1') throw Error('clone_database_absence_unverified');
    return present === '1';
  }
}
