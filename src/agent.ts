import Anthropic from '@anthropic-ai/sdk';
import type { McpSession, McpTool } from './mcp.js';

export interface AgentOptions {
  task: string;
  model: string;
  maxSteps: number;
  /** Optional extra system guidance prepended to the default operator framing. */
  systemExtra?: string;
}

export interface StepEvent {
  kind: 'thinking' | 'tool_call' | 'tool_result' | 'final' | 'gave_up';
  text: string;
  /** For tool_call/tool_result: the tool name. */
  tool?: string;
  /** For tool_result: whether the environment rejected the action. */
  isError?: boolean;
}

const DEFAULT_SYSTEM = `You are an autonomous operations agent acting inside a real software environment through the tools you've been given. You did not configure this environment and you cannot see its internal state except through tool calls.

Do the task. Use the tools. If a tool call fails, read the error, reason about what it means about the environment, and adapt — retry differently, try a recovering action, or report clearly that you cannot complete the task and why. Do not pretend a failed action succeeded. Be concise.`;

function toAnthropicTools(tools: McpTool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Run a model-driven loop: the model picks tool calls, the harness executes them
 * against the MCP server, and the results (including errors) flow back until the
 * model produces a final answer or the step budget runs out.
 *
 * The whole point of the harness is what happens on the error path: when the
 * environment has drifted (a resource the agent expects is gone), tool results
 * come back is_error and you watch the agent try to cope in real time.
 */
export async function runAgent(
  session: McpSession,
  tools: McpTool[],
  opts: AgentOptions,
  onEvent: (e: StepEvent) => void,
): Promise<{ completed: boolean; steps: number; toolErrors: number }> {
  const client = new Anthropic();
  const anthropicTools = toAnthropicTools(tools);
  const system = opts.systemExtra ? `${DEFAULT_SYSTEM}\n\n${opts.systemExtra}` : DEFAULT_SYSTEM;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.task }];
  let toolErrors = 0;

  for (let step = 1; step <= opts.maxSteps; step++) {
    const resp = await client.messages.create({
      model: opts.model,
      max_tokens: 1024,
      system,
      tools: anthropicTools,
      messages,
    });

    // Surface any prose the model emitted this turn.
    for (const block of resp.content) {
      if (block.type === 'text' && block.text.trim()) {
        onEvent({ kind: 'thinking', text: block.text.trim() });
      }
    }

    messages.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason !== 'tool_use') {
      const finalText = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      onEvent({ kind: 'final', text: finalText || '(no final message)' });
      return { completed: true, steps: step, toolErrors };
    }

    // Execute every tool call the model requested this turn.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      const args = (block.input ?? {}) as Record<string, unknown>;
      onEvent({ kind: 'tool_call', tool: block.name, text: JSON.stringify(args) });

      const outcome = await session.callTool(block.name, args);
      if (outcome.isError) toolErrors++;
      onEvent({ kind: 'tool_result', tool: block.name, text: outcome.text, isError: outcome.isError });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: outcome.text,
        is_error: outcome.isError,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  onEvent({
    kind: 'gave_up',
    text: `Step budget (${opts.maxSteps}) exhausted before the task completed.`,
  });
  return { completed: false, steps: opts.maxSteps, toolErrors };
}
