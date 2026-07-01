import {
  type AllowList,
  type ScenarioSpec,
  INTERP_TOKEN,
  MAX_STEPS,
  MAX_TASK_CHARS,
} from './spec.js';

export interface ValidationError {
  /** 1-based step index, when the error is step-scoped. */
  step?: number;
  field?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

/**
 * Validate a scenario spec against a clone's allow-list. This is the security
 * boundary for anonymous paste-your-own authoring: a spec that fails here is a
 * user spec error (rendered distinctly from "the agent broke"), and it never
 * reaches a clone. The closed clone re-validates server-side as defense in depth.
 */
export function validateSpec(spec: ScenarioSpec, allow: AllowList): ValidationResult {
  const errors: ValidationError[] = [];

  if (!spec || typeof spec !== 'object') return { ok: false, errors: [{ message: 'spec must be an object' }] };
  if (!spec.id) errors.push({ message: 'id is required' });
  if (!spec.clone) errors.push({ message: 'clone is required' });
  if (!spec.agent_task) errors.push({ message: 'agent_task is required' });
  else if (spec.agent_task.length > MAX_TASK_CHARS)
    errors.push({ message: `agent_task too long (max ${MAX_TASK_CHARS} chars)` });

  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    errors.push({ message: 'at least one step is required' });
    return { ok: false, errors };
  }
  if (spec.steps.length > MAX_STEPS)
    errors.push({ message: `too many steps (max ${MAX_STEPS})` });

  spec.steps.forEach((step, i) => {
    const n = i + 1;
    const method = allow[step.method];
    if (!method) {
      errors.push({ step: n, message: `method not allowed: ${step.method}` });
      return;
    }
    const args = step.args ?? {};
    // required args present
    for (const [arg, schema] of Object.entries(method.args)) {
      if (schema.required && !(arg in args))
        errors.push({ step: n, field: arg, message: `missing required arg: ${arg}` });
    }
    // no unknown args; string args that look like tokens must be valid tokens
    for (const [arg, val] of Object.entries(args)) {
      if (!(arg in method.args)) {
        errors.push({ step: n, field: arg, message: `unknown arg: ${arg}` });
        continue;
      }
      const schema = method.args[arg]!;
      if (typeof val === 'string' && val.startsWith('$') && !INTERP_TOKEN.test(val)) {
        errors.push({ step: n, field: arg, message: `bad interpolation token: ${val}` });
      }
      if (schema.type === 'boolean' && typeof val !== 'boolean')
        errors.push({ step: n, field: arg, message: `${arg} must be a boolean` });
    }
  });

  return { ok: errors.length === 0, errors };
}
