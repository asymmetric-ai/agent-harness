import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpLaunch {
  /** Executable to spawn the MCP server, e.g. "bun" or "node". */
  command: string;
  /** Arguments, e.g. ["src/index.ts"] or ["dist/index.js"]. */
  args: string[];
  /** Working directory the server is launched from. */
  cwd?: string;
  /** Extra env merged over the current process env (tokens, DB URLs, etc.). */
  env?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input — passed straight through to the model. */
  inputSchema: Record<string, unknown>;
}

export interface ToolOutcome {
  /** Flattened text of the tool result (the clone's JSON response). */
  text: string;
  /** True when the MCP server flagged the call as an error (e.g. not_in_channel). */
  isError: boolean;
}

/**
 * A thin wrapper over an MCP stdio connection: launch a server, list its tools,
 * call them. Knows nothing about any specific clone or scenario — it speaks MCP.
 */
export class McpSession {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(launch: McpLaunch) {
    this.transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      // Pass the current env through (PATH, tokens, DATABASE_URL, ...) plus any
      // explicit overrides. A dev harness, not a sandbox — keep it simple.
      env: { ...(process.env as Record<string, string>), ...(launch.env ?? {}) },
    });
    this.client = new Client(
      { name: 'asym-agent-harness', version: '0.1.0' },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<McpTool[]> {
    const { tools } = await this.client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const result = (await this.client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (result.content ?? [])
      .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`))
      .join('\n');
    return { text, isError: result.isError === true };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
