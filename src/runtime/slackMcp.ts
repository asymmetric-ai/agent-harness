import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { cloneCall } from '../scenario/cloneClient.js';
const url = new URL(process.env.SLACK_CLONE_URL ?? '');
if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || !process.env.SLACK_MCP_TOKEN)
  throw Error('isolated_clone_configuration_required');
const methods: Record<string, {method: string; fields: Record<string,string>; required: string[]}> = {
  slack_list_channels: { method: 'conversations.list', fields: {cursor:'string',limit:'number'}, required: [] },
  slack_get_channel_info: { method: 'conversations.info', fields: {channel_id:'string'}, required: ['channel_id'] },
  slack_get_channel_history: { method: 'conversations.history', fields: {channel_id:'string',cursor:'string',limit:'number'}, required: ['channel_id'] },
  slack_post_message: { method: 'chat.postMessage', fields: {channel_id:'string',text:'string'}, required: ['channel_id','text'] },
  slack_reply_to_thread: { method: 'chat.postMessage', fields: {channel_id:'string',text:'string',thread_ts:'string'}, required: ['channel_id','text','thread_ts'] },
  slack_get_thread_replies: { method: 'conversations.replies', fields: {channel_id:'string',thread_ts:'string'}, required: ['channel_id','thread_ts'] },
  slack_auth_test: { method: 'auth.test', fields: {}, required: [] },
};
const server = new Server({name:'isolated-slack-outcome-tools',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: Object.entries(methods).map(([name,m]) => ({
  name, description: `Call ${m.method} on this isolated Slack clone.`,
  inputSchema: {type:'object',properties:Object.fromEntries(Object.entries(m.fields).map(([key,type])=>[key,{type}])), required:m.required, additionalProperties:false},
}))}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const m = methods[request.params.name]; const args = request.params.arguments ?? {};
  if (!m || Object.keys(args).some(k => !m.fields[k]) || m.required.some(k => typeof args[k] !== m.fields[k]))
    return {isError:true,content:[{type:'text',text:'invalid_tool_arguments'}]};
  const body: Record<string,unknown> = {...args};
  if ('channel_id' in body) {body.channel=body.channel_id;delete body.channel_id;}
  if (m.method === 'conversations.replies') {body.ts=body.thread_ts;delete body.thread_ts;}
  try {
    const result = await cloneCall(url.href.replace(/\/$/,''),m.method,process.env.SLACK_MCP_TOKEN!,body);
    return {isError:!result.ok,content:[{type:'text',text:JSON.stringify(result.body)}]};
  } catch {return {isError:true,content:[{type:'text',text:'clone_transport_unavailable'}]};}
});
await server.connect(new StdioServerTransport());
