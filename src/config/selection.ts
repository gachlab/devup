import type { CliArgs } from './cli.js';
import { filterServices } from './cli.js';
import type { DevStackConfig, ServiceConfig } from './types.js';

/** The local services this run manages out of a config: the `--profile` /
 *  `--services` / `--only` / `--skip` selection, minus the services served
 *  from a remote environment.
 *
 *  A config reload has to diff *this*, not `config.services`: diffing the
 *  whole file started services the run had excluded the moment their entry
 *  was edited (`--skip worker`, then any change to `worker`), and started
 *  every service added to the file whatever the active profile said.
 *
 *  `remote` is the set classified as remote **at boot**, and it stays fixed
 *  for the run. Re-classifying on every reload let an edit to `proxy.routes`
 *  or `environments` drop a remote-served service from the selection — the
 *  reload then *removed* it and tore down its proxy — and let a newly added
 *  service the classification called remote start as a local process. Which
 *  services are remote is a boot-time decision; changing it takes a restart. */
export function managedServices(
  config: DevStackConfig,
  cliArgs: CliArgs,
  remote: ReadonlySet<string> = new Set(),
): ServiceConfig[] {
  return filterServices(config.services, cliArgs, config).filter(s => !remote.has(s.name));
}
