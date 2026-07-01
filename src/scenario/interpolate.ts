// Runtime resolution of the interpolation grammar the validator (validate.ts)
// already gate-checked at authoring time. Tokens:
//   $bot   -> the provisioned bot user's id
//   $admin -> the admin/creator user's id
//   $N.dotted.path -> a value dug out of step N's ({ok}) response (1-based)
// Missing paths / out-of-range steps throw LOUDLY — a broken spec must surface as
// a setup error, never a silent undefined that corrupts a later step.

export interface InterpContext {
  botUserId: string;
  adminUserId: string;
  /** Prior step responses, 0-based; step N (1-based) is stepResponses[N-1]. */
  stepResponses: Record<string, unknown>[];
}

function digPath(obj: unknown, path: string, token: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') {
      throw new Error(`interpolation ${token}: path segment "${key}" is not reachable`);
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  if (cur === undefined) throw new Error(`interpolation ${token}: resolved to undefined`);
  return cur;
}

export function resolveValue(val: unknown, ctx: InterpContext): unknown {
  if (typeof val !== 'string' || !val.startsWith('$')) return val;
  if (val === '$bot') return ctx.botUserId;
  if (val === '$admin') return ctx.adminUserId;
  const m = /^\$(\d+)\.(.+)$/.exec(val);
  if (m) {
    const stepIdx = parseInt(m[1]!, 10) - 1;
    if (stepIdx < 0 || stepIdx >= ctx.stepResponses.length) {
      throw new Error(`interpolation ${val}: step ${m[1]} has no response yet`);
    }
    return digPath(ctx.stepResponses[stepIdx], m[2]!, val);
  }
  throw new Error(`unresolvable interpolation token: ${val}`);
}

export function resolveArgs(
  args: Record<string, unknown>,
  ctx: InterpContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, ctx);
  return out;
}

/**
 * Resolve interpolation tokens embedded in free text (the agent_task), so the
 * agent can be handed the id of a resource setup created — e.g. "Post to
 * $1.channel.id". Each matched token is replaced by its resolved value; a bad
 * token throws (loud), same as everywhere else.
 */
export function resolveText(text: string, ctx: InterpContext): string {
  return text.replace(
    /\$(?:bot|admin|\d+\.[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)/g,
    (tok) => {
      const v = resolveValue(tok, ctx);
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
  );
}
