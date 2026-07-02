import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { McpTool } from './mcp.js';

/** A single model turn, normalized across providers. */
export interface LlmTurn {
  /** Assistant prose emitted this turn (may be empty). */
  text: string[];
  /** Tool calls the model wants executed. Empty ⇒ the model is done. */
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  /** Token usage for THIS turn — drives per-run caps and the budget ledger. */
  usage: { input: number; output: number };
}

export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
}

/**
 * Provider-neutral conversation. The harness loop drives it: seed the task, ask
 * for the next turn, feed tool results back, repeat. Each implementation owns its
 * own message history so the loop stays provider-agnostic.
 */
export interface Llm {
  readonly label: string;
  start(task: string): void;
  next(): Promise<LlmTurn>;
  addToolResults(results: ToolResult[]): void;
}

const SYSTEM = `You are an autonomous operations agent acting inside a real software environment through the tools you've been given. You did not configure this environment and cannot see its internal state except through tool calls.

Do the task. Use the tools. If a tool call fails, read the error, reason about what it means about the environment, and adapt — retry differently, try a recovering action, or report clearly that you cannot complete the task and why. Do not pretend a failed action succeeded. Be concise.`;

// --- Anthropic (native Messages API) ---

export class AnthropicLlm implements Llm {
  readonly label: string;
  private client: Anthropic;
  private model: string;
  private tools: Anthropic.Tool[];
  private messages: Anthropic.MessageParam[] = [];
  private signal?: AbortSignal;

  constructor(model: string, tools: McpTool[], opts?: { apiKey?: string; baseURL?: string; signal?: AbortSignal }) {
    this.client = new Anthropic({ apiKey: opts?.apiKey, baseURL: opts?.baseURL });
    this.signal = opts?.signal;
    this.model = model;
    this.label = `anthropic:${model}`;
    this.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }

  start(task: string): void {
    this.messages = [{ role: 'user', content: task }];
  }

  async next(): Promise<LlmTurn> {
    const resp = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM,
        tools: this.tools,
        messages: this.messages,
      },
      { signal: this.signal },
    );
    this.messages.push({ role: 'assistant', content: resp.content });
    const text: string[] = [];
    const toolCalls: LlmTurn['toolCalls'] = [];
    for (const block of resp.content) {
      if (block.type === 'text' && block.text.trim()) text.push(block.text.trim());
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown> });
      }
    }
    return {
      text,
      toolCalls,
      usage: { input: resp.usage?.input_tokens ?? 0, output: resp.usage?.output_tokens ?? 0 },
    };
  }

  addToolResults(results: ToolResult[]): void {
    this.messages.push({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError,
      })),
    });
  }
}

// --- OpenAI-compatible (OpenAI, OpenRouter, or any compatible endpoint) ---

export class OpenAiLlm implements Llm {
  readonly label: string;
  private client: OpenAI;
  private model: string;
  private tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  private signal?: AbortSignal;

  constructor(model: string, tools: McpTool[], opts: { apiKey: string; baseURL?: string; signal?: AbortSignal }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.signal = opts.signal;
    this.model = model;
    this.label = `openai-compatible:${model}${opts.baseURL ? ` @ ${opts.baseURL}` : ''}`;
    this.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));
  }

  start(task: string): void {
    this.messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: task },
    ];
  }

  async next(): Promise<LlmTurn> {
    const resp = await this.client.chat.completions.create(
      {
        model: this.model,
        max_tokens: 1024,
        tools: this.tools,
        messages: this.messages,
      },
      { signal: this.signal },
    );
    const usage = {
      input: resp.usage?.prompt_tokens ?? 0,
      output: resp.usage?.completion_tokens ?? 0,
    };
    const msg = resp.choices[0]?.message;
    if (!msg) return { text: ['(no response)'], toolCalls: [], usage };
    this.messages.push(msg);
    const text: string[] = [];
    if (msg.content && msg.content.trim()) text.push(msg.content.trim());
    const toolCalls: LlmTurn['toolCalls'] = [];
    for (const tc of msg.tool_calls ?? []) {
      if (tc.type !== 'function') continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, args });
    }
    return { text, toolCalls, usage };
  }

  addToolResults(results: ToolResult[]): void {
    for (const r of results) {
      // OpenAI tool messages have no error flag; prefix so the model sees failure.
      this.messages.push({
        role: 'tool',
        tool_call_id: r.id,
        content: r.isError ? `ERROR: ${r.content}` : r.content,
      });
    }
  }
}
