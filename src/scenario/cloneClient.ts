// Minimal client for driving a clone's REST surface during scenario setup.
//
// Two clone shapes are supported through one call:
//   - Slack Web API style (default): POST `${baseUrl}/<method>`, args as a JSON
//     body, a `{ ok, error }` response envelope (HTTP 200 even on failure).
//   - REST style (e.g. Linear): an explicit verb + a templated path
//     (`issues/:id`), path params filled from args, remaining args as a JSON body
//     (POST/PATCH) or dropped (GET/DELETE), plain REST bodies + HTTP status.
//
// Success is normalized: 2xx AND no `ok:false`/`error` field. That rule is true
// for Slack's envelope and for REST bodies alike (which simply carry neither).

import type { HttpVerb } from './spec.js';

export interface CloneCallResult {
  ok: boolean;
  error?: string;
  body: Record<string, unknown>;
}

export interface CallTransport {
  verb?: HttpVerb;
  /** Path template relative to baseUrl; `:param` filled from (and consuming) args. */
  path?: string;
}

/** Fill `:param` segments from args; returns the path and the args not consumed. */
function buildPath(
  method: string,
  transport: CallTransport | undefined,
  args: Record<string, unknown>,
): { path: string; rest: Record<string, unknown> } {
  const template = transport?.path ?? method; // default: Slack flat method name
  const consumed = new Set<string>();
  const path = template.replace(/:([a-zA-Z0-9_]+)/g, (_m, name: string) => {
    if (!(name in args)) throw new Error(`path param :${name} has no matching arg`);
    consumed.add(name);
    return encodeURIComponent(String(args[name]));
  });
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!consumed.has(k)) rest[k] = v;
  return { path, rest };
}

export async function cloneCall(
  baseUrl: string,
  method: string,
  token: string | null,
  args: Record<string, unknown> = {},
  transport?: CallTransport,
): Promise<CloneCallResult> {
  const verb: HttpVerb = transport?.verb ?? 'POST';
  const { path, rest } = buildPath(method, transport, args);
  const sendsBody = verb === 'POST' || verb === 'PUT' || verb === 'PATCH';

  const res = await fetch(`${baseUrl}/${path}`, {
    method: verb,
    headers: {
      ...(sendsBody ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: sendsBody ? JSON.stringify(rest) : undefined,
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const notOk = body.ok === false || typeof body.error === 'string';
  const ok = res.ok && !notOk;
  const errText =
    typeof body.error === 'string'
      ? body.error
      : typeof body.message === 'string'
        ? body.message
        : ok
          ? undefined
          : `http_${res.status}`;
  return { ok, error: errText, body };
}
