// Minimal Slack-Web-API-style client for driving a clone's REST surface during
// scenario setup. Every method is POST `${baseUrl}/<method>` with a Bearer token;
// the clone returns HTTP 200 even on failure with a `{ ok:false, error }` body, so
// success is "2xx AND no error field", not the status alone.

export interface CloneCallResult {
  ok: boolean;
  error?: string;
  body: Record<string, unknown>;
}

export async function cloneCall(
  baseUrl: string,
  method: string,
  token: string | null,
  payload: Record<string, unknown> = {},
): Promise<CloneCallResult> {
  const res = await fetch(`${baseUrl}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const notOk = body.ok === false || typeof body.error === 'string';
  const ok = res.ok && !notOk;
  return {
    ok,
    error: typeof body.error === 'string' ? body.error : ok ? undefined : `http_${res.status}`,
    body,
  };
}
