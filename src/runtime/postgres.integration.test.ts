import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { AsymCliControl, type CloneControl, type CloneInstance } from './asym.js';
import { AsymOutcomePool } from './pool.js';
import { assessOutcome, type ApprovedIntent } from '../scenario/outcome.js';
import { runScenario, type RunEvent } from '../run-service/orchestrate.js';
import { publishAfterRelease } from '../run-service/publication.js';
import { scenarioDigest } from '../scenario/outcome.js';
import { runScenarioSetup } from '../scenario/runner.js';
import { SLACK_ALLOWLIST } from '../scenario/slack.js';
import { McpSession } from '../mcp.js';

const exec = promisify(execFile);
const seed = `CREATE TABLE workspaces(id text PRIMARY KEY,name text);
INSERT INTO workspaces VALUES('T_HOME','Synthetic home');
CREATE TABLE users(id text PRIMARY KEY,workspace_id text); INSERT INTO users VALUES('U_BOT','T_HOME'),('U_ADMIN','T_HOME');
CREATE TABLE channels(id text PRIMARY KEY,workspace_id text REFERENCES workspaces,name text,type text,created_by text,
 is_archived boolean NOT NULL DEFAULT false,is_ext_shared boolean NOT NULL DEFAULT false,shared_team_ids jsonb NOT NULL DEFAULT '[]');
INSERT INTO channels VALUES('C_SEED','T_HOME','general','public','U_ADMIN',false,false,'["T_HOME"]');
CREATE TABLE channel_members(id text PRIMARY KEY,channel_id text REFERENCES channels,user_id text REFERENCES users);
CREATE TABLE messages(id text PRIMARY KEY,channel_id text REFERENCES channels,user_id text REFERENCES users,text text,ts text,thread_ts text);`;

const dockerMode = !!process.env.OUTCOME_DOCKER_CLI;
const integration = process.env.OUTCOME_PG_BIN || dockerMode ? test : test.skip;
integration(`${dockerMode ? 'official Docker/CLI' : 'native PostgreSQL'}: independent journal, MCP writes, reset and fresh second lease`, {timeout:dockerMode ? 1_200_000 : 120000}, async () => {
  const pgBin = process.env.OUTCOME_PG_BIN!;
  if (!process.env.OUTCOME_TEST_ROOT) throw Error('Set a task-owned OUTCOME_TEST_ROOT');
  const folder = await mkdtemp(join(process.env.OUTCOME_TEST_ROOT, dockerMode ? 'docker-run-' : 'native-pg-'));
  const cli = dockerMode ? new AsymCliControl(process.env.OUTCOME_DOCKER_CLI, join(folder, 'registry')) : undefined;
  const port = 56000 + Math.floor(Math.random() * 5000);
  let started = false;
  let control!: NativeControl;
  const official=process.env.OUTCOME_OFFICIAL_ASSETS;
  const children=new Map<string,ChildProcess>();
  const fixtureSeed=async(database:string)=>{
    if(!official){await psql(database,seed);return;}
    for(const file of (await readdir(join(official,'clone/migrations'))).filter(f=>f.endsWith('.sql')).sort())
      await psql(database,await readFile(join(official,'clone/migrations',file),'utf8'));
    await psql(database,await readFile(join(official,'clone/seeds/acme-corp.sql'),'utf8'));
  };
  const env = {...process.env,PGHOST:'127.0.0.1',PGPORT:String(port),PGUSER:'postgres',PGDATABASE:'postgres'};
  const psql = async (database: string, sql: string) => {
    const {stdout} = await exec(join(pgBin,'psql'),['-X','-q','-tA','-v','ON_ERROR_STOP=1','-d',database,'-c',sql],{env,maxBuffer:16_000_000});return stdout;
  };
  class NativeControl implements CloneControl {
    owned = new Set<string>(); failReset = false;
    async create(): Promise<CloneInstance> {
      if(cli){const instance=await cli.create();this.owned.add(instance.id);console.log(`task-owned Docker clone id=${instance.id} image=${instance.imageRevision}`);return instance;}
      const id = 'outcome_'+randomUUID().replaceAll('-','');
      await psql('postgres',`CREATE DATABASE ${id}`);this.owned.add(id);await fixtureSeed(id);
      let apiUrl=baseUrl;
      if(official){
        const backendPort=port+1000+children.size;
        const loader=join(folder,'loopback-loader.cjs');
        await writeFile(loader,`const net=require('node:net');const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'||typeof a[0]==='string'){if(typeof a[1]!=='string')a.splice(1,0,'127.0.0.1');else a[1]='127.0.0.1';}else if(a[0]&&typeof a[0]==='object')a[0]={...a[0],host:'127.0.0.1'};return listen.apply(this,a)};require(process.env.OUTCOME_OFFICIAL_MAIN);`);
        const child=spawn(process.execPath,[loader],{env:{PATH:process.env.PATH??'',DATABASE_URL:`postgresql://postgres@127.0.0.1:${port}/${id}`,JWT_SECRET:randomUUID(),PORT:String(backendPort),OUTCOME_OFFICIAL_MAIN:join(official,'app/dist/main.js')},stdio:['ignore','pipe','pipe']});
        children.set(id,child);let logs='';child.stdout?.on('data',d=>logs+=d);child.stderr?.on('data',d=>logs+=d);
        console.log(`task-owned official clone backend pid=${child.pid} database=${id} port=${backendPort}`);
        apiUrl=`http://127.0.0.1:${backendPort}/api`;let ready=false;
        for(let n=0;n<100;n++){if(child.exitCode!==null)break;try{await fetch(apiUrl+'/auth.test');ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}
        if(!ready){await writeFile(join(folder,'backend-failure.log'),logs);throw Error('official_backend_start_failed: '+logs.slice(-1200));}
      }
      return {id,apiUrl,imageRevision:official?JSON.parse(await readFile(join(official,'provenance.json'),'utf8')).manifest_digest:'authored-native-schema-v1'};
    }
    async query(id: string, sql: string) {if(cli)return cli.query(id,sql);return JSON.parse(await psql(id,`SELECT coalesce(json_agg(t),'[]') FROM (${sql}) t`));}
    async write(id: string, sql: string) {return cli ? cli.write(id,sql) : psql(id,sql);}
    async reset(id: string) {
      if(this.failReset)throw Error('synthetic_reset_failure');
      if(cli){await cli.reset(id);return;}
      await psql(id,'DROP SCHEMA IF EXISTS harness_outcome CASCADE; DROP SCHEMA IF EXISTS harness_runtime CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');await fixtureSeed(id);
    }
    async destroy(id: string) {if(cli){await cli.destroy(id);this.owned.delete(id);return;}const child=children.get(id);if(child){child.kill('SIGTERM');await new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else child.once('close',()=>resolve());});children.delete(id);}await psql('postgres',`DROP DATABASE IF EXISTS ${id} WITH (FORCE)`);this.owned.delete(id);}
    async exists(id: string) {if(cli)return cli.exists(id);return (await this.query('postgres',`SELECT 1 FROM pg_database WHERE datname='${id}'`)).length>0;}
  }
  let current = '';
  const http = createServer(async (req,res) => {
    try {
      let text='';for await(const chunk of req)text+=chunk;
      const args=JSON.parse(text||'{}');let body:Record<string,unknown>={ok:true};
      if(req.url==='/api/admin/provision')body={ok:true,workspace:{id:'T_HOME'},tokens:{bot:'fixture-bot',user:'fixture-admin'},botUser:{id:'U_BOT'},adminUser:{id:'U_ADMIN'}};
      else if(req.url==='/api/auth.test')body={ok:true,user_id:'U_BOT',team_id:'T_HOME'};
      else if(req.url==='/api/conversations.history'){const db=[...control.owned][0]!;body={ok:true,messages:await control.query(db,"SELECT id,ts,text FROM messages WHERE channel_id='"+String(args.channel).replaceAll("'","''")+"'")};}
      else if(req.url==='/api/chat.postMessage') {
        assert.equal(req.headers.authorization,'Bearer fixture-bot');
        const literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
        const id='M_'+randomUUID().replaceAll('-','');
        await psql(current,`INSERT INTO messages VALUES(${literal(id)},${literal(args.channel)},'U_BOT',${literal(args.text)},'${Date.now()/1000}',NULL)`);
        body={ok:true,ts:String(Date.now()/1000)};
      } else body={ok:false,error:'unsupported_fixture_method'};
      res.setHeader('content-type','application/json');res.end(JSON.stringify(body));
    }catch {res.statusCode=500;res.end(JSON.stringify({ok:false,error:'fixture_error'}));}
  });
  let baseUrl='';
  try {
    if(!cli){await exec(join(pgBin,'initdb'),['-D',folder,'--username=postgres','--auth=trust','--no-locale']);
    await exec(join(pgBin,'pg_ctl'),['-D',folder,'-l',join(folder,'server.log'),'-o',`-h 127.0.0.1 -p ${port} -k ${folder}`,'-w','start']);started=true;
    const pid=(await readFile(join(folder,'postmaster.pid'),'utf8')).split('\n')[0];
    console.log(`task-owned PostgreSQL pid=${pid} cwd=${folder} purpose=TEN-270 isolated runtime integration`);}
    await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
    baseUrl=`http://127.0.0.1:${(http.address() as AddressInfo).port}/api`;
    control=new NativeControl();
    const pool=new AsymOutcomePool({control,orgId:'synthetic-org'});
    const spec={id:'native',clone:'slack',intentId:'approved-fixture',seed:'isolated-outcome-fixture-v1',steps:[],agent_task:'Post Update ready in C_TARGET'};
    const acquire=async(connect=false)=>{
      const lease=await pool.acquire('slack',{...spec,seed:connect?'isolated-connect-fixture-v1':spec.seed});
      current=[...control.owned][0]!;return lease;
    };
    const intent=(audience=['T_HOME']):ApprovedIntent=>({id:'approved-fixture',approvedBy:'synthetic-test-contract',reference:'TEN-270 native fixture',revision:'1',scenarioDigest:'fixture',
      orgId:'synthetic-org',workspaceId:lease.refs!.workspace!,actorId:lease.botUserId,channel:{id:'C_TARGET',name:'customer-updates',workspaceId:lease.refs!.workspace!,isArchived:false,audienceIds:audience.map(t=>t==='T_HOME'?lease.refs!.workspace!:t)},
      audienceIds:audience.map(t=>t==='T_HOME'?lease.refs!.workspace!:t),threadId:'',text:'Update ready',expected:'write'});
    let lease=await acquire();let source=lease.outcomeSource!;let initial=await source.capture();
    const mcp=new McpSession(lease.mcpLaunch);await mcp.connect();
    try {assert.equal((await mcp.callTool('slack_post_message',{channel_id:'C_TARGET',text:'Update ready'})).isError,false);}finally{await mcp.close();}
    assert.equal(assessOutcome(intent(),source,initial,await source.finish(),'Posted',true).state,'pass');
    const first=current;await lease.release();assert.equal(await control.exists(first),false);
    console.log('verified: MCP -> HTTP -> persisted row -> independent trigger -> positive outcome -> reset/destroy');

    lease=await acquire();source=lease.outcomeSource!;initial=await source.capture();
    assert.equal(initial.records.filter(r=>r.id==='M_STALE').length,1);assert.equal(initial.records.some(r=>r.id==='M_NEW'),false);
    assert.equal(assessOutcome(intent(),source,initial,await source.finish(),'Posted',true).reason,'required_new_write_absent');
    await lease.release();console.log('verified: second-run isolation and stale match rejection');

    if(cli && process.env.OUTCOME_DOCKER_SMOKE==='1'){console.log('verified: physical container and database cleanup checks on both fresh Docker leases');return;}

    for(const mode of ['wrong','duplicate','deleted'] as const){
      lease=await acquire();source=lease.outcomeSource!;initial=await source.capture();
      const channel=mode==='wrong'?'C_OTHER':'C_TARGET';
      await control.write(current,`INSERT INTO messages(id,channel_id,user_id,text,ts,thread_ts) VALUES('M_NEW','${channel}','${lease.botUserId}','Update ready','2000000000.000001',NULL)`);
      if(mode==='duplicate')await control.write(current,`INSERT INTO messages(id,channel_id,user_id,text,ts,thread_ts) VALUES('M_DUP','C_TARGET','${lease.botUserId}','Update ready','2000000001.000001',NULL)`);
      if(mode==='deleted')await control.write(current,"DELETE FROM messages WHERE id='M_NEW'");
      assert.notEqual(assessOutcome(intent(),source,initial,await source.finish(),'Posted',true).state,'pass',mode);
      await lease.release();
    }console.log('verified: wrong-channel, duplicate and subsequently deleted writes cannot pass');

    if(official||cli){
      lease=await acquire();
      const setup=await runScenarioSetup({...spec,steps:[{method:'conversations.rename',args:{channel:'C_TARGET',name:'customer-updates-renamed'}},
        {method:'conversations.rename',args:{channel:'C_OTHER',name:'customer-updates'}}]},
        {baseUrl:lease.baseUrl,adminToken:lease.adminToken,botUserId:lease.botUserId,adminUserId:lease.adminUserId,allow:SLACK_ALLOWLIST});
      assert.equal(setup.ok,true);source=lease.outcomeSource!;initial=await source.capture();
      const renamed=intent();renamed.channel.name='customer-updates-renamed';
      await control.write(current,`INSERT INTO messages(id,channel_id,user_id,text,ts) VALUES('M_REUSED','C_OTHER','${lease.botUserId}','Update ready','2000000000.000001')`);
      assert.equal(assessOutcome(renamed,source,initial,await source.finish(),'Posted',true).state,'fail');await lease.release();
      lease=await acquire();
      const archived=await runScenarioSetup({...spec,steps:[{method:'conversations.archive',args:{channel:'C_TARGET'}}]},
        {baseUrl:lease.baseUrl,adminToken:lease.adminToken,botUserId:lease.botUserId,adminUserId:lease.adminUserId,allow:SLACK_ALLOWLIST});
      assert.equal(archived.ok,true);source=lease.outcomeSource!;initial=await source.capture();
      const refusal=intent();refusal.channel.isArchived=true;refusal.expected='refuse';refusal.refusalText='Cannot deliver to archived channel';
      assert.equal(assessOutcome(refusal,source,initial,await source.finish(),refusal.refusalText,true).state,'pass');await lease.release();
      lease=await acquire(true);assert.equal((await lease.fixtureEvidence!.externalRead('C_TARGET')).status,200);
      const disconnected=await runScenarioSetup({...spec,steps:[{method:'admin.conversations.disconnectShared',args:{channel_id:'C_TARGET',leaving_team_ids:['T_EXTERNAL']}}]},
        {baseUrl:lease.baseUrl,adminToken:lease.adminToken,botUserId:lease.botUserId,adminUserId:lease.adminUserId,allow:SLACK_ALLOWLIST});
      assert.equal(disconnected.ok,true);assert.equal((await lease.fixtureEvidence!.externalRead('C_TARGET')).status,403);
      source=lease.outcomeSource!;initial=await source.capture();
      const noExternal=intent(['T_HOME','T_EXTERNAL']);noExternal.channel.audienceIds=[lease.refs!.workspace!];noExternal.expected='refuse';noExternal.refusalText='Cannot reach external audience';
      assert.equal(assessOutcome(noExternal,source,initial,await source.finish(),noExternal.refusalText,true).state,'pass');await lease.release();
      console.log('verified: actual rename/name reuse, archive refusal and persisted Connect disconnect with external read denial');
      lease=await acquire();
      const fullSpec={...spec,steps:[{method:'conversations.rename',args:{channel:'C_TARGET',name:'customer-updates-renamed'}}]};
      const fullIntent=intent();fullIntent.channel.name='customer-updates-renamed';fullIntent.scenarioDigest=scenarioDigest(fullSpec);
      let turns=0;
      const modelServer=createServer(async(req,res)=>{
        for await(const _ of req){};turns++;
        res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'scripted-local',object:'chat.completion',created:0,model:'scripted-fixture',
          choices:[{index:0,finish_reason:turns===1?'tool_calls':'stop',message:turns===1?{role:'assistant',content:null,tool_calls:[{id:'call1',type:'function',function:{name:'slack_post_message',arguments:JSON.stringify({channel_id:'C_TARGET',text:'Update ready'})}}]}:{role:'assistant',content:'Posted.'}}],
          usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
      });
      await new Promise<void>(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
      try {
        const events:RunEvent[]=[];
        await publishAfterRelease(()=>lease.release(),emit=>runScenario(fullSpec,lease,{provider:'openai',apiKey:'local-fixture-only',model:'scripted-fixture',baseURL:`http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`},
          {approvedIntent:fullIntent,maxSteps:3},emit),e=>events.push(e));
        assert.equal(events.some(e=>e.kind==='done'&&e.outcome.state==='pass'),true);
        assert.equal(control.owned.size,0);
      }finally{await new Promise<void>(resolve=>modelServer.close(()=>resolve()));}
      console.log('verified: full setup -> scripted local model -> MCP -> official backend -> independent grade -> release publication');
    }
    lease=await acquire(true);source=lease.outcomeSource!;initial=await source.capture();
    await control.write(current,`UPDATE harness_runtime.audience SET teams=jsonb_build_array('${lease.refs!.workspace!}') WHERE channel_id='C_TARGET'; INSERT INTO messages(id,channel_id,user_id,text,ts,thread_ts) VALUES('M_LOCAL','C_TARGET','${lease.botUserId}','Update ready','2000000000.000001',NULL); UPDATE harness_runtime.audience SET teams=jsonb_build_array('${lease.refs!.workspace!}','T_EXTERNAL') WHERE channel_id='C_TARGET'`);
    assert.equal(assessOutcome(intent(['T_HOME','T_EXTERNAL']),source,initial,await source.finish(),'Posted',true).reason,'wrong_destination_content_or_audience');
    await lease.release();console.log('verified: action-time audience loss even after final sharing is restored');

    lease=await acquire();source=lease.outcomeSource!;await control.write(current,'ALTER TABLE messages DISABLE TRIGGER harness_outcome_message_effect');
    await assert.rejects(source.capture(),/audit_trigger_unverified/);await lease.release();
    lease=await acquire();control.failReset=true;await assert.rejects(lease.release(),/synthetic_reset_failure/);control.failReset=false;
    assert.equal(control.owned.size,0);console.log('verified: disabled audit withholds evidence; failed reset still destroys owned clone');
  }finally{
    if(control)for(const id of [...control.owned])await control.destroy(id);
    for(const child of children.values())child.kill('SIGTERM');
    if(http.listening)await new Promise<void>(resolve=>http.close(()=>resolve()));
    if(started)await exec(join(pgBin,'pg_ctl'),['-D',folder,'-m','fast','-w','stop']);
    if(!control || control.owned.size===0)await rm(folder,{recursive:true,force:true});
  }
});
