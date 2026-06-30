#!/usr/bin/env node
import { Command } from 'commander';
import { McpSession, type McpLaunch } from './mcp.js';
import { runAgent, type StepEvent } from './agent.js';

const program = new Command();

program
  .name('asym-agent')
  .description(
    'Run a model-driven agent loop over any MCP server. Give it a task; watch what happens when the environment drifts.',
  )
  .requiredOption('-t, --task <text>', 'the plain-English task for the agent')
  .option('--mcp-command <cmd>', 'executable that starts the MCP server', 'bun')
  .option('--mcp-args <args>', 'space-separated args for the MCP command', 'src/index.ts')
  .option('--mcp-cwd <dir>', 'working directory to launch the MCP server from', process.cwd())
  .option(
    '--env <KEY=VAL>',
    'extra env var for the MCP server (repeatable)',
    (kv: string, acc: string[]) => {
      acc.push(kv);
      return acc;
    },
    [] as string[],
  )
  .option('-m, --model <id>', 'Anthropic model id', 'claude-sonnet-4-6')
  .option('--max-steps <n>', 'max agent turns before giving up', (v) => parseInt(v, 10), 8)
  .action(async (opts) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY is not set. Export it and try again.');
      process.exit(2);
    }

    const env: Record<string, string> = {};
    for (const kv of opts.env as string[]) {
      const eq = kv.indexOf('=');
      if (eq === -1) {
        console.error(`--env "${kv}" must be KEY=VALUE`);
        process.exit(2);
      }
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }

    const launch: McpLaunch = {
      command: opts.mcpCommand,
      args: (opts.mcpArgs as string).split(' ').filter(Boolean),
      cwd: opts.mcpCwd,
      env,
    };

    const session = new McpSession(launch);
    try {
      await session.connect();
      const tools = await session.listTools();
      line(`connected — ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
      line(`task: ${opts.task}`);
      console.log('');

      const result = await runAgent(session, tools, {
        task: opts.task,
        model: opts.model,
        maxSteps: opts.maxSteps,
      }, render);

      console.log('');
      line(
        `done — ${result.completed ? 'agent finished' : 'gave up'}, ` +
          `${result.steps} steps, ${result.toolErrors} tool error(s)`,
      );
      // Exit non-zero when the agent could not complete OR hit environment
      // rejections — useful as a demo signal and in CI.
      process.exit(result.completed && result.toolErrors === 0 ? 0 : 1);
    } finally {
      await session.close().catch(() => {});
    }
  });

function line(s: string): void {
  console.log(`\x1b[2m::\x1b[0m ${s}`);
}

function render(e: StepEvent): void {
  switch (e.kind) {
    case 'thinking':
      console.log(`\x1b[36magent>\x1b[0m ${e.text}`);
      break;
    case 'tool_call':
      console.log(`  \x1b[35m→ ${e.tool}\x1b[0m ${e.text}`);
      break;
    case 'tool_result':
      if (e.isError) {
        console.log(`  \x1b[31m✗ ${e.tool} BLOCKED\x1b[0m ${e.text.replace(/\s+/g, ' ').slice(0, 120)}`);
      } else {
        console.log(`  \x1b[32m✓ ${e.tool} ok\x1b[0m ${e.text.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
      break;
    case 'final':
      console.log(`\x1b[36magent (final)>\x1b[0m ${e.text}`);
      break;
    case 'gave_up':
      console.log(`\x1b[33m${e.text}\x1b[0m`);
      break;
  }
}

program.parseAsync().catch((err) => {
  console.error('agent-harness error:', err);
  process.exit(1);
});
