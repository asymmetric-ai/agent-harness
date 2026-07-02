import type { McpSession } from './mcp.js';
import type { Llm } from './providers.js';

export interface AgentOptions {
  task: string;
  maxSteps: number;
  /** Per-run token cap (input+output). When exceeded, the run stops. Omit = no cap. */
  maxTokens?: number;
}

export interface StepEvent {
  kind: 'thinking' | 'tool_call' | 'tool_result' | 'final' | 'gave_up';
  text: string;
  tool?: string;
  isError?: boolean;
}

export interface AgentResult {
  completed: boolean;
  steps: number;
  toolErrors: number;
  /** Total tokens consumed this run — recorded to the budget ledger. */
  tokens: number;
}

/**
 * Run a model-driven loop: the model picks tool calls, the harness executes them
 * against the MCP server, and the results (including errors) flow back until the
 * model produces a final answer, the step budget runs out, the per-run token cap
 * is hit, or the run is aborted (timeout / client disconnect via the provider's
 * AbortSignal). The error path is the point: when the environment has drifted,
 * tool results come back is_error and you watch the agent cope.
 */
export async function runAgent(
  session: McpSession,
  llm: Llm,
  opts: AgentOptions,
  onEvent: (e: StepEvent) => void,
): Promise<AgentResult> {
  llm.start(opts.task);
  let toolErrors = 0;
  let tokens = 0;

  for (let step = 1; step <= opts.maxSteps; step++) {
    let turn;
    try {
      turn = await llm.next();
    } catch (err) {
      // AbortError (timeout / disconnect) or a provider error — stop cleanly.
      const aborted = (err as Error)?.name === 'AbortError';
      onEvent({ kind: 'gave_up', text: aborted ? 'Run aborted.' : `Model error: ${(err as Error).message}` });
      return { completed: false, steps: step, toolErrors, tokens };
    }
    tokens += turn.usage.input + turn.usage.output;
    for (const t of turn.text) onEvent({ kind: 'thinking', text: t });

    if (turn.toolCalls.length === 0) {
      onEvent({ kind: 'final', text: turn.text.join('\n') || '(no final message)' });
      return { completed: true, steps: step, toolErrors, tokens };
    }

    if (opts.maxTokens && tokens >= opts.maxTokens) {
      onEvent({ kind: 'gave_up', text: `Per-run token cap (${opts.maxTokens}) reached.` });
      return { completed: false, steps: step, toolErrors, tokens };
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
  return { completed: false, steps: opts.maxSteps, toolErrors, tokens };
}
