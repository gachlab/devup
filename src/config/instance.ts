/** Naming a devup instance.
 *
 *  `--instance e2e` gives a second daemon for the same project its own socket,
 *  pid file, boot-error file and log directory — everything keyed by the
 *  project name — so an e2e run does not reach into the stack you are working
 *  in, and two CI jobs for the same repo do not fight over a socket.
 *
 *  **Ports are deliberately untouched.** Shifting them would have to reach the
 *  services themselves — a front end calling `localhost:3000` knows nothing
 *  about instances — so it is a change in every consuming app, not in devup.
 *  Two instances therefore cannot serve the same ports at once, and devup says
 *  so plainly rather than pretending otherwise. */

/** Everything the path helpers key on: the project, qualified by the instance.
 *
 *  Appended to the project name *before* sanitising, on purpose. The socket
 *  and log sanitisers are **not** the same function — the log one trims
 *  leading underscores and the socket one does not, so `@gachlab/web` lives in
 *  `logs/gachlab_web/` and answers on `sock-_gachlab_web.sock` — and that
 *  divergence is load-bearing for anything already running. Qualifying first
 *  leaves each rule to apply itself, untouched. */
export function qualifyInstance(projectName: string, instance?: string): string {
  return instance ? `${projectName}-${instance}` : projectName;
}

/** A name safe to put in a file name, and short enough to read.
 *
 *  Rejected rather than sanitised: an instance whose name is quietly rewritten
 *  is one whose socket you cannot find. The point of the flag is to know which
 *  daemon you are talking to. */
export function validateInstance(instance: string): string | null {
  if (!instance) return 'instance name cannot be empty';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(instance)) {
    return `invalid instance name: "${instance}" — letters, digits, dot, dash and underscore only, starting with a letter or digit`;
  }
  if (instance.length > 32) return `instance name is too long: "${instance}" (max 32)`;
  return null;
}

/** The instance part of a qualified name, given the project it belongs to.
 *
 *  `undefined` for the project's own default instance. Anchored on the known
 *  project name rather than cut at the last dash: a project called `my-app`
 *  would otherwise report its default instance as `app`, and the suggested
 *  `devup --instance app down` would be for a daemon that does not exist. */
export function instanceSuffix(qualifiedName: string, projectName: string): string | undefined {
  if (qualifiedName === projectName) return undefined;
  const prefix = `${projectName}-`;
  return qualifiedName.startsWith(prefix) ? qualifiedName.slice(prefix.length) : undefined;
}
