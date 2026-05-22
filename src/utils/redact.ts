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
