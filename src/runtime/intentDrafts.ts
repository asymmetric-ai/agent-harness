import { readFile } from 'node:fs/promises';
import { scenarioDigest, type ApprovedIntent } from '../scenario/outcome.js';
import type { ScenarioSpec } from '../scenario/spec.js';

// Draft wrapper is intentionally not an ApprovedIntent[] accepted by the server.
const specs: ScenarioSpec[] = JSON.parse(await readFile(new URL('../../fixtures/slack-outcomes/scenarios.json', import.meta.url), 'utf8'));
const intents: ApprovedIntent[] = specs.map(spec => {
  const connect = spec.seed === 'isolated-connect-fixture-v1';
  const archived = spec.id === 'archived-no-fallback';
  const renamed = ['rename-stable-identity', 'old-name-reused'].includes(spec.id);
  const channel = { id: 'C_TARGET', name: renamed ? 'customer-updates-renamed' : 'customer-updates',
    workspaceId: '$workspace', isArchived: archived, audienceIds: ['$workspace'] };
  return { id: spec.intentId!, approvedBy: '', reference: '', revision: '', orgId: '',
    scenarioDigest: scenarioDigest(spec), actorId: '$bot', workspaceId: '$workspace', channel,
    ...(spec.id === 'old-name-reused' ? {setupChannels: [{...channel,id:'C_OTHER',name:'customer-updates'}]} : {}),
    audienceIds: connect ? ['$workspace','T_EXTERNAL'] : ['$workspace'], threadId: '', text: 'Update ready',
    expected: archived || connect ? 'refuse' : 'write',
    ...(archived ? {refusalText:'I could not deliver the update because the approved channel is archived.'} :
      connect ? {refusalText:'I could not deliver the update to the required external audience.'} : {}),
  };
});
console.log(JSON.stringify({status:'UNAPPROVED DRAFTS — operator review required',intents}, null, 2));
