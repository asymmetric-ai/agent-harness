// The declarative scenario-spec — the public contract a playground visitor
// authors (paste-your-own) and curated scenarios use. It is JSON: setup steps
// (real clone RPCs, run as admin) + the agent's task. NOT code. The closed clone
// re-validates server-side against the same allow-list (defense in depth).
//
// Drift note: today "drift" is expressed as SETUP (e.g. invite then kick a bot),
// which the agent then hits. True mid-run mutation (drift WHILE the agent works)
// is a future step kind; see the eng plan's unresolved "drift primitive".

export interface ScenarioStep {
  /** Clone RPC method; MUST be in the clone's allow-list. */
  method: string;
  /** Arg values; string values may be interpolation tokens (see grammar below). */
  args: Record<string, unknown>;
}

export interface ScenarioSpec {
  id: string;
  /** Clone template, e.g. "slack". */
  clone: string;
  /** Named fixture to seed before steps run. */
  seed?: string;
  /** Setup steps, run in order as the admin/creator. */
  steps: ScenarioStep[];
  /** The task handed to the agent after setup. */
  agent_task: string;
}

export type ArgType = 'string' | 'boolean' | 'number' | 'user-ref' | 'channel-ref';

export interface ArgSchema {
  type: ArgType;
  required?: boolean;
}

export interface MethodSpec {
  args: Record<string, ArgSchema>;
}

/** Per-clone allow-list: the ONLY methods a scenario may call, with arg schemas. */
export type AllowList = Record<string, MethodSpec>;

/** Hard caps — bound abuse for anonymous authoring. */
export const MAX_STEPS = 12;
export const MAX_TASK_CHARS = 500;

/**
 * Interpolation grammar (the ONLY dynamic forms allowed in a string arg):
 *   $bot            → the provisioned bot user's id
 *   $admin          → the admin/creator user's id
 *   $N.dotted.path  → a value from step N's ({ok}) response (1-based), e.g. $1.channel.id
 * A token that starts with `$` but doesn't match is a validation error (no
 * arbitrary expressions). Missing paths fail loudly at run time, not silently.
 */
export const INTERP_TOKEN = /^\$(bot|admin|\d+\.[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)$/;
