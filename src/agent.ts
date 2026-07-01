import type { McpSession } from './mcp.js';
import type { Llm } from './providers.js';

export interface AgentOptions {
  task: string;
  maxSteps: number;
}

export interface StepEvent {
  kind: 'thinking' | 'tool_call' | 'tool_result' | 'final' | 'gave_up';
  text: string;
  tool?: string;
  isError?: boolean;
}

/**
 * Run a model-driven loop: the model picks tool calls, the harness executes them
 * against the MCP server, and the results (including errors) flow back until the
 * model produces a final answer or the step budget runs out.
 *
 * The whole point is the error path: when the environment has drifted (a resource
 * the agent expects is gone), tool results come back is_error and you watch the
 * agent try to cope in real time.
 */
export async function runAgent(
  session: McpSession,
  llm: Llm,
  opts: AgentOptions,
  onEvent: (e: StepEvent) => void,
): Promise<{ completed: boolean; steps: number; toolErrors: number }> {
  llm.start(opts.task);
  let toolErrors = 0;

  for (let step = 1; step <= opts.maxSteps; step++) {
    const turn = await llm.next();
    for (const t of turn.text) onEvent({ kind: 'thinking', text: t });

    if (turn.toolCalls.length === 0) {
      onEvent({ kind: 'final', text: turn.text.join('\n') || '(no final message)' });
      return { completed: true, steps: step, toolErrors };
    }

    const results = [];
    for (const call of turn.toolCalls) {
      onEvent({ kind: 'tool_call', tool: call.name, text: JSON.stringify(call.args) });
      const outcome = await session.callTool(call.name, call.args);
      if (outcome.isError) toolErrors++;
      onEvent({ kind: 'tool_result', tool: call.name, text: outcome.text, isError: outcome.isError });
      results.push({ id: call.id, content: outcome.text, isError: outcome.isError });
    }
    llm.addToolResults(results);
  }

  onEvent({ kind: 'gave_up', text: `Step budget (${opts.maxSteps}) exhausted before the task completed.` });
  return { completed: false, steps: opts.maxSteps, toolErrors };
}
