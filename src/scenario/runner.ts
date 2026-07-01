import type { ScenarioSpec } from './spec.js';
import { resolveArgs, type InterpContext } from './interpolate.js';
import { cloneCall } from './cloneClient.js';

export interface SetupStepResult {
  step: number;
  method: string;
  ok: boolean;
  error?: string;
}

export interface SetupResult {
  ok: boolean;
  steps: SetupStepResult[];
  /** Each successful step's response body, in order — for post-setup interpolation. */
  responses: Record<string, unknown>[];
  /** 1-based index of the step that failed, if any. */
  failedStep?: number;
}

export interface SetupOptions {
  baseUrl: string;
  adminToken: string;
  botUserId: string;
  adminUserId: string;
}

/**
 * Drive a VALIDATED spec's setup steps against a clone, as the admin/creator.
 * Interpolates each step's args from prior responses, executes it, asserts `{ok}`,
 * and STOPS on the first failure — a failed setup step is a spec error (surfaced
 * distinctly from "the agent broke"), not a demo. Assumes validateSpec() already
 * passed; this is the runtime half.
 */
export async function runScenarioSetup(spec: ScenarioSpec, opts: SetupOptions): Promise<SetupResult> {
  const steps: SetupStepResult[] = [];
  const ctx: InterpContext = {
    botUserId: opts.botUserId,
    adminUserId: opts.adminUserId,
    stepResponses: [],
  };

  for (let i = 0; i < spec.steps.length; i++) {
    const step = spec.steps[i]!;
    const n = i + 1;

    let args: Record<string, unknown>;
    try {
      args = resolveArgs(step.args ?? {}, ctx);
    } catch (e) {
      steps.push({ step: n, method: step.method, ok: false, error: (e as Error).message });
      return { ok: false, steps, responses: ctx.stepResponses, failedStep: n };
    }

    const res = await cloneCall(opts.baseUrl, step.method, opts.adminToken, args);
    steps.push({ step: n, method: step.method, ok: res.ok, error: res.error });
    if (!res.ok) return { ok: false, steps, responses: ctx.stepResponses, failedStep: n };
    ctx.stepResponses.push(res.body);
  }

  return { ok: true, steps, responses: ctx.stepResponses };
}
