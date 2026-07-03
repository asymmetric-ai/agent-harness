# asym-agent-harness

Tools for watching an AI agent **break when its environment drifts** — the failure
that pages you at 2am and is almost impossible to reproduce. A bot removed from a
channel. A record deleted. A permission revoked. Most agent demos show the happy
path; this shows the other one.

Two things live here:

- **The harness** — a tiny, model-driven agent loop over *any* MCP server. Point it
  at an environment, give it a plain-English task, watch what it does. It's
  deliberately dumb: it knows nothing about scenarios or any product. CLI + library.
- **The playground** — a small web surface + run-service built on the harness. Pick a
  scenario (or paste your own), and it drives a high-fidelity SaaS clone into a
  drifted state through the clone's real API, then turns the agent loose against it
  and streams the result. Bring your own model key, or run on a budget-capped shared
  key.

## Why the error path is the point

The harness feeds tool results back to the model **including failures**. When the
environment rejects an action, the tool result is marked `is_error`, the model sees
it, and you watch it reason, adapt, retry, or give up honestly. The harness exits
non-zero if the agent gives up or hits any environment rejection, so it's usable as
a demo signal and in CI.

```
  task ──▶ harness ──listTools()──▶ ┌────────────┐
                                    │ MCP server │
   ┌──model tool-use (JSON schema)──┤  (clone)   │
   ▼                                └────────────┘
┌───────┐  tool_call ───▶ callTool() ──▶ result (incl. is_error)
│ model │◀── result ──────────────────────────────┘
└───────┘  loop until: final answer · step budget · token cap · abort
```

## Layout

```
src/
  mcp.ts            McpSession — connect to an MCP server (stdio), list/call tools
  providers.ts      Anthropic + OpenAI-compatible (OpenRouter/OpenAI) backends
  agent.ts          runAgent() — the loop (step cap, per-run token cap, abort)
  cli.ts            the `asym-agent` CLI
  index.ts          library entrypoint (runAgent, McpSession, providers)
  scenario/         declarative scenario spec + validator + per-clone allow-list
  run-service/      the playground: clone lease/pool, orchestration, HTTP/SSE, budget
web/index.html      the playground page
```

## The harness

### Install

```
npm install -g @asymmetric-ai/agent-harness   # or: bun add -g
```

Set one API key — the provider auto-detects:

```
export ANTHROPIC_API_KEY=sk-ant-...     # Anthropic Messages API
export OPENROUTER_API_KEY=sk-or-...     # any OpenRouter model (OpenAI-compatible)
export OPENAI_API_KEY=sk-...            # OpenAI (or OPENAI_BASE_URL for any compatible endpoint)
```

### CLI

```
asym-agent \
  --task "Post a one-line standup summary to the channel with id C123." \
  --mcp-command bun --mcp-args "src/index.ts" \
  --mcp-cwd /path/to/some/mcp-server \
  --env SOME_TOKEN=... \
  --model anthropic/claude-sonnet-4.5
```

You'll see each step: the agent's reasoning, every `→ tool_call`, and each result as
`✓ ok` or `✗ BLOCKED`. Against a drifted environment it ends with the agent reporting
it cannot finish, and why.

| Flag | Default | Meaning |
|------|---------|---------|
| `-t, --task` | (required) | plain-English task for the agent |
| `--mcp-command` | `bun` | executable that starts the MCP server |
| `--mcp-args` | `src/index.ts` | space-separated args for it |
| `--mcp-cwd` | cwd | working directory to launch from |
| `--env KEY=VAL` | — | extra env for the MCP server (repeatable) |
| `--provider` | auto | `anthropic` or `openai` (else detected from the key) |
| `-m, --model` | per-provider | model id (`anthropic/claude-sonnet-4.5` on OpenRouter, `claude-sonnet-4-6` on Anthropic, `gpt-4o` on OpenAI) |
| `--max-steps` | `8` | max agent turns before giving up |

### Library

```ts
import { McpSession, runAgent, OpenAiLlm } from '@asymmetric-ai/agent-harness';

const session = new McpSession({ command: 'bun', args: ['src/index.ts'], cwd, env });
await session.connect();
const tools = await session.listTools();
const llm = new OpenAiLlm('anthropic/claude-sonnet-4.5', tools, {
  apiKey: process.env.OPENROUTER_API_KEY!, baseURL: 'https://openrouter.ai/api/v1',
});
const result = await runAgent(session, llm, { task, maxSteps: 6, maxTokens: 40_000 }, (e) => console.log(e));
await session.close();
```

## The playground

The playground drives a clone into a drifted state through a **declarative scenario**,
then runs the agent against it. The run-service talks to the clone purely over its
HTTP/MCP API — it doesn't need the clone's source.

### Scenario spec

A scenario is JSON: setup steps (real clone RPCs, run as admin) + the agent's task.
No code. Anonymous input is safe because every step is checked against a per-clone
**allow-list** (only these methods, these args), with a step cap and a task-length cap.

```jsonc
{
  "id": "bot-evicted-private-channel",
  "clone": "slack",
  "seed": "acme-corp",
  "steps": [
    { "method": "conversations.create", "args": { "name": "incidents", "is_private": true } },
    { "method": "conversations.invite", "args": { "channel": "$1.channel.id", "users": "$bot" } },
    { "method": "conversations.kick",   "args": { "channel": "$1.channel.id", "user":  "$bot" } }
  ],
  "agent_task": "Post a one-line standup summary to the channel with id $1.channel.id."
}
```

Interpolation (the only dynamic forms): `$bot` / `$admin` (provisioned user ids) and
`$N.dotted.path` (a value from step N's response, 1-based). A bad token or missing
path fails loudly — a broken spec surfaces as a setup error, distinct from "the agent
broke."

### Run it locally

You need a clone running (it's separate — the run-service is an actor, not the
environment) and a model key.

```bash
# 1) start the run-service (from this repo)
PORT=4000 \
  SLACK_CLONE_URL=http://localhost:3001/api \
  SLACK_MCP_CWD=/path/to/slack-clone/mcp-server \
  DATABASE_URL=postgresql://... \
  bun run serve
# open http://localhost:4000 — edit the spec, paste your key, hit Run
```

`GET /` serves the page. `POST /run { spec, modelKey?, model?, provider?, baseURL? }`
streams the run as SSE (`RunEvent`s: validation → setup → agent → done). Paste a key
in the request (BYO), or leave it out to use the server's `ASYM_PLAYGROUND_KEY`.

### Safety (the shared key spends real money)

The run-service is built to be safe on a public, key-accepting surface:

- **Budget circuit-breaker** — a file-backed token ledger with a hard cap. When the
  shared key's budget is spent, live runs return `budget_exhausted` (degrade to
  BYO/replay) instead of spending more. BYO-key runs skip the meter.
- **Per-IP rate limit**, **per-run token cap**, **per-run wall-clock timeout**, and
  **abort-on-disconnect** (a closed tab reaps the run + the clone lease).
- The model key is used in-memory for the run and never stored or logged.

| Env | Default | Meaning |
|-----|---------|---------|
| `ASYM_PLAYGROUND_KEY` | — | shared model key (budgeted). Omit to require BYO. |
| `ASYM_PLAYGROUND_MODEL` / `_BASE_URL` | sonnet-4.5 / OpenRouter | server model + endpoint |
| `ASYM_PLAYGROUND_BUDGET_TOKENS` / `_BUDGET_FILE` | 2M / `./.playground-budget.json` | hard token cap + ledger file |
| `ASYM_PLAYGROUND_MAX_RUN_TOKENS` | 40000 | per-run token cap |
| `ASYM_PLAYGROUND_RUN_TIMEOUT_MS` | 120000 | per-run wall-clock timeout |
| `ASYM_PLAYGROUND_RATE_MAX` / `_RATE_WINDOW_MS` | 5 / 60000 | per-IP rate limit |
| `SLACK_CLONE_URL`, `SLACK_MCP_CWD`, `DATABASE_URL` | — | how to reach + launch the clone |

## Status

Early. Working and tested: the harness (CLI + library), the scenario spec + validator
+ allow-list, the run orchestration + HTTP/SSE server + page, and the budget/abuse
guards. **Not yet built:** instant-replay (pre-rendered transcripts for a zero-cost
whoa), a production warm clone pool with recycle-per-run (the included `LocalClonePool`
is a dev stand-in), and a hosted deploy. Only the Slack clone is wired today.

## License

Apache-2.0.
