import { McpSession } from '../mcp.js';
import { runAgent, type StepEvent } from '../agent.js';
import { AnthropicLlm, OpenAiLlm, type Llm } from '../providers.js';
import { validateSpec, type ValidationError } from '../scenario/validate.js';
import { runScenarioSetup } from '../scenario/runner.js';
import { resolveText } from '../scenario/interpolate.js';
import { ALLOWLISTS } from '../scenario/slack.js';
import type { ScenarioSpec } from '../scenario/spec.js';
import type { CloneLease } from './clone.js';

/** One event in a run's stream — validation, setup, agent, or terminal. */
export type RunEvent =
  | { kind: 'validation_failed'; errors: ValidationError[] }
  | { kind: 'setup'; step: number; method: string; ok: boolean; error?: string }
  | { kind: 'setup_failed'; step?: number; error: string }
  | { kind: 'agent'; event: StepEvent }
  | { kind: 'budget_exhausted'; message: string }
  | { kind: 'done'; completed: boolean; toolErrors: number; tokens: number };

export interface ModelConfig {
  apiKey: string;
  model: string;
  /** Set for OpenAI-compatible providers (OpenRouter, OpenAI). Omit for Anthropic. */
  baseURL?: string;
  provider: 'anthropic' | 'openai';
}

export interface RunOptions {
  maxSteps?: number;
  /** Per-run token cap; the run stops if the agent exceeds it. */
  maxTokens?: number;
  /** Abort the run (timeout / client disconnect). */
  signal?: AbortSignal;
}

/**
 * The full run path: validate the spec → run its setup against a leased clone as
 * admin → point the agent (harness) at the clone's MCP and stream what it does.
 * Distinct failure surfaces: validation_failed / setup_failed (spec errors) vs the
 * agent's own tool errors (the demo). The caller owns the lease lifecycle and MUST
 * release() it (recycle) in a finally — orchestrate does not, so an SSE disconnect
 * can still trigger cleanup upstream.
 */
export async function runScenario(
  spec: ScenarioSpec,
  lease: CloneLease,
  model: ModelConfig,
  opts: RunOptions,
  onEvent: (e: RunEvent) => void,
): Promise<void> {
  const allow = ALLOWLISTS[spec.clone];
  if (!allow) {
    onEvent({ kind: 'validation_failed', errors: [{ message: `unknown clone: ${spec.clone}` }] });
    return;
  }
  const v = validateSpec(spec, allow);
  if (!v.ok) {
    onEvent({ kind: 'validation_failed', errors: v.errors });
    return;
  }

  const setup = await runScenarioSetup(spec, {
    baseUrl: lease.baseUrl,
    adminToken: lease.adminToken,
    botUserId: lease.botUserId,
    adminUserId: lease.adminUserId,
  });
  for (const s of setup.steps) {
    onEvent({ kind: 'setup', step: s.step, method: s.method, ok: s.ok, error: s.error });
  }
  if (!setup.ok) {
    onEvent({ kind: 'setup_failed', step: setup.failedStep, error: `setup step ${setup.failedStep} failed` });
    return;
  }

  const session = new McpSession(lease.mcpLaunch);
  await session.connect();
  try {
    const tools = await session.listTools();
    const llm: Llm =
      model.provider === 'anthropic'
        ? new AnthropicLlm(model.model, tools, { apiKey: model.apiKey, signal: opts.signal })
        : new OpenAiLlm(model.model, tools, { apiKey: model.apiKey, baseURL: model.baseURL, signal: opts.signal });
    // Resolve interpolation tokens in the task (e.g. "$1.channel.id") so the agent
    // gets the id of the resource setup created — it can't discover a private
    // channel it was evicted from.
    const task = resolveText(spec.agent_task, {
      botUserId: lease.botUserId,
      adminUserId: lease.adminUserId,
      stepResponses: setup.responses,
    });
    const result = await runAgent(
      session,
      llm,
      { task, maxSteps: opts.maxSteps ?? 6, maxTokens: opts.maxTokens },
      (event) => onEvent({ kind: 'agent', event }),
    );
    onEvent({ kind: 'done', completed: result.completed, toolErrors: result.toolErrors, tokens: result.tokens });
  } finally {
    await session.close().catch(() => {});
  }
}
