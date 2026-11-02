import type { CliArgs } from './cli.js';
import { filterServices } from './cli.js';
import type { DevStackConfig, ServiceConfig } from './types.js';
import { allHeldPorts, resolveRemote } from '../remote/classifier.js';

/** The services this run manages: the `--profile` / `--services` / `--only` /
 *  `--skip` selection, local and remote-served alike.
 *
 *  A config reload has to diff *this*, not `config.services`: diffing the
 *  whole file started services the run had excluded the moment their entry
 *  was edited (`--skip worker`, then any change to `worker`), and started
 *  every service added to the file whatever the active profile said. Throws
 *  like `resolveRemote` does when `--remote` no longer resolves. */
export function managedServices(config: DevStackConfig, cliArgs: CliArgs): ServiceConfig[] {
  const selected = filterServices(config.services, cliArgs, config);
  return allHeldPorts(selected, resolveRemote(config, selected, cliArgs.remote));
}
