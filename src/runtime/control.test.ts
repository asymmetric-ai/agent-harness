import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AsymCliControl } from './asym.js';
import { bindIntent } from './pool.js';
import type { ApprovedIntent } from '../scenario/outcome.js';

test('CLI transport owns only new clones, validates loopback/digest and cleans rejected origins', async () => {
  const folder = await mkdtemp(join(process.env.OUTCOME_TEST_ROOT ?? process.cwd(), '.runtime-test-'));
  try {
    const executable = join(folder, 'fixture-cli');
    const config = join(folder, 'row.json');
    const calls = join(folder, 'calls.jsonl');
    const registry = join(folder, 'registry.json');
    const dockerState = join(folder,'docker-state.json');
    const dockerExecutable = join(folder,'fixture-docker');
    await writeFile(dockerState,JSON.stringify({}));
    await writeFile(dockerExecutable,`#!/usr/bin/env bun
const {readFileSync}=require('node:fs');const a=process.argv.slice(2);const s=JSON.parse(readFileSync(${JSON.stringify(dockerState)},'utf8'));
if(s.unavailable)process.exit(2);
if(a[0]==='ps'){if(a.some(x=>x.startsWith('label=asym.clone='))){if(s.backend)console.log('remaining-owned-backend');}else if(!s.sharedMissing)console.log('fixture-postgres');}
else if(a[0]==='exec'){if(s.databaseUnavailable)process.exit(2);if(s.database)console.log('1');}
else process.exit(2);
`);
    await chmod(dockerExecutable,0o700);
    await writeFile(registry,JSON.stringify({version:2,clones:[],environments:[]}));
    await writeFile(executable, `#!/usr/bin/env bun
const {readFileSync,appendFileSync}=require('node:fs');
const a=process.argv.slice(2);appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');
if(a[0]==='spin')console.log(readFileSync(${JSON.stringify(config)},'utf8'));
else if(a[0]==='status')console.log(readFileSync(${JSON.stringify(registry)},'utf8'));
else if(a[0]==='query'&&a.includes('--json'))console.log('[{"value":1}]');
else if(a[0]==='query')console.log('OUTCOME_JSON:{"value":1}');
`);
    await chmod(executable, 0o700);
    const row = {id:'slack-owned-test', database:'clone_slack_owned_test', endpoints:{api:'http://127.0.0.1:1234/api'}, imageDigest:'repo@sha256:'+'a'.repeat(64)};
    await writeFile(config, JSON.stringify([row]));
    const control = new AsymCliControl(executable, folder, dockerExecutable);
    await assert.rejects(() => control.reset('slack-user-existing'), /clone_not_owned/);
    assert.equal((await control.create()).imageRevision,row.imageDigest);
    assert.deepEqual(await control.query(row.id,'SELECT 1'),[{value:1}]);
    assert.match(await control.write(row.id,'SELECT 1'),/OUTCOME_JSON/);
    await control.reset(row.id);await control.destroy(row.id);assert.equal(await control.exists(row.id),false);
    await writeFile(registry,JSON.stringify({version:2,clones:[{id:row.id}],environments:[]}));
    assert.equal(await control.exists(row.id),true);
    for(const invalid of [[],{version:3,clones:[]},{version:2,clones:[null]},{version:2,clones:[{}]}]){
      await writeFile(registry,JSON.stringify(invalid));
      await assert.rejects(()=>control.exists(row.id),/clone_registry_invalid/);
    }
    await writeFile(registry,JSON.stringify({version:2,clones:[],environments:[]}));
    // A CLI registry entry disappearing is insufficient evidence of destruction.
    for(const retained of [{backend:true},{database:true}]){
      await writeFile(dockerState,JSON.stringify(retained));
      assert.equal(await control.exists(row.id),true);
    }
    for(const unknown of [{sharedMissing:true},{databaseUnavailable:true},{unavailable:true}]){
      await writeFile(dockerState,JSON.stringify(unknown));
      await assert.rejects(()=>control.exists(row.id),/clone_database_absence_unverified|clone_command_failed/);
    }
    await writeFile(dockerState,JSON.stringify({}));
    for (const bad of [{...row,endpoints:{api:'https://example.com/api'}},{...row,imageDigest:'latest'},{...row,expose:true},{...row,database:'postgres'}]) {
      await writeFile(config,JSON.stringify([bad]));
      await assert.rejects(()=>new AsymCliControl(executable,folder,dockerExecutable).create(),/clone_origin_or_revision_unverified/);
    }
    const log=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(log.filter(args=>args[0]==='destroy').length,5);
    assert.equal(log.some(args=>args.includes('slack-user-existing')),false);
    assert.deepEqual(log[0],['spin','slack','--mode','api','--seed','acme-corp','--json']);
  } finally {await rm(folder,{recursive:true,force:true});}
});

test('lease reference binding never templates approved text, hashes or source references', () => {
  const intent={actorId:'$bot',workspaceId:'$workspace',channel:{id:'C_TARGET',workspaceId:'$workspace',audienceIds:['$workspace']},
    audienceIds:['$workspace','T_EXTERNAL'],text:'$bot $workspace',reference:'$workspace',scenarioDigest:'$bot'} as ApprovedIntent;
  const lease: Parameters<typeof bindIntent>[1] = {botUserId:'U_NEW',refs:{workspace:'T_NEW'},
    baseUrl:'http://127.0.0.1:1',adminToken:'fixture-admin',botToken:'fixture-bot',adminUserId:'U_ADMIN',
    mcpLaunch:{command:'unused',args:[]},release:async()=>{}};
  const bound=bindIntent(intent,lease);
  assert.equal(bound.actorId,'U_NEW');assert.equal(bound.channel.workspaceId,'T_NEW');
  assert.deepEqual(bound.audienceIds,['T_NEW','T_EXTERNAL']);
  assert.equal(bound.text,intent.text);assert.equal(bound.reference,intent.reference);assert.equal(bound.scenarioDigest,intent.scenarioDigest);
  assert.equal(intent.actorId,'$bot');
});
