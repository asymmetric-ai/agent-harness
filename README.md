# asym-agent-harness

A tiny, model-driven agent loop over **any** MCP server. Point it at an environment, give it a plain-English task, and watch what the agent actually does — especially when reality drifts out from under it.

It is deliberately dumb. It does not know about scenarios, fixtures, or any particular product. It connects to an MCP server, hands the server's tools to a model, runs the loop, and prints the transcript. That is the whole thing.

## Why it exists

Most agent demos show the happy path: the agent does the task, everything works. The interesting question is the other one — **what does your agent do when the environment isn't what it expected?** A channel the bot got removed from. A record that was deleted. A permission that was revoked. Those are the failures that page you at 2am, and they're exactly what's hard to reproduce.

This harness is the actor half of that test. You drive an environment into a messy state by other means (any MCP server, any setup), then turn the agent loose and observe it hit the wall in real time.

## How it works

```
  you ──task──▶ harness
                  │  listTools()
                  ▼
            ┌───────────────┐      tools as
            │   MCP server  │◀──── Anthropic tool-use
            └───────────────┘          │
                  ▲                     ▼
                  │ callTool()     ┌──────────┐
                  └────────────────│  model   │  loop until done
                   result          └──────────┘  or step budget
                  (incl. is_error)
```

1. Spawn an MCP server (`--mcp-command` / `--mcp-args` / `--mcp-cwd`, plus `--env` for tokens).
2. List its tools and pass them to the model as tool-use definitions (the MCP `inputSchema` is JSON Schema, handed through unchanged).
3. Run the loop: the model picks tool calls, the harness executes them against the server, and results flow back — **including errors**. When the environment rejects an action, the tool result is marked `is_error`, the model sees the failure, and you watch it adapt, retry, or give up.

The error path is the point. The harness exits non-zero if the agent gives up or hits any environment rejection, so it's usable as a demo signal and in CI.

## Install

```
npm install -g @asymmetric-ai/agent-harness   # or: bun add -g
```

Set one API key — the provider is auto-detected:

```
export ANTHROPIC_API_KEY=sk-ant-...      # Anthropic Messages API (default)
# or
export OPENROUTER_API_KEY=sk-or-...      # any OpenRouter model (OpenAI-compatible)
# or
export OPENAI_API_KEY=sk-...             # OpenAI (or set OPENAI_BASE_URL for any compatible endpoint)
```

Pick the model with `--model` (e.g. `anthropic/claude-sonnet-4.5` on OpenRouter,
`claude-sonnet-4-6` on Anthropic, `gpt-4o` on OpenAI) or force a backend with
`--provider anthropic|openai`.

## Use

```
asym-agent \
  --task "Post a one-line standup summary to the #incidents channel." \
  --mcp-command bun \
  --mcp-args "src/index.ts" \
  --mcp-cwd /path/to/some/mcp-server \
  --env SOME_TOKEN=... \
  --model claude-sonnet-4-6 \
  --max-steps 8
```

You'll see each step: the agent's reasoning, every `→ tool_call`, and each result as `✓ ok` or `✗ BLOCKED`. A run against a drifted environment ends with the agent reporting it cannot complete the task and why.

## Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `-t, --task` | (required) | plain-English task for the agent |
| `--mcp-command` | `bun` | executable that starts the MCP server |
| `--mcp-args` | `src/index.ts` | space-separated args for it |
| `--mcp-cwd` | cwd | working directory to launch from |
| `--env KEY=VAL` | — | extra env for the MCP server (repeatable) |
| `-m, --model` | `claude-sonnet-4-6` | Anthropic model id |
| `--max-steps` | `8` | max agent turns before giving up |

Works with any MCP server that speaks stdio, and any of Anthropic / OpenRouter /
OpenAI-compatible backends.

## License

Apache-2.0.
