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
  return instance ? `${projectName}${INSTANCE_SEPARATOR}${instance}` : projectName;
}

/** Doubled on purpose. A single dash makes project `foo-bar` and project `foo`
 *  with `--instance bar` produce the same socket, pid file and log directory —
 *  two unrelated projects silently sharing state, where `devup down` in one
 *  stops the other. A single dash is legal in both project and instance names,
 *  so the collision needs a project literally called `foo--a-b` to come back. */
const INSTANCE_SEPARATOR = '--';

/** A name safe to put in a file name, and short enough to read.
 *
 *  Rejected rather than sanitised: an instance whose name is quietly rewritten
 *  is one whose socket you cannot find. The point of the flag is to know which
 *  daemon you are talking to. */
export function validateInstance(instance: string): string | null {
  if (!instance) return '--instance needs a name';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(instance)) {
    return `invalid instance name: "${instance}" — letters, digits, dot, dash and underscore only, starting with a letter or digit`;
  }
  if (instance.length > 32) return `instance name is too long: "${instance}" (max 32)`;
  return null;
}

/** The ` --instance x` to append to a command in a message, or `''`.
 *
 *  Every hint devup prints has to carry it. `devup up -d --instance e2e` used
 *  to answer "stop: devup down", and that command stops the **main** stack and
 *  leaves the e2e one running — the opposite of what it says. */
export function instanceFlag(instance?: string): string {
  return instance ? ` --instance ${instance}` : '';
}

/** How to name the stack in a message: the project as configured, plus which
 *  instance. Never the qualified name — that is a path key, and reads as a
 *  project nobody has. */
export function describeStack(projectName: string, instance?: string): string {
  return instance ? `${projectName} (instance "${instance}")` : projectName;
}
