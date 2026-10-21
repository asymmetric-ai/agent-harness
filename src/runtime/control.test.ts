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
    await writeFile(executable, `#!/usr/bin/env bun
const {readFileSync,appendFileSync}=require('node:fs');
const a=process.argv.slice(2);appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');
if(a[0]==='spin')console.log(readFileSync(${JSON.stringify(config)},'utf8'));
else if(a[0]==='status')console.log('[]');
else if(a[0]==='query'&&a.includes('--json'))console.log('[{"value":1}]');
else if(a[0]==='query')console.log('OUTCOME_JSON:{"value":1}');
`);
    await chmod(executable, 0o700);
    const row = {id:'slack-owned-test', endpoints:{api:'http://127.0.0.1:1234/api'}, imageDigest:'repo@sha256:'+'a'.repeat(64)};
    await writeFile(config, JSON.stringify([row]));
    const control = new AsymCliControl(executable, folder);
    await assert.rejects(() => control.reset('slack-user-existing'), /clone_not_owned/);
    assert.equal((await control.create()).imageRevision,row.imageDigest);
    assert.deepEqual(await control.query(row.id,'SELECT 1'),[{value:1}]);
    assert.match(await control.write(row.id,'SELECT 1'),/OUTCOME_JSON/);
    await control.reset(row.id);await control.destroy(row.id);assert.equal(await control.exists(row.id),false);
    for (const bad of [{...row,endpoints:{api:'https://example.com/api'}},{...row,imageDigest:'latest'},{...row,expose:true}]) {
      await writeFile(config,JSON.stringify([bad]));
      await assert.rejects(()=>new AsymCliControl(executable,folder).create(),/clone_origin_or_revision_unverified/);
    }
    const log=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(log.filter(args=>args[0]==='destroy').length,4);
    assert.equal(log.some(args=>args.includes('slack-user-existing')),false);
    assert.deepEqual(log[0],['spin','slack','--mode','api','--seed','acme-corp','--json']);
  } finally {await rm(folder,{recursive:true,force:true});}
});

test('lease reference binding never templates approved text, hashes or source references', () => {
  const intent={actorId:'$bot',workspaceId:'$workspace',channel:{id:'C_TARGET',workspaceId:'$workspace',audienceIds:['$workspace']},
    audienceIds:['$workspace','T_EXTERNAL'],text:'$bot $workspace',reference:'$workspace',scenarioDigest:'$bot'} as ApprovedIntent;
  const lease: Parameters<typeof bindIntent>[1] = {botUserId:'U_NEW',refs:{workspace:'T_NEW'},
    baseUrl:'http://127.0.0.1:1',adminToken:'fixture-admin',botToken:'fixture-bot',adminUserId:'U_ADMIN',
    mcpLaunch:{command:'unused'},release:async()=>{}};
  const bound=bindIntent(intent,lease);
  assert.equal(bound.actorId,'U_NEW');assert.equal(bound.channel.workspaceId,'T_NEW');
  assert.deepEqual(bound.audienceIds,['T_NEW','T_EXTERNAL']);
  assert.equal(bound.text,intent.text);assert.equal(bound.reference,intent.reference);assert.equal(bound.scenarioDigest,intent.scenarioDigest);
  assert.equal(intent.actorId,'$bot');
});
