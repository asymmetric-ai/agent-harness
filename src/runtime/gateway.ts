import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { CloneControl } from './asym.js';
import { sqlLiteral } from './audit.js';

/** Persisted Connect model for the published clone, which has no native sharing columns. */
export const sharingSql = `CREATE SCHEMA harness_runtime;
REVOKE ALL ON SCHEMA harness_runtime FROM PUBLIC;
CREATE TABLE harness_runtime.audience(channel_id text PRIMARY KEY REFERENCES public.channels(id) ON DELETE CASCADE,teams jsonb NOT NULL);
REVOKE ALL ON harness_runtime.audience FROM PUBLIC;
INSERT INTO harness_runtime.audience SELECT id,jsonb_build_array(workspace_id) FROM public.channels;
CREATE VIEW harness_runtime.channels AS SELECT c.id,c.name,c.workspace_id,c.is_archived,
 jsonb_array_length(a.teams)>1 AS is_ext_shared,a.teams AS shared_team_ids FROM public.channels c
 JOIN harness_runtime.audience a ON a.channel_id=c.id;`;

export async function startGateway(control: CloneControl, id: string, upstream: string,
  adminToken: string, botToken: string, externalTeam?: string) {
  const externalToken = randomUUID();
  const state = async (channel: string) => {
    const rows=await control.query(id,`SELECT * FROM harness_runtime.channels WHERE id=${sqlLiteral(channel)}`);
    return rows[0];
  };
  const server=createServer(async(req,res)=>{
    const respond=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
    try {
      if(req.method!=='POST'||!req.url||!/^\/[a-zA-Z.]+$/.test(req.url))return respond(404,{ok:false,error:'unsupported_method'});
      const token=req.headers.authorization?.replace(/^Bearer /,'');
      const external=token===externalToken && !!externalTeam;
      if(token!==adminToken&&token!==botToken&&!external)return respond(401,{ok:false,error:'invalid_auth'});
      let text='';for await(const chunk of req){text+=chunk;if(text.length>64000)return respond(413,{ok:false,error:'request_too_large'});}
      const args=JSON.parse(text||'{}');
      const method=req.url.slice(1);
      const channelId=args.channel??args.channel_id;
      if(external){
        if(!['conversations.info','conversations.history'].includes(method)||typeof channelId!=='string')return respond(403,{ok:false,error:'external_read_only'});
        const channel=await state(channelId);
        if(!channel||!Array.isArray(channel.shared_team_ids)||!channel.shared_team_ids.includes(externalTeam))return respond(403,{ok:false,error:'not_in_channel'});
      }
      if(method==='admin.conversations.disconnectShared'){
        if(token!==adminToken)return respond(403,{ok:false,error:'missing_scope'});
        if(typeof args.channel_id!=='string'||!Array.isArray(args.leaving_team_ids)||args.leaving_team_ids.length!==1||
            args.leaving_team_ids[0]!==externalTeam)return respond(400,{ok:false,error:'invalid_arguments'});
        const current=await state(args.channel_id);
        if(!current||current.is_ext_shared!==true||current.workspace_id===externalTeam)return respond(409,{ok:false,error:'connect_fixture_unverified'});
        // Compare-and-swap the exact two-team fixture; concurrent changes cannot
        // silently turn an acknowledged disconnect into a different transition.
        const expected=JSON.stringify([current.workspace_id,externalTeam]);
        await control.write(id,`UPDATE harness_runtime.audience SET teams=jsonb_build_array(${sqlLiteral(String(current.workspace_id))})
          WHERE channel_id=${sqlLiteral(args.channel_id)} AND teams=${sqlLiteral(expected)}::jsonb`);
        const after=await state(args.channel_id);
        if(after?.is_ext_shared!==false)return respond(409,{ok:false,error:'connect_transition_unverified'});
        return respond(200,{ok:true});
      }
      if(!['conversations.info','conversations.list','conversations.history','conversations.replies','conversations.rename',
        'conversations.archive','chat.postMessage','auth.test'].includes(method))return respond(404,{ok:false,error:'unsupported_method'});
      const upstreamResponse=await fetch(`${upstream}/${method}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${external?adminToken:token}`},
        body:JSON.stringify(args),signal:AbortSignal.timeout(15000)});
      const body=await upstreamResponse.json() as Record<string,unknown>;
      const enrich=async(raw:unknown)=>{
        if(!raw||typeof raw!=='object')return raw;
        const row=raw as Record<string,unknown>;
        if(typeof row.id!=='string')return row;
        const audience=await state(row.id);if(!audience)throw Error('audience_state_unverified');
        return {...row,is_ext_shared:audience.is_ext_shared,shared_team_ids:audience.shared_team_ids,context_team_id:audience.workspace_id};
      };
      if(body.ok===true){
        if(body.channel)body.channel=await enrich(body.channel);
        if(Array.isArray(body.channels))body.channels=await Promise.all(body.channels.map(enrich));
      }
      respond(upstreamResponse.status,body);
    }catch{respond(502,{ok:false,error:'clone_gateway_unavailable'});}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {baseUrl,close:()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())),
    externalRead:async(channel:string)=>{
      const response=await fetch(baseUrl+'/conversations.history',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+externalToken},body:JSON.stringify({channel}),signal:AbortSignal.timeout(15000)});
      return {status:response.status,body:await response.json() as Record<string,unknown>};
    }};
}
