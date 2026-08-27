/** Returns the env record with values redacted to *** for keys that look
 *  secret-ish (token / password / secret / key / auth). Case-insensitive. */
export function redactSecrets(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = /secret|token|password|api[_-]?key|auth/i.test(k) ? '***' : v;
  }
  return out;
}

/** The keys treated as secret-ish, shared so a value is not scrubbed in one
 *  place and printed in another. */
export const SECRET_KEY_RE = /secret|token|password|api[_-]?key|auth/i;

/** A request path with the values of secret-looking query parameters replaced.
 *
 *  A remote service writes no stdout of its own, so devup's request line is
 *  the only log it has — which puts every `?access_token=…` and OAuth `?code=…`
 *  that goes through the proxy on a path to `~/.devup/logs`. The parameter
 *  *names* are kept: knowing a token was present is what makes the line worth
 *  reading. */
export function redactUrl(path: string): string {
  const q = path.indexOf('?');
  if (q < 0) return path;

  const params = new URLSearchParams(path.slice(q + 1));
  let touched = false;
  for (const key of [...params.keys()]) {
    if (!SECRET_KEY_RE.test(key) && key.toLowerCase() !== 'code') continue;
    params.set(key, '***');
    touched = true;
  }
  if (!touched) return path;
  // `URLSearchParams` percent-encodes on the way out, which would turn a path
  // that was only being *read* into one that no longer matches what was sent.
  // The asterisks are ours, so decoding them back is safe and keeps the line
  // comparable with the upstream's own access log.
  return `${path.slice(0, q)}?${params.toString().replace(/%2A%2A%2A/gi, '***')}`;
}
